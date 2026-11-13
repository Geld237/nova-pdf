import { saveFile } from '../platform';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { hexToRgb, sanitize } from './writer';

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { ignoreEncryption: true });

/**
 * Réorganise les pages : `order` contient les index d'origine, dans le nouvel ordre
 * (-1 = page blanche). Le document est modifié sur place pour conserver
 * formulaires, signets et métadonnées.
 */
export async function reorderPages(
  bytes: Uint8Array,
  order: { src: number; rotate: number }[],
): Promise<Uint8Array> {
  const pdf = await load(bytes);
  const pages = pdf.getPages();
  for (let i = pages.length - 1; i >= 0; i--) pdf.removePage(i);
  const used = new Set<number>();
  for (const o of order) {
    if (o.src < 0) {
      const n = pdf.getPageCount();
      const prev = n ? pdf.getPage(n - 1).getSize() : { width: 595, height: 842 };
      pdf.addPage([prev.width, prev.height]);
      continue;
    }
    let p = pages[o.src];
    if (used.has(o.src)) [p] = await pdf.copyPages(pdf, [o.src]);
    used.add(o.src);
    pdf.addPage(p);
    if (o.rotate) p.setRotation(degrees((p.getRotation().angle + o.rotate + 360) % 360));
  }
  return pdf.save();
}

export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

export async function mergePdfs(files: Uint8Array[]): Promise<Uint8Array> {
  // Le premier document sert de base : ses formulaires et propriétés sont conservés.
  const out = await load(files[0]);
  for (const f of files.slice(1)) {
    const src = await load(f);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/** « 1-3, 5, 8-10 » → [[0,1,2],[4],[7,8,9]] */
export function parseRanges(input: string, max: number): number[][] {
  return input
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [a, b] = part.split('-').map((n) => parseInt(n.trim(), 10));
      const start = Math.max(1, a || 1);
      const end = Math.min(max, b === undefined || isNaN(b) ? start : b);
      const r: number[] = [];
      for (let i = start; i <= end; i++) r.push(i - 1);
      return r;
    })
    .filter((r) => r.length);
}

export async function splitPdf(bytes: Uint8Array, groups: number[][]): Promise<Uint8Array[]> {
  return Promise.all(groups.map((g) => extractPages(bytes, g)));
}

export async function addWatermark(
  bytes: Uint8Array,
  text: string,
  opts: { color: string; opacity: number; size: number },
): Promise<Uint8Array> {
  const pdf = await load(bytes);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const t = sanitize(font, text);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const w = font.widthOfTextAtSize(t, opts.size);
    const ang = Math.atan2(height, width);
    page.drawText(t, {
      x: width / 2 - (Math.cos(ang) * w) / 2,
      y: height / 2 - (Math.sin(ang) * w) / 2,
      size: opts.size,
      font,
      color: hexToRgb(opts.color),
      opacity: opts.opacity,
      rotate: degrees((ang * 180) / Math.PI),
    });
  }
  return pdf.save();
}

export async function addPageNumbers(
  bytes: Uint8Array,
  opts: { format: string; position: 'bottom-center' | 'bottom-right' | 'top-right'; size: number; start: number },
): Promise<Uint8Array> {
  const pdf = await load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const total = pdf.getPageCount();
  pdf.getPages().forEach((page, i) => {
    const { width, height } = page.getSize();
    const label = opts.format.replace('{n}', String(i + opts.start)).replace('{total}', String(total + opts.start - 1));
    const w = font.widthOfTextAtSize(label, opts.size);
    const m = 24;
    const x = opts.position === 'bottom-center' ? (width - w) / 2 : width - w - m;
    const y = opts.position === 'top-right' ? height - m - opts.size : m;
    page.drawText(label, { x, y, size: opts.size, font, color: rgb(0.2, 0.2, 0.2) });
  });
  return pdf.save();
}

export interface Meta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

export async function readMeta(bytes: Uint8Array): Promise<Meta> {
  const pdf = await load(bytes);
  return {
    title: pdf.getTitle() ?? '',
    author: pdf.getAuthor() ?? '',
    subject: pdf.getSubject() ?? '',
    keywords: pdf.getKeywords() ?? '',
  };
}

export async function writeMeta(bytes: Uint8Array, m: Meta): Promise<Uint8Array> {
  const pdf = await load(bytes);
  pdf.setTitle(m.title);
  pdf.setAuthor(m.author);
  pdf.setSubject(m.subject);
  pdf.setKeywords(m.keywords.split(',').map((k) => k.trim()).filter(Boolean));
  pdf.setModificationDate(new Date());
  return pdf.save();
}

/** Supprime les métadonnées (confidentialité). */
export async function stripMeta(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await load(bytes);
  pdf.setTitle('');
  pdf.setAuthor('');
  pdf.setSubject('');
  pdf.setKeywords([]);
  pdf.setCreator('');
  pdf.setProducer('');
  return pdf.save();
}

/** Crée un PDF à partir d'images (JPG / PNG), une image par page. */
export async function imagesToPdf(files: File[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    const img = f.type === 'image/png' ? await pdf.embedPng(data) : await pdf.embedJpg(data);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return pdf.save();
}

/** Ré-enregistre avec flux d'objets (gain de taille modéré, sans perte). */
export async function optimize(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await load(bytes);
  return pdf.save({ useObjectStreams: true });
}

/** Comparaison ligne à ligne (LCS) entre deux textes. */
export function diffLines(a: string, b: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const A = a.split('\n').map((s) => s.trim()).filter(Boolean);
  const B = b.split('\n').map((s) => s.trim()).filter(Boolean);
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) {
    return [{ type: 'del', text: '(documents trop longs pour une comparaison détaillée)' }];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: A[i++] });
    else out.push({ type: 'add', text: B[j++] });
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

export function download(data: Uint8Array | Blob | string, name: string, type = 'application/pdf') {
  void saveFile(data, name, type);
}

export function baseName(name: string) {
  return name.replace(/\.pdf$/i, '');
}
