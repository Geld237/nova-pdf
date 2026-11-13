import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, StandardFonts, rgb } from 'pdf-lib';
import { canvasToBlob, renderPageToCanvas, type PDFDocumentProxy } from './engine';
import { sanitize } from './writer';
import type { PageText } from '../types';

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { ignoreEncryption: true });
const MM = 72 / 25.4;

export const PAGE_SIZES: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};

/** Compression forte : chaque page est rastérisée en JPEG (texte non sélectionnable). */
export async function compressRaster(
  doc: PDFDocumentProxy,
  dpi: number,
  quality: number,
  onProgress?: (i: number, n: number) => void,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < doc.numPages; i++) {
    onProgress?.(i, doc.numPages);
    const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    const c = await renderPageToCanvas(doc, i, dpi / 72);
    const jpg = new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', quality)).arrayBuffer());
    const img = await out.embedJpg(jpg);
    const page = out.addPage([vp.width, vp.height]);
    page.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
  }
  return out.save();
}

/** Recadrage : marges en millimètres retirées de chaque page sélectionnée. */
export async function cropPages(
  bytes: Uint8Array,
  m: { top: number; right: number; bottom: number; left: number },
  pages: number[] | 'all',
): Promise<Uint8Array> {
  const pdf = await load(bytes);
  pdf.getPages().forEach((p, i) => {
    if (pages !== 'all' && !pages.includes(i)) return;
    const b = p.getCropBox();
    p.setCropBox(
      b.x + m.left * MM,
      b.y + m.bottom * MM,
      Math.max(10, b.width - (m.left + m.right) * MM),
      Math.max(10, b.height - (m.top + m.bottom) * MM),
    );
  });
  return pdf.save();
}

/** Plusieurs pages par feuille (2, 4, 6 ou 9). */
export async function nUp(bytes: Uint8Array, perSheet: 2 | 4 | 6 | 9, size = 'A4'): Promise<Uint8Array> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const [cols, rows] = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3] }[perSheet];
  let [W, H] = PAGE_SIZES[size] ?? PAGE_SIZES.A4;
  if (cols > rows) [W, H] = [H, W]; // paysage pour 2 et 6
  const embedded = await out.embedPdf(src, src.getPageIndices());
  const margin = 18;
  const cw = (W - margin * 2) / cols;
  const ch = (H - margin * 2) / rows;
  for (let i = 0; i < embedded.length; i += perSheet) {
    const sheet = out.addPage([W, H]);
    for (let k = 0; k < perSheet && i + k < embedded.length; k++) {
      const e = embedded[i + k];
      const s = Math.min((cw - 8) / e.width, (ch - 8) / e.height);
      const col = k % cols;
      const row = Math.floor(k / cols);
      const x = margin + col * cw + (cw - e.width * s) / 2;
      const y = H - margin - (row + 1) * ch + (ch - e.height * s) / 2;
      sheet.drawPage(e, { x, y, xScale: s, yScale: s });
      sheet.drawRectangle({ x: x - 0.5, y: y - 0.5, width: e.width * s + 1, height: e.height * s + 1, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 });
    }
  }
  return out.save();
}

/** Change le format de toutes les pages (le contenu est mis à l'échelle et centré). */
export async function resizePages(bytes: Uint8Array, size: string): Promise<Uint8Array> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const embedded = await out.embedPdf(src, src.getPageIndices());
  for (const e of embedded) {
    let [W, H] = PAGE_SIZES[size];
    if (e.width > e.height) [W, H] = [H, W];
    const s = Math.min(W / e.width, H / e.height);
    const page = out.addPage([W, H]);
    page.drawPage(e, { x: (W - e.width * s) / 2, y: (H - e.height * s) / 2, xScale: s, yScale: s });
  }
  return out.save();
}

/** Réparation : relecture tolérante, puis reconstruction par rastérisation en dernier recours. */
export async function repairPdf(bytes: Uint8Array, doc: PDFDocumentProxy | null): Promise<{ bytes: Uint8Array; method: string }> {
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
    pdf.getPages();
    return { bytes: await pdf.save(), method: 'structure reconstruite' };
  } catch {
    if (!doc) throw new Error('Fichier illisible');
    return { bytes: await compressRaster(doc, 150, 0.9), method: 'pages reconstruites en images' };
  }
}

/** Remplace les signets du document (un niveau). */
export async function setBookmarks(bytes: Uint8Array, items: { title: string; page: number }[]): Promise<Uint8Array> {
  const pdf = await load(bytes);
  const ctx = pdf.context;
  if (!items.length) {
    pdf.catalog.delete(PDFName.of('Outlines'));
    return pdf.save();
  }
  const pages = pdf.getPages();
  const rootRef = ctx.nextRef();
  const refs = items.map(() => ctx.nextRef());
  items.forEach((it, i) => {
    const page = pages[Math.min(Math.max(0, it.page), pages.length - 1)];
    const dict = ctx.obj({
      Title: PDFHexString.fromText(it.title),
      Parent: rootRef,
      Dest: ctx.obj([page.ref, PDFName.of('XYZ'), null, null, null]),
    }) as PDFDict;
    if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
    ctx.assign(refs[i], dict);
  });
  ctx.assign(
    rootRef,
    ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: PDFNumber.of(items.length) }),
  );
  pdf.catalog.set(PDFName.of('Outlines'), rootRef);
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  return pdf.save();
}

/** Extrait les images JPEG intégrées (les autres formats sont comptés). */
export async function extractImages(bytes: Uint8Array): Promise<{ jpegs: Uint8Array[]; others: number }> {
  const pdf = await load(bytes);
  const jpegs: Uint8Array[] = [];
  let others = 0;
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const filter = d.get(PDFName.of('Filter'));
    const isJpeg = filter === PDFName.of('DCTDecode') || String(filter).includes('DCTDecode');
    if (isJpeg && !String(filter).includes('Flate')) jpegs.push(obj.contents);
    else others++;
  }
  return { jpegs, others };
}

/** Joint un fichier au PDF (pièce jointe). */
export async function attachFile(bytes: Uint8Array, file: File, description: string): Promise<Uint8Array> {
  const pdf = await load(bytes);
  await pdf.attach(new Uint8Array(await file.arrayBuffer()), file.name, {
    mimeType: file.type || 'application/octet-stream',
    description,
    creationDate: new Date(file.lastModified),
    modificationDate: new Date(),
  });
  return pdf.save();
}

export interface ViewerPrefs {
  pageLayout: 'SinglePage' | 'OneColumn' | 'TwoColumnLeft' | 'TwoPageLeft';
  pageMode: 'UseNone' | 'UseOutlines' | 'UseThumbs' | 'FullScreen';
  displayDocTitle: boolean;
  hideToolbar: boolean;
  fitWindow: boolean;
}

export async function setViewerPrefs(bytes: Uint8Array, v: ViewerPrefs): Promise<Uint8Array> {
  const pdf = await load(bytes);
  pdf.catalog.set(PDFName.of('PageLayout'), PDFName.of(v.pageLayout));
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of(v.pageMode));
  const vp = pdf.catalog.getOrCreateViewerPreferences();
  vp.setDisplayDocTitle(v.displayDocTitle);
  vp.setHideToolbar(v.hideToolbar);
  vp.setFitWindow(v.fitWindow);
  return pdf.save();
}

export async function blankPdf(count: number, size: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i++) pdf.addPage(PAGE_SIZES[size] ?? PAGE_SIZES.A4);
  return pdf.save();
}

/** Texte brut → PDF (A4, mise en page automatique). */
export async function textToPdf(text: string, title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const [W, H] = PAGE_SIZES.A4;
  const size = 11;
  const lh = size * 1.45;
  const margin = 56;
  const maxW = W - margin * 2;
  const lines: string[] = [];
  for (const para of sanitize(font, text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(t, size) > maxW && line) {
        lines.push(line);
        line = word;
      } else line = t;
    }
    lines.push(line);
  }
  let page = pdf.addPage([W, H]);
  let y = H - margin;
  for (const l of lines) {
    if (y < margin) {
      page = pdf.addPage([W, H]);
      y = H - margin;
    }
    page.drawText(l, { x: margin, y, size, font });
    y -= lh;
  }
  return pdf.save();
}

export async function toDocx(texts: PageText[], title: string): Promise<Blob> {
  const { Document, Packer, Paragraph, HeadingLevel, PageBreak, TextRun } = await import('docx');
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  texts.forEach((t, i) => {
    if (i > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    for (const para of t.text.split(/\n(?=[A-ZÀ-Ý0-9•\-–])/)) {
      const clean = para.replace(/-\n(\w)/g, '$1').replace(/\n/g, ' ').trim();
      if (clean) children.push(new Paragraph({ children: [new TextRun(clean)] }));
    }
  });
  return Packer.toBlob(new Document({ creator: 'Nova PDF', title, sections: [{ children }] }));
}

export function toHtml(texts: PageText[], title: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const body = texts
    .map(
      (t) =>
        `<section id="page-${t.page + 1}"><h2>Page ${t.page + 1}</h2>${t.text
          .split(/\n{2,}|\n(?=[A-ZÀ-Ý0-9•\-–])/)
          .map((p) => `<p>${esc(p.replace(/\n/g, ' '))}</p>`)
          .join('')}</section>`,
    )
    .join('\n');
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.6 Georgia,serif;max-width:46rem;margin:2rem auto;padding:0 1rem}h2{font:600 13px system-ui;color:#888}</style><h1>${esc(title)}</h1>${body}</html>`;
}

