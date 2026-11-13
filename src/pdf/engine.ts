import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { OutlineItem, PageText } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy };

/** Ouvre un PDF à partir d'octets. Demande un mot de passe si nécessaire. */
export async function openPdf(
  bytes: Uint8Array,
  askPassword: (retry: boolean) => string | null,
): Promise<PDFDocumentProxy> {
  return (await openPdfWithPassword(bytes, askPassword)).doc;
}

/** Comme openPdf, mais renvoie aussi le mot de passe saisi (pour déchiffrer ensuite). */
export async function openPdfWithPassword(
  bytes: Uint8Array,
  askPassword: (retry: boolean) => string | null,
): Promise<{ doc: PDFDocumentProxy; password?: string }> {
  let password: string | undefined;
  // pdf.js transfère le buffer au worker : on lui passe une copie.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    const pw = askPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (pw === null) task.destroy();
    else {
      password = pw;
      update(pw);
    }
  };
  const doc = await task.promise;
  return { doc, password };
}

/** Texte de chaque page, avec retours à la ligne. */
export async function extractAllText(doc: PDFDocumentProxy): Promise<PageText[]> {
  const out: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    for (const item of tc.items) {
      if ('str' in item) {
        text += item.str;
        if (item.hasEOL) text += '\n';
        else if (item.str && !item.str.endsWith(' ')) text += ' ';
      }
    }
    out.push({ page: i - 1, text: text.replace(/[ \t]+/g, ' ').trim() });
  }
  return out;
}

export async function getOutline(doc: PDFDocumentProxy): Promise<OutlineItem[]> {
  const raw = await doc.getOutline();
  if (!raw) return [];
  const resolve = async (dest: unknown): Promise<number | null> => {
    try {
      let d = dest;
      if (typeof d === 'string') d = await doc.getDestination(d);
      if (!Array.isArray(d)) return null;
      const ref = d[0];
      if (typeof ref === 'number') return ref;
      return await doc.getPageIndex(ref);
    } catch {
      return null;
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = async (items: any[]): Promise<OutlineItem[]> =>
    Promise.all(
      items.map(async (it) => ({
        title: it.title,
        page: await resolve(it.dest),
        items: it.items?.length ? await walk(it.items) : [],
      })),
    );
  return walk(raw);
}

/** Rend une page dans un canvas et renvoie le canvas. */
export async function renderPageToCanvas(
  doc: PDFDocumentProxy,
  pageIndex: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, viewport: vp }).promise;
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', q?: number): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob a échoué'))), type, q),
  );
}
