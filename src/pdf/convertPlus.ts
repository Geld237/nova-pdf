import type { PDFDocumentProxy } from './engine';
import { numOrText, toXlsx, type Sheet } from './xlsx';

/* Conversions fidèles à la structure : lignes, colonnes et tableaux reconstruits à partir des positions du texte.
   - PDF → Excel : un tableau par page (colonnes détectées) ;
   - PDF → Word : titres (taille de police), gras, paragraphes, tableaux ;
   - PDF → PowerPoint : une diapositive par page (image nette) + texte de la page en notes. */

interface Item {
  str: string;
  x: number;
  y: number; // haut de ligne (y vers le bas)
  w: number;
  size: number;
  bold: boolean;
}
export interface Line {
  y: number;
  size: number;
  cells: { x: number; x2: number; text: string; bold: boolean }[];
}

async function pageItems(pdf: PDFDocumentProxy, i: number): Promise<{ items: Item[]; width: number; height: number }> {
  const page = await pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  // noms réels des polices (pour repérer le gras) : disponibles après la liste d'opérations
  let fontNames: Record<string, string> = {};
  try {
    await page.getOperatorList();
    const ids = new Set((tc.items as { fontName?: string }[]).map((t) => t.fontName).filter(Boolean) as string[]);
    for (const id of ids) {
      try {
        const f = page.commonObjs.get(id) as { name?: string } | undefined;
        fontNames[id] = f?.name ?? '';
      } catch {
        /* police non chargée */
      }
    }
  } catch {
    fontNames = {};
  }
  const items: Item[] = [];
  for (const t of tc.items as { str: string; transform: number[]; width: number; height: number; fontName: string }[]) {
    if (!t.str || !t.str.trim()) continue;
    const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
    const size = Math.hypot(t.transform[2], t.transform[3]) || t.height || 10;
    const style = (tc.styles as Record<string, { fontFamily?: string }>)[t.fontName]?.fontFamily ?? '';
    const name = `${fontNames[t.fontName] ?? ''} ${style}`;
    items.push({ str: t.str, x, y: y - size, w: t.width, size, bold: /bold|black|heavy|semibold|demi/i.test(name) });
  }
  return { items, width: vp.width, height: vp.height };
}

/** Regroupe les morceaux de texte en lignes, puis en cellules (un grand écart = nouvelle cellule). */
export function toLines(items: Item[]): Line[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; size: number; items: Item[] }[] = [];
  for (const it of sorted) {
    const l = lines.find((L) => Math.abs(L.y - it.y) < Math.max(2, Math.min(L.size, it.size) * 0.5));
    if (l) {
      l.items.push(it);
      l.size = Math.max(l.size, it.size);
    } else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  return lines
    .sort((a, b) => a.y - b.y)
    .map((l) => {
      const its = l.items.sort((a, b) => a.x - b.x);
      const cells: Line['cells'] = [];
      for (const it of its) {
        const last = cells[cells.length - 1];
        const gap = last ? it.x - last.x2 : Infinity;
        if (last && gap < it.size * 1.6) {
          last.text += (gap > it.size * 0.15 && !last.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
          last.x2 = it.x + it.w;
          last.bold = last.bold && it.bold;
        } else cells.push({ x: it.x, x2: it.x + it.w, text: it.str, bold: it.bold });
      }
      cells.forEach((c) => (c.text = c.text.replace(/\s+/g, ' ').trim()));
      return { y: l.y, size: l.size, cells };
    });
}

export interface Block {
  kind: 'para' | 'table';
  lines: Line[];
  cols?: number[]; // abscisses de début de colonne (tableaux)
}

/** Repère les tableaux : au moins 2 lignes consécutives à plusieurs cellules alignées. */
export function toBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let run: Line[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length >= 2) {
      // colonnes : débuts de cellules regroupés
      const xs = run.flatMap((l) => l.cells.map((c) => c.x)).sort((a, b) => a - b);
      const cols: number[] = [];
      for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 14) cols.push(x);
      blocks.push({ kind: 'table', lines: run, cols });
    } else blocks.push({ kind: 'para', lines: run });
    run = [];
  };
  for (const l of lines) {
    if (l.cells.length >= 2) run.push(l);
    else {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === 'para') prev.lines.push(l);
      else blocks.push({ kind: 'para', lines: [l] });
    }
  }
  flush();
  return blocks;
}

const colIndex = (cols: number[], x: number) => {
  let best = 0;
  for (let i = 0; i < cols.length; i++) if (x >= cols[i] - 6) best = i;
  return best;
};

/** Lignes d'un tableau → grille de cellules */
export function tableGrid(b: Block): string[][] {
  const cols = b.cols ?? [];
  return b.lines.map((l) => {
    const row: string[] = new Array(cols.length).fill('');
    for (const c of l.cells) {
      const k = colIndex(cols, c.x);
      row[k] = row[k] ? `${row[k]} ${c.text}` : c.text;
    }
    return row;
  });
}

// ------------------------------------------------------------------ PDF → Excel
export async function pdfToXlsx(pdf: PDFDocumentProxy, onProgress?: (i: number, n: number) => void): Promise<Uint8Array> {
  const sheets: Sheet[] = [];
  const all: Sheet = { name: 'Tout le document', rows: [] };
  let tables = 0;
  for (let i = 0; i < pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    const { items } = await pageItems(pdf, i);
    const blocks = toBlocks(toLines(items));
    const rows: (string | number)[][] = [];
    for (const b of blocks) {
      if (b.kind === 'table') {
        tables++;
        tableGrid(b).forEach((r) => rows.push(r.map(numOrText)));
      } else b.lines.forEach((l) => rows.push([l.cells.map((c) => c.text).join(' ')]));
      rows.push([]);
    }
    if (pdf.numPages <= 40) sheets.push({ name: `Page ${i + 1}`, rows });
    all.rows.push([`— Page ${i + 1} —`], ...rows);
  }
  if (!sheets.length || pdf.numPages > 40) sheets.unshift(all);
  void tables;
  return toXlsx(sheets);
}

// ------------------------------------------------------------------ PDF → Word (structure)
export async function pdfToDocxRich(pdf: PDFDocumentProxy, title: string, onProgress?: (i: number, n: number) => void): Promise<Blob> {
  const d = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak, Table, TableRow, TableCell, WidthType, BorderStyle } = d;
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  // taille du texte courant (médiane) pour reconnaître les titres
  const sizes: number[] = [];
  const pages: Block[][] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    const { items } = await pageItems(pdf, i);
    items.forEach((it) => sizes.push(Math.round(it.size)));
    pages.push(toBlocks(toLines(items)));
  }
  sizes.sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  pages.forEach((blocks, pi) => {
    if (pi > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    for (const b of blocks) {
      if (b.kind === 'table') {
        const grid = tableGrid(b);
        const n = Math.max(...grid.map((r) => r.length));
        const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: grid.map(
              (r, ri) =>
                new TableRow({
                  children: Array.from({ length: n }, (_, k) =>
                    new TableCell({
                      borders: { top: border, bottom: border, left: border, right: border },
                      children: [new Paragraph({ children: [new TextRun({ text: r[k] ?? '', bold: ri === 0 && b.lines[0].cells.every((c) => c.bold) })] })],
                    }),
                  ),
                }),
            ),
          }),
        );
        children.push(new Paragraph({ text: '' }));
        continue;
      }
      // paragraphes : on recolle les lignes proches de même taille ; un grand interligne ou un changement de taille = nouveau paragraphe
      let cur: Line[] = [];
      const out = () => {
        if (!cur.length) return;
        const size = Math.max(...cur.map((l) => l.size));
        const text = cur
          .map((l) => l.cells.map((c) => c.text).join(' '))
          .join('\n')
          .replace(/-\n(\p{Ll})/gu, '$1')
          .replace(/\n/g, ' ')
          .trim();
        const bold = cur.every((l) => l.cells.every((c) => c.bold));
        const heading = size >= body * 1.7 ? HeadingLevel.HEADING_1 : size >= body * 1.3 ? HeadingLevel.HEADING_2 : size >= body * 1.12 && bold ? HeadingLevel.HEADING_3 : undefined;
        if (text) children.push(heading ? new Paragraph({ text, heading }) : new Paragraph({ children: [new TextRun({ text, bold })], spacing: { after: 120 } }));
        cur = [];
      };
      b.lines.forEach((l, k) => {
        const prev = b.lines[k - 1];
        const gap = prev ? l.y - prev.y : 0;
        const newPara = prev && (Math.abs(l.size - prev.size) > 1 || gap > prev.size * 1.75 || /^[•\-–▪●◦]|^\d+[.)]\s/.test(l.cells[0]?.text ?? ''));
        if (newPara) out();
        cur.push(l);
      });
      out();
    }
  });
  return Packer.toBlob(new Document({ creator: 'Nova PDF', title, sections: [{ children }] }));
}

// ------------------------------------------------------------------ PDF → PowerPoint
export async function pdfToPptx(pdf: PDFDocumentProxy, title: string, onProgress?: (i: number, n: number) => void): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  const p1 = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const W = 10;
  const H = +(W * (p1.height / p1.width)).toFixed(3);
  pptx.defineLayout({ name: 'NOVA', width: W, height: H });
  pptx.layout = 'NOVA';
  pptx.title = title;
  for (let i = 0; i < pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages);
    const page = await pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(3, 2400 / vp1.width) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport: vp }).promise;
    const slide = pptx.addSlide();
    // page entière, proportions gardées, centrée
    const k = Math.min(W / vp1.width, H / vp1.height);
    const w = vp1.width * k;
    const h = vp1.height * k;
    slide.addImage({ data: c.toDataURL('image/jpeg', 0.9), x: (W - w) / 2, y: (H - h) / 2, w, h });
    const tc = await page.getTextContent();
    const text = (tc.items as { str: string; hasEOL?: boolean }[]).map((t) => t.str + (t.hasEOL ? '\n' : '')).join('').trim();
    if (text) slide.addNotes(text.slice(0, 5000));
  }
  return (await pptx.write({ outputType: 'blob' })) as Blob;
}
