import { PDFArray, PDFName, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument, type PDFPage } from 'pdf-lib';

/**
 * Suppression réelle de texte dans le flux de contenu d'une page :
 * les opérateurs d'affichage de texte (Tj, TJ, ', ") dont le point de départ
 * tombe dans l'une des zones sont retirés. Le texte disparaît vraiment du fichier
 * (il n'est plus sélectionnable ni trouvable par la recherche).
 */
type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

interface Tok {
  type: 'num' | 'op' | 'other';
  value: string;
  start: number;
  end: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

function tokenize(src: Uint8Array): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const str = (a: number, b: number) => String.fromCharCode(...src.subarray(a, Math.min(b, a + 64)));
  while (i < n) {
    const c = src[i];
    if (WS.has(c)) { i++; continue; }
    const start = i;
    if (c === 0x25) { while (i < n && src[i] !== 0x0a && src[i] !== 0x0d) i++; continue; } // commentaire
    if (c === 0x28) { // chaîne (…)
      let depth = 0;
      for (; i < n; i++) {
        if (src[i] === 0x5c) { i++; continue; }
        if (src[i] === 0x28) depth++;
        else if (src[i] === 0x29 && --depth === 0) { i++; break; }
      }
      toks.push({ type: 'other', value: '()', start, end: i });
      continue;
    }
    if (c === 0x3c && src[i + 1] === 0x3c) { i += 2; toks.push({ type: 'other', value: '<<', start, end: i }); continue; }
    if (c === 0x3e && src[i + 1] === 0x3e) { i += 2; toks.push({ type: 'other', value: '>>', start, end: i }); continue; }
    if (c === 0x3c) { while (i < n && src[i] !== 0x3e) i++; i++; toks.push({ type: 'other', value: '<>', start, end: i }); continue; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; toks.push({ type: 'other', value: String.fromCharCode(c), start, end: i }); continue; }
    if (c === 0x2f) { i++; while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i++; toks.push({ type: 'other', value: str(start, i), start, end: i }); continue; }
    while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
    if (i === start) { i++; continue; }
    const v = str(start, i);
    const isNum = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v);
    toks.push({ type: isNum ? 'num' : 'op', value: v, start, end: i });
    if (v === 'ID') { // image en ligne : on saute les données binaires jusqu'à EI
      while (i < n - 2 && !(WS.has(src[i]) && src[i + 1] === 0x45 && src[i + 2] === 0x49 && (i + 3 >= n || WS.has(src[i + 3])))) i++;
      i += 3;
    }
  }
  return toks;
}

interface Zone { x0: number; y0: number; x1: number; y1: number }

/** Renvoie le nouveau contenu et le nombre d'opérateurs retirés. */
function strip(src: Uint8Array, zones: Zone[]): { out: Uint8Array; removed: number } {
  const toks = tokenize(src);
  const cut: [number, number][] = [];
  let ctm: Mat = [...I] as Mat;
  const stack: Mat[] = [];
  let tm: Mat = [...I] as Mat;
  let tlm: Mat = [...I] as Mat;
  let leading = 0;
  let rise = 0;
  let operands: Tok[] = [];
  const num = (k: number) => parseFloat(operands[operands.length - k]?.value ?? '0');
  const inside = () => {
    const m = mul(tm, ctm);
    const x = m[4] + m[2] * rise;
    const y = m[5] + m[3] * rise;
    return zones.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
  };
  const nextLine = () => {
    tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
    tm = [...tlm] as Mat;
  };
  for (const t of toks) {
    if (t.type !== 'op') { operands.push(t); continue; }
    const op = t.value;
    const from = operands.length ? operands[0].start : t.start;
    switch (op) {
      case 'q': stack.push([...ctm] as Mat); break;
      case 'Q': ctm = stack.pop() ?? ([...I] as Mat); break;
      case 'cm': ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
      case 'BT': tm = [...I] as Mat; tlm = [...I] as Mat; break;
      case 'Tm': tm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tlm = [...tm] as Mat; break;
      case 'Td': tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = [...tlm] as Mat; break;
      case 'TD': leading = -num(1); tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); tm = [...tlm] as Mat; break;
      case 'TL': leading = num(1); break;
      case 'Ts': rise = num(1); break;
      case 'T*': nextLine(); break;
      case "'": case '"':
        nextLine();
        if (inside()) cut.push([from, t.end]);
        break;
      case 'Tj': case 'TJ':
        if (inside()) cut.push([from, t.end]);
        break;
    }
    operands = [];
  }
  if (!cut.length) return { out: src, removed: 0 };
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const [a, b] of cut) {
    parts.push(src.subarray(pos, a));
    pos = b;
  }
  parts.push(src.subarray(pos));
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x20;
  }
  return { out, removed: cut.length };
}

function streamBytes(pdf: PDFDocument, ref: unknown): Uint8Array | null {
  const obj = ref instanceof PDFRef ? pdf.context.lookup(ref) : ref;
  if (obj instanceof PDFRawStream) return decodePDFRawStream(obj).decode();
  return null;
}

/** Retire le texte situé dans les zones (coordonnées PDF de la page). Renvoie le nombre de passages retirés. */
export function removeTextInZones(pdf: PDFDocument, page: PDFPage, zones: Zone[]): number {
  const contents = page.node.get(PDFName.of('Contents'));
  if (!contents) return 0;
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const chunks: Uint8Array[] = [];
  for (const r of refs) {
    const b = streamBytes(pdf, r);
    if (!b) return 0; // flux non pris en charge : on ne touche à rien
    chunks.push(b, new Uint8Array([0x0a]));
  }
  const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const { out, removed } = strip(all, zones);
  if (!removed) return 0;
  const stream = pdf.context.flateStream(out);
  page.node.set(PDFName.of('Contents'), pdf.context.register(stream));
  return removed;
}
