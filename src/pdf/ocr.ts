import { PDFDocument, StandardFonts } from 'pdf-lib';
import { renderPageToCanvas, type PDFDocumentProxy } from './engine';
import { sanitize } from './writer';

export interface OcrWord {
  text: string;
  x: number; // coordonnées viewport échelle 1
  y: number;
  w: number;
  h: number;
}

export interface OcrPage {
  page: number;
  text: string;
  words: OcrWord[];
}

/**
 * OCR local (tesseract.js, WebAssembly). Les données de langue sont
 * téléchargées une seule fois puis mises en cache par le navigateur.
 */
export async function ocrPages(
  doc: PDFDocumentProxy,
  pages: number[],
  lang: string,
  onProgress: (msg: string, ratio: number) => void,
): Promise<OcrPage[]> {
  const { createWorker } = await import('tesseract.js');
  let current = 0;
  const worker = await createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text')
        onProgress(`Page ${pages[current] + 1} : reconnaissance…`, (current + m.progress) / pages.length);
      else onProgress(m.status, current / pages.length);
    },
  });
  const scale = 2.5;
  const out: OcrPage[] = [];
  try {
    for (current = 0; current < pages.length; current++) {
      const canvas = await renderPageToCanvas(doc, pages[current], scale);
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      const words: OcrWord[] = [];
      for (const b of data.blocks ?? [])
        for (const p of b.paragraphs)
          for (const l of p.lines)
            for (const w of l.words)
              if (w.text.trim())
                words.push({
                  text: w.text,
                  x: w.bbox.x0 / scale,
                  y: w.bbox.y0 / scale,
                  w: (w.bbox.x1 - w.bbox.x0) / scale,
                  h: (w.bbox.y1 - w.bbox.y0) / scale,
                });
      out.push({ page: pages[current], text: data.text, words });
    }
  } finally {
    await worker.terminate();
  }
  onProgress('Terminé', 1);
  return out;
}

/** Ajoute une couche de texte invisible : le scan devient cherchable et copiable. */
export async function makeSearchable(
  bytes: Uint8Array,
  doc: PDFDocumentProxy,
  results: OcrPage[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const r of results) {
    const page = pdf.getPage(r.page);
    const vp = (await doc.getPage(r.page + 1)).getViewport({ scale: 1 });
    for (const w of r.words) {
      const [x, y] = vp.convertToPdfPoint(w.x, w.y + w.h) as [number, number];
      const text = sanitize(font, w.text);
      const size = Math.max(4, w.h * 0.9);
      page.drawText(text, { x, y, size, font, opacity: 0 });
    }
  }
  return pdf.save();
}
