import type { PDFDocumentProxy } from './pdf/engine';
import type { Rect } from './types';

/** Détection locale des données personnelles, pour les caviarder. */
export type PiiKind = 'email' | 'phone' | 'iban' | 'card' | 'nir' | 'siret' | 'ip' | 'address' | 'date' | 'name';

export const PII_LABELS: Record<PiiKind, string> = {
  email: 'E-mails',
  phone: 'Téléphones',
  iban: 'IBAN',
  card: 'Cartes bancaires',
  nir: 'N° de sécurité sociale',
  siret: 'SIREN / SIRET',
  ip: 'Adresses IP',
  address: 'Adresses postales',
  date: 'Dates',
  name: 'Noms de personnes',
};

export interface PiiHit {
  id: string;
  kind: PiiKind;
  text: string;
  page: number;
  rects: Rect[];
}

const luhn = (digits: string) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = +digits[i];
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

const ibanValid = (raw: string) => {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const ch of r) m = (m * 10 + +ch) % 97;
  return m === 1;
};

const nirValid = (raw: string) => {
  const s = raw.replace(/\s/g, '').toUpperCase().replace('2A', '19').replace('2B', '18');
  if (s.length !== 15) return false;
  const n = BigInt(s.slice(0, 13));
  return 97n - (n % 97n) === BigInt(s.slice(13));
};

const PATTERNS: { kind: PiiKind; re: RegExp; check?: (m: string) => boolean }[] = [
  { kind: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, check: ibanValid },
  { kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); } },
  { kind: 'nir', re: /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2]|[2-9]\d)\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}\s?\d{2}\b/gi, check: nirValid },
  { kind: 'siret', re: /\b\d{3}\s?\d{3}\s?\d{3}(?:\s?\d{5})?\b/g, check: (m) => { const d = m.replace(/\D/g, ''); return (d.length === 9 || d.length === 14) && luhn(d); } },
  { kind: 'phone', re: /(?:(?:\+|00)\d{1,3}[\s.-]?(?:\(0\)\s?)?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b|\+\d{1,3}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g },
  { kind: 'ip', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    kind: 'address',
    re: /\b\d{1,4}\s?(?:bis|ter)?,?\s+(?:rue|avenue|av\.|boulevard|bd|chemin|allée|place|impasse|route|quai|cours|square|lotissement|résidence|street|st\.|road|rd\.)\s+[^\n,]{2,40}(?:,?\s*\d{5}\s+[A-ZÀ-Ý][\wÀ-ÿ' -]{1,30})?/gi,
  },
  { kind: 'date', re: /\b(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}\b/g },
  { kind: 'name', re: /\b(?:M\.|Mme|Mlle|Monsieur|Madame|Mademoiselle|Me|Maître|Dr|Docteur|Pr)\s+(?:[A-ZÀ-Ý][a-zà-ÿ'-]+\s+)?[A-ZÀ-Ý][A-ZÀ-Ýa-zà-ÿ'-]+(?:\s+[A-ZÀ-Ý]{2,}[A-ZÀ-Ý'-]*)?/g },
];

interface PageMap {
  text: string;
  /** pour chaque caractère : index de l'élément de texte et position dans celui-ci */
  map: { item: number; off: number }[];
  items: { str: string; x: number; y: number; w: number; h: number }[];
}

async function pageMap(doc: PDFDocumentProxy, page: number): Promise<{ pm: PageMap; conv: (x: number, y: number) => number[] }> {
  const pg = await doc.getPage(page + 1);
  const vp = pg.getViewport({ scale: 1 });
  const tc = await pg.getTextContent();
  const pm: PageMap = { text: '', map: [], items: [] };
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const t = it.transform as number[];
    const idx = pm.items.length;
    pm.items.push({ str: it.str, x: t[4], y: t[5], w: it.width, h: Math.hypot(t[2], t[3]) || it.height });
    for (let k = 0; k < it.str.length; k++) {
      pm.text += it.str[k];
      pm.map.push({ item: idx, off: k });
    }
    pm.text += it.hasEOL ? '\n' : ' ';
    pm.map.push({ item: -1, off: 0 });
  }
  return { pm, conv: (x, y) => vp.convertToViewportPoint(x, y) };
}

function locate(pm: PageMap, conv: (x: number, y: number) => number[], start: number, end: number): Rect[] {
  const byItem = new Map<number, [number, number]>();
  for (let i = start; i < end; i++) {
    const m = pm.map[i];
    if (!m || m.item < 0) continue;
    const r = byItem.get(m.item);
    byItem.set(m.item, r ? [r[0], m.off + 1] : [m.off, m.off + 1]);
  }
  const rects: Rect[] = [];
  for (const [i, [a, b]] of byItem) {
    const it = pm.items[i];
    const len = Math.max(1, it.str.length);
    const x0 = it.x + (it.w * a) / len;
    const x1 = it.x + (it.w * b) / len;
    const [vx0, vy0] = conv(x0, it.y - it.h * 0.25);
    const [vx1, vy1] = conv(x1, it.y + it.h * 0.95);
    rects.push({ x: Math.min(vx0, vx1) - 1, y: Math.min(vy0, vy1) - 1, w: Math.abs(vx1 - vx0) + 2, h: Math.abs(vy1 - vy0) + 2 });
  }
  return rects;
}

let n = 0;

/** Analyse tout le document. `extraTerms` : termes supplémentaires (noms trouvés par l'IA, mots saisis). */
export async function detectPii(
  doc: PDFDocumentProxy,
  kinds: Set<PiiKind>,
  extraTerms: string[] = [],
  onProgress?: (page: number) => void,
): Promise<PiiHit[]> {
  const hits: PiiHit[] = [];
  for (let page = 0; page < doc.numPages; page++) {
    onProgress?.(page);
    const { pm, conv } = await pageMap(doc, page);
    const taken: [number, number][] = [];
    const add = (kind: PiiKind, s: number, e: number) => {
      if (taken.some(([a, b]) => s < b && e > a)) return;
      taken.push([s, e]);
      const rects = locate(pm, conv, s, e);
      if (rects.length) hits.push({ id: `pii${n++}`, kind, text: pm.text.slice(s, e).trim(), page, rects });
    };
    for (const { kind, re, check } of PATTERNS) {
      if (!kinds.has(kind)) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(pm.text))) if (!check || check(m[0])) add(kind, m.index, m.index + m[0].trimEnd().length);
    }
    const lower = pm.text.toLowerCase();
    for (const term of extraTerms) {
      const t = term.trim().toLowerCase();
      if (t.length < 2) continue;
      let i = lower.indexOf(t);
      while (i >= 0) {
        add('name', i, i + t.length);
        i = lower.indexOf(t, i + t.length);
      }
    }
  }
  return hits;
}
