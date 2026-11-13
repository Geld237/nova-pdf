import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import type { Annotation, Rect } from '../types';
import { renderPageToCanvas, canvasToBlob, type PDFDocumentProxy } from './engine';

export function hexToRgb(hex: string) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Supprime les caractères que la police standard ne sait pas encoder. */
export function sanitize(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return Array.from(text)
    .map((c) => (c === '\n' || set.has(c.codePointAt(0)!) ? c : c === '’' ? "'" : '?'))
    .join('');
}

type Conv = (x: number, y: number) => [number, number];

/**
 * Applique (aplatit) les annotations dans le PDF.
 * - surlignages, formes, dessins, textes, signatures : dessinés dans le contenu ;
 * - notes : de vraies annotations PDF « Text », lisibles dans les autres lecteurs ;
 * - caviardage : la page est rastérisée, le texte masqué disparaît réellement.
 */
export async function applyAnnotations(
  bytes: Uint8Array,
  annotations: Annotation[],
  viewDoc: PDFDocumentProxy,
): Promise<Uint8Array> {
  if (!annotations.length) return bytes;
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const byPage = new Map<number, Annotation[]>();
  for (const a of annotations) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page)!.push(a);
  }

  for (const [pageIndex, anns] of byPage) {
    if (pageIndex >= pdf.getPageCount()) continue;
    const vpPage = await viewDoc.getPage(pageIndex + 1);
    const vp = vpPage.getViewport({ scale: 1 });
    let page: PDFPage = pdf.getPage(pageIndex);
    let conv: Conv = (x, y) => vp.convertToPdfPoint(x, y) as [number, number];

    // 1) Caviardage réel : on remplace la page par une image où les zones sont noircies.
    const redactions = anns.filter((a) => a.kind === 'redact');
    if (redactions.length) {
      const scale = 2;
      const canvas = await renderPageToCanvas(viewDoc, pageIndex, scale);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      for (const r of redactions) {
        const b = r.rect!;
        ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
      }
      const png = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
      const img = await pdf.embedJpg(png);
      pdf.removePage(pageIndex);
      page = pdf.insertPage(pageIndex, [vp.width, vp.height]);
      page.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
      const H = vp.height;
      conv = (x, y) => [x, H - y];
    }

    const box = (r: Rect) => {
      const [x1, y1] = conv(r.x, r.y);
      const [x2, y2] = conv(r.x + r.w, r.y + r.h);
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      };
    };

    for (const a of anns) {
      const color = hexToRgb(a.color);
      switch (a.kind) {
        case 'highlight':
          for (const r of a.rects ?? []) {
            const b = box(r);
            page.drawRectangle({
              x: b.x, y: b.y, width: b.w, height: b.h,
              color, opacity: a.opacity, blendMode: BlendMode.Multiply,
            });
          }
          break;
        case 'underline':
        case 'strike':
          for (const r of a.rects ?? []) {
            const yy = a.kind === 'underline' ? r.y + r.h * 0.95 : r.y + r.h * 0.55;
            page.drawLine({
              start: { x: conv(r.x, yy)[0], y: conv(r.x, yy)[1] },
              end: { x: conv(r.x + r.w, yy)[0], y: conv(r.x + r.w, yy)[1] },
              thickness: Math.max(1, r.h * 0.07), color, opacity: a.opacity,
            });
          }
          break;
        case 'ink': {
          const pts = a.points ?? [];
          for (let i = 1; i < pts.length; i++) {
            const [x1, y1] = conv(...pts[i - 1]);
            const [x2, y2] = conv(...pts[i]);
            page.drawLine({
              start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
              thickness: a.strokeWidth, color, opacity: a.opacity, lineCap: LineCapStyle.Round,
            });
          }
          break;
        }
        case 'rect': {
          const b = box(a.rect!);
          page.drawRectangle({
            x: b.x, y: b.y, width: b.w, height: b.h,
            borderColor: color, borderWidth: a.strokeWidth, borderOpacity: a.opacity,
          });
          break;
        }
        case 'ellipse': {
          const b = box(a.rect!);
          page.drawEllipse({
            x: b.x + b.w / 2, y: b.y + b.h / 2, xScale: b.w / 2, yScale: b.h / 2,
            borderColor: color, borderWidth: a.strokeWidth, borderOpacity: a.opacity,
          });
          break;
        }
        case 'arrow': {
          const [p0, p1] = a.points ?? [];
          if (!p0 || !p1) break;
          const [x1, y1] = conv(...p0);
          const [x2, y2] = conv(...p1);
          const draw = (sx: number, sy: number, ex: number, ey: number) =>
            page.drawLine({
              start: { x: sx, y: sy }, end: { x: ex, y: ey },
              thickness: a.strokeWidth, color, opacity: a.opacity, lineCap: LineCapStyle.Round,
            });
          draw(x1, y1, x2, y2);
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const len = 6 + a.strokeWidth * 3;
          for (const d of [Math.PI * 0.85, -Math.PI * 0.85]) {
            draw(x2, y2, x2 + len * Math.cos(ang + d), y2 + len * Math.sin(ang + d));
          }
          break;
        }
        case 'text': {
          const r = a.rect!;
          const size = a.fontSize ?? 14;
          const lines = sanitize(font, a.text ?? '').split('\n');
          lines.forEach((line, i) => {
            const [x, y] = conv(r.x, r.y + size * (i + 1));
            page.drawText(line, { x, y: y + size * 0.2, size, font, color, opacity: a.opacity });
          });
          break;
        }
        case 'image': {
          if (!a.dataUrl) break;
          const b = box(a.rect!);
          const data = await fetch(a.dataUrl).then((r) => r.arrayBuffer());
          const img = a.dataUrl.startsWith('data:image/png') ? await pdf.embedPng(data) : await pdf.embedJpg(data);
          page.drawImage(img, { x: b.x, y: b.y, width: b.w, height: b.h, opacity: a.opacity });
          break;
        }
        case 'note': {
          const r = a.rect!;
          const [x, y] = conv(r.x, r.y);
          const c = hexToRgb(a.color);
          const annot = pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Text',
            Rect: [x, y - 20, x + 20, y],
            Contents: PDFHexString.fromText(a.text ?? ''),
            T: PDFString.of('Nova PDF'),
            Name: 'Comment',
            C: [c.red, c.green, c.blue],
            F: 4,
          });
          const ref = pdf.context.register(annot);
          const annots = page.node.lookup(PDFName.of('Annots'));
          if (annots && 'push' in annots) (annots as unknown as { push: (r: unknown) => void }).push(ref);
          else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
          break;
        }
        case 'redact':
          break; // déjà traité
      }
    }
  }
  return pdf.save();
}
