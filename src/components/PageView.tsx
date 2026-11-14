import { memo, useEffect, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../pdf/engine';
import type { Annotation, Rect, ToolId } from '../types';
import { FONT_CSS, TextStyleBar, measureText, styleShortcut, type FontFam, type TextAlign, type TextStyle } from './TextStyleBar';

export interface ToolOptions {
  color: string;
  strokeWidth: number;
  opacity: number;
  fontSize: number;
  fontFamily: FontFam;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  textBg: string | null; // fond du texte inséré (null = transparent)
  fieldType: 'text' | 'checkbox' | 'signature';
  signer: string; // signataire attendu (demande de signature)
  measureRatio: number; // échelle 1:N (1 = taille réelle)
  measureUnit: 'mm' | 'cm' | 'm' | 'in';
  stamp: string | null; // image du tampon
  image: string | null; // image à insérer
}

/** Longueur réelle d'un segment (points PDF) selon l'échelle choisie. */
export function measureLabel(pts: number, ratio: number, unit: ToolOptions['measureUnit']) {
  const mm = (pts / 72) * 25.4 * ratio;
  const v = unit === 'mm' ? mm : unit === 'cm' ? mm / 10 : unit === 'm' ? mm / 1000 : mm / 25.4;
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 2 : 1 })} ${unit}`;
}

interface LinkBox {
  rect: Rect;
  url?: string;
  dest?: unknown;
}

interface Props {
  doc: PDFDocumentProxy;
  docKey: string;
  pageIndex: number;
  size: { w: number; h: number };
  scale: number;
  visible: boolean;
  tool: ToolId;
  opts: ToolOptions;
  annotations: Annotation[];
  searchQuery: string;
  signature: string | null;
  onAdd: (a: Annotation) => void;
  onDelete: (id: string) => void;
  onUpdate: (a: Annotation) => void;
  onNavigate: (page: number) => void;
  refs?: Map<number, string> | null;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const DRAW_TOOLS: ToolId[] = ['ink', 'rect', 'ellipse', 'arrow', 'text', 'note', 'signature', 'stamp', 'image', 'redact', 'whiteout', 'measure', 'field', 'move', 'eraser'];

interface TextItem { str: string; x: number; y: number; w: number; h: number; font: string }
const SELECTION_TOOLS: ToolId[] = ['highlight', 'underline', 'strike'];

function PageViewImpl(p: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [editor, setEditor] = useState<{ x: number; y: number; kind: 'text' | 'note'; replaceId?: string } | null>(null);
  const [editorText, setEditorText] = useState('');
  const [preview, setPreview] = useState<{ x: number; y: number; page: number; url?: string } | null>(null);
  const [rendered, setRendered] = useState(false);
  const items = useRef<TextItem[]>([]);
  const [textEdit, setTextEdit] = useState<{ rect: Rect; text: string; size: number; family: FontFam; bold: boolean; italic?: boolean; underline?: boolean; align?: TextAlign; color: string; bg: string; original: string; replaceId?: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'resize'; sx: number; sy: number; orig: Annotation; cur: Annotation } | null>(null);
  const [hoverBlock, setHoverBlock] = useState<Rect | null>(null);
  const [refTip, setRefTip] = useState<{ x: number; y: number; items: [number, string][] } | null>(null);

  /** Aperçu des références : survol d'un appel [12] ou [3, 5–7]. */
  const onTextHover = (e: React.MouseEvent) => {
    if (!p.refs?.size) return;
    const el = e.target as HTMLElement;
    if (el.tagName !== 'SPAN') return setRefTip(null);
    const m = (el.textContent ?? '').match(/\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/);
    if (!m) return setRefTip(null);
    const nums: number[] = [];
    for (const part of m[1].split(',')) {
      const [a, b] = part.split(/[–-]/).map((x) => +x.trim());
      for (let k = a; k <= (b || a) && nums.length < 6; k++) nums.push(k);
    }
    const items = nums.filter((k) => p.refs!.has(k)).map((k) => [k, p.refs!.get(k)!] as [number, string]);
    if (!items.length) return setRefTip(null);
    const r = wrapRef.current!.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    setRefTip({ x: b.left - r.left, y: b.bottom - r.top + 4, items });
  };

  // Rendu canvas + couche texte + liens (uniquement si la page est visible)
  useEffect(() => {
    if (!p.visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    (async () => {
      const page = await p.doc.getPage(p.pageIndex + 1).catch(() => null);
      if (cancelled || !page) return;
      const vp = page.getViewport({ scale: p.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      renderTask = page.render({
        canvas,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      try {
        await renderTask.promise;
      } catch {
        return;
      }
      if (cancelled) return;
      setRendered(true);
      const container = textRef.current!;
      container.replaceChildren();
      container.style.setProperty('--total-scale-factor', String(p.scale));
      container.style.setProperty('--scale-factor', String(p.scale));
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: vp });
      await textLayer.render().catch(() => {});
      if (cancelled) return;
      markHits(container, p.searchQuery);

      const vp1 = page.getViewport({ scale: 1 });
      try {
        const tc = await page.getTextContent();
        const styles = tc.styles as Record<string, { fontFamily: string }>;
        items.current = [];
        for (const it of tc.items) {
          if (!('str' in it) || !it.str.trim()) continue;
          const t = it.transform as number[];
          const h = Math.hypot(t[2], t[3]) || it.height;
          const [x0, y0] = vp1.convertToViewportPoint(t[4], t[5] + h * 0.85);
          const [x1, y1] = vp1.convertToViewportPoint(t[4] + it.width, t[5] - h * 0.25);
          // nom réel de la police (ex. « Helvetica-Bold ») pour retrouver graisse et famille
          let real = '';
          try {
            const fo = page.commonObjs.has(it.fontName) ? (page.commonObjs.get(it.fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean }) : null;
            if (fo) real = `${fo.name ?? ''} ${fo.bold || fo.black ? 'bold' : ''}`;
          } catch {
            /* police non chargée */
          }
          items.current.push({ str: it.str, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), font: `${it.fontName} ${styles[it.fontName]?.fontFamily ?? ''} ${real}` });
        }
      } catch {
        items.current = [];
      }
      const annots = await page.getAnnotations();
      const ls: LinkBox[] = [];
      for (const a of annots) {
        if (a.subtype !== 'Link' || (!a.url && !a.dest)) continue;
        const [x1, y1] = vp1.convertToViewportPoint(a.rect[0], a.rect[1]);
        const [x2, y2] = vp1.convertToViewportPoint(a.rect[2], a.rect[3]);
        ls.push({
          rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
          url: a.url,
          dest: a.dest,
        });
      }
      if (!cancelled) setLinks(ls);
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.visible, p.scale, p.doc, p.pageIndex, p.docKey]);

  useEffect(() => {
    if (textRef.current) markHits(textRef.current, p.searchQuery);
  }, [p.searchQuery]);

  // Actions demandées par le menu contextuel
  const markRef = useRef<(k: 'highlight' | 'underline' | 'strike') => void>(() => {});
  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent).detail as { page: number; x: number; y: number; kind: 'text' | 'note' };
      if (d.page !== p.pageIndex) return;
      setEditor({ x: d.x, y: d.y, kind: d.kind });
      setEditorText('');
    };
    const onMark = (e: Event) => {
      const sel = window.getSelection();
      if (!sel?.rangeCount || !wrapRef.current?.contains(sel.getRangeAt(0).startContainer)) return;
      markRef.current((e as CustomEvent).detail.kind);
    };
    window.addEventListener('nova:edit-at', onEdit);
    window.addEventListener('nova:mark-selection', onMark);
    return () => {
      window.removeEventListener('nova:edit-at', onEdit);
      window.removeEventListener('nova:mark-selection', onMark);
    };
  }, [p.pageIndex]);

  const toPage = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / p.scale, (e.clientY - r.top) / p.scale];
  };

  const base = (): Omit<Annotation, 'kind'> => ({
    id: uid(),
    page: p.pageIndex,
    color: p.opts.color,
    opacity: p.opts.opacity,
    strokeWidth: p.opts.strokeWidth,
    createdAt: Date.now(),
  });

  // --- Outils basés sur la sélection de texte -------------------------------
  const onMouseUp = () => {
    if (SELECTION_TOOLS.includes(p.tool)) markSelection(p.tool as 'highlight' | 'underline' | 'strike');
  };

  const markSelection = (kind: 'highlight' | 'underline' | 'strike') => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const wrap = wrapRef.current!.getBoundingClientRect();
    const rects: Rect[] = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const cr of Array.from(sel.getRangeAt(i).getClientRects())) {
        if (cr.width < 1 || cr.height < 1) continue;
        if (cr.right < wrap.left || cr.left > wrap.right || cr.bottom < wrap.top || cr.top > wrap.bottom) continue;
        rects.push({
          x: (cr.left - wrap.left) / p.scale,
          y: (cr.top - wrap.top) / p.scale,
          w: cr.width / p.scale,
          h: cr.height / p.scale,
        });
      }
    }
    const merged = mergeRects(rects);
    if (!merged.length) return;
    p.onAdd({
      ...base(),
      kind,
      color: kind === 'highlight' && ['#e53935', '#3949ab', '#212121'].includes(p.opts.color) ? '#ffeb3b' : p.opts.color,
      opacity: kind === 'highlight' ? Math.min(p.opts.opacity, 0.45) : p.opts.opacity,
      rects: merged,
      text: sel.toString().replace(/\s+/g, ' ').trim(),
    });
    sel.removeAllRanges();
  };
  markRef.current = markSelection;

  // --- Outils de dessin ---------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (!DRAW_TOOLS.includes(p.tool) || p.tool === 'eraser') return;
    const [x, y] = toPage(e);
    if (p.tool === 'move') {
      const hit = [...p.annotations].reverse().find((a) => {
        const b = bboxOf(a);
        return b && x >= b.x - 4 && x <= b.x + b.w + 8 && y >= b.y - 4 && y <= b.y + b.h + 8;
      });
      if (!hit) return;
      const b = bboxOf(hit)!;
      const resize = !!hit.rect && Math.abs(x - (b.x + b.w)) < 10 && Math.abs(y - (b.y + b.h)) < 10;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDrag({ id: hit.id, mode: resize ? 'resize' : 'move', sx: x, sy: y, orig: hit, cur: hit });
      return;
    }
    if (p.tool === 'text' || p.tool === 'note') {
      e.preventDefault();
      if (editor) {
        // un clic à côté termine la saisie en cours (comme sur Mac)
        commitEditor();
        return;
      }
      if (p.tool === 'text') {
        // clic sur un texte existant : on le rouvre pour le modifier
        const prev = [...p.annotations].reverse().find((a) => a.kind === 'text' && a.rect && x >= a.rect.x - 3 && x <= a.rect.x + a.rect.w + 3 && y >= a.rect.y - 3 && y <= a.rect.y + a.rect.h + 3);
        if (prev) {
          window.dispatchEvent(
            new CustomEvent('nova:text-style', {
              detail: { color: prev.color, fontSize: prev.fontSize ?? 14, fontFamily: prev.fontFamily ?? 'sans', bold: !!prev.bold, italic: !!prev.italic, underline: !!prev.underline, align: prev.align ?? 'left', bg: prev.bg ?? null } satisfies TextStyle,
            }),
          );
          setEditor({ x: prev.rect!.x, y: prev.rect!.y, kind: 'text', replaceId: prev.id });
          setEditorText(prev.text ?? '');
          return;
        }
      }
      setEditor({ x, y, kind: p.tool });
      setEditorText('');
      return;
    }
    if (p.tool === 'signature' || p.tool === 'stamp' || p.tool === 'image') {
      const src = p.tool === 'signature' ? p.signature : p.tool === 'image' ? p.opts.image : p.opts.stamp;
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        const w = p.tool === 'signature' ? 160 : p.tool === 'image' ? Math.min(240, img.width) : 170;
        const h = (img.height / img.width) * w;
        p.onAdd({ ...base(), kind: 'image', opacity: p.tool === 'stamp' ? 0.9 : 1, rect: { x: x - w / 2, y: y - h / 2, w, h }, dataUrl: src });
      };
      img.src = src;
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const b = base();
    if (p.tool === 'ink') setDraft({ ...b, kind: 'ink', points: [[x, y]] });
    else if (p.tool === 'arrow') setDraft({ ...b, kind: 'arrow', points: [[x, y], [x, y]] });
    else if (p.tool === 'measure') setDraft({ ...b, kind: 'measure', strokeWidth: 1.2, color: ['#ffeb3b', '#8bc34a', '#4fc3f7', '#f48fb1'].includes(b.color) ? '#d32f2f' : b.color, points: [[x, y], [x, y]] });
    else if (p.tool === 'redact') setDraft({ ...b, kind: 'redact', color: '#000000', opacity: 1, rect: { x, y, w: 0, h: 0 } });
    else if (p.tool === 'whiteout') setDraft({ ...b, kind: 'whiteout', color: '#ffffff', opacity: 1, rect: { x, y, w: 0, h: 0 } });
    else if (p.tool === 'field')
      setDraft({ ...b, kind: 'field', color: '#3d52d5', opacity: 1, fieldType: p.opts.fieldType, rect: { x, y, w: 0, h: 0 } });
    else setDraft({ ...b, kind: p.tool as 'rect' | 'ellipse', rect: { x, y, w: 0, h: 0 } });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag) {
      const [x, y] = toPage(e);
      setDrag({ ...drag, cur: drag.mode === 'move' ? moveAnn(drag.orig, x - drag.sx, y - drag.sy) : resizeAnn(drag.orig, x - drag.sx, y - drag.sy) });
      return;
    }
    if (!draft) return;
    const [x, y] = toPage(e);
    if (draft.kind === 'ink') setDraft({ ...draft, points: [...draft.points!, [x, y]] });
    else if (draft.kind === 'arrow') setDraft({ ...draft, points: [draft.points![0], [x, y]] });
    else if (draft.kind === 'measure') {
      const pts: [number, number][] = [draft.points![0], [x, y]];
      setDraft({ ...draft, points: pts, text: measureLabel(dist(pts[0], pts[1]), p.opts.measureRatio, p.opts.measureUnit) });
    }
    else {
      const sx = (draft as Annotation & { _sx?: number })._sx ?? draft.rect!.x;
      const sy = (draft as Annotation & { _sy?: number })._sy ?? draft.rect!.y;
      setDraft({
        ...draft,
        _sx: sx,
        _sy: sy,
        rect: { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) },
      } as Annotation);
    }
  };

  const onPointerUp = () => {
    if (drag) {
      if (drag.cur !== drag.orig) p.onUpdate(drag.cur);
      setDrag(null);
      return;
    }
    if (!draft) return;
    const d = { ...draft } as Annotation & { _sx?: number; _sy?: number };
    delete d._sx;
    delete d._sy;
    const big =
      (d.rect && d.rect.w > 3 && d.rect.h > 3) ||
      (d.kind === 'ink' && (d.points?.length ?? 0) > 1) ||
      ((d.kind === 'arrow' || d.kind === 'measure') && dist(d.points![0], d.points![1]) > 5);
    if (d.kind === 'field') {
      if (d.fieldType === 'checkbox' && d.rect) d.rect = { ...d.rect, w: Math.max(d.rect.w, 12), h: Math.max(d.rect.w, 12) };
      d.fieldName =
        d.fieldType === 'signature'
          ? `nova_sig:${p.opts.signer || 'Signataire'}:${Math.random().toString(36).slice(2, 6)}`
          : `${d.fieldType === 'checkbox' ? 'Case' : 'Champ'}_${p.pageIndex + 1}_${Math.random().toString(36).slice(2, 6)}`;
    }
    if (big || (d.kind === 'field' && d.fieldType === 'checkbox')) p.onAdd(d);
    setDraft(null);
  };

  /** Outil « Modifier le texte » : retrouve la ligne cliquée et ouvre l'éditeur à sa place. */
  const blockAt = (x: number, y: number) => {
    const its = items.current;
    const hit = its.find((it) => x >= it.x - 1 && x <= it.x + it.w + 1 && y >= it.y - 1 && y <= it.y + it.h + 1);
    if (!hit) return null;
    const line = its.filter((it) => Math.abs(it.y + it.h / 2 - (hit.y + hit.h / 2)) < hit.h * 0.35 && Math.abs(it.h - hit.h) < hit.h * 0.4);
    line.sort((a, b) => a.x - b.x);
    // garde le groupe contigu autour de l'élément cliqué
    const idx = line.indexOf(hit);
    let a = idx;
    let b = idx;
    while (a > 0 && line[a].x - (line[a - 1].x + line[a - 1].w) < hit.h * 1.2) a--;
    while (b < line.length - 1 && line[b + 1].x - (line[b].x + line[b].w) < hit.h * 1.2) b++;
    const grp = line.slice(a, b + 1);
    let text = '';
    grp.forEach((it, i) => {
      if (i > 0) {
        const gap = it.x - (grp[i - 1].x + grp[i - 1].w);
        if (gap > hit.h * 0.15 && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
      }
      text += it.str;
    });
    const x0 = Math.min(...grp.map((i) => i.x));
    const y0 = Math.min(...grp.map((i) => i.y));
    const x1 = Math.max(...grp.map((i) => i.x + i.w));
    const y1 = Math.max(...grp.map((i) => i.y + i.h));
    return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, text: text.trim(), font: hit.font, size: hit.h / 1.1 };
  };

  /** Couleurs du texte et du fond, lues sur le rendu de la page. */
  const sampleColors = (r: Rect) => {
    const c = canvasRef.current;
    const k = c ? c.width / (p.size.w) : 1;
    try {
      const g = c!.getContext('2d', { willReadFrequently: true })!;
      const d = g.getImageData(Math.max(0, r.x * k), Math.max(0, r.y * k), Math.max(1, r.w * k), Math.max(1, r.h * k)).data;
      let darkest = [255, 255, 255];
      const counts = new Map<string, number>();
      for (let i = 0; i < d.length; i += 16) {
        const px = [d[i], d[i + 1], d[i + 2]];
        const lum = px[0] * 0.3 + px[1] * 0.59 + px[2] * 0.11;
        if (lum < darkest[0] * 0.3 + darkest[1] * 0.59 + darkest[2] * 0.11) darkest = px;
        const key = px.map((v) => Math.round(v / 16) * 16).join(',');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
      const hex = (px: number[]) => '#' + px.map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');
      return { color: hex(darkest), bg: hex(bg) };
    } catch {
      return { color: '#000000', bg: '#ffffff' };
    }
  };

  const onEditClick = (e: React.MouseEvent) => {
    if (p.tool !== 'edittext' || textEdit) return;
    const [x, y] = toPage(e);
    // retoucher un remplacement déjà fait
    const prev = p.annotations.find((a) => a.kind === 'textedit' && a.rect && x >= a.rect.x && x <= a.rect.x + a.rect.w && y >= a.rect.y && y <= a.rect.y + a.rect.h);
    if (prev) {
      setTextEdit({ rect: prev.rect!, text: prev.text ?? '', size: prev.fontSize ?? 12, family: prev.fontFamily ?? 'sans', bold: !!prev.bold, italic: !!prev.italic, underline: !!prev.underline, align: prev.align ?? 'left', color: prev.color, bg: prev.bg ?? '#ffffff', original: prev.original ?? '', replaceId: prev.id });
      return;
    }
    const blk = blockAt(x, y);
    if (!blk) return;
    const pad = 1.5;
    const rect = { x: blk.rect.x - pad, y: blk.rect.y - pad, w: blk.rect.w + pad * 2, h: blk.rect.h + pad * 2 };
    const f = blk.font.toLowerCase();
    const family = /mono|courier/.test(f) ? 'mono' : /serif|times|roman|georgia|garamond|minion|cambria/.test(f) && !/sans/.test(f) ? 'serif' : 'sans';
    const { color, bg } = sampleColors(rect);
    setTextEdit({ rect, text: blk.text, original: blk.text, size: Math.round(blk.size * 10) / 10, family, bold: /bold|black|heavy|semibold/.test(f), color, bg });
  };

  const commitTextEdit = () => {
    if (!textEdit) return;
    if (textEdit.text !== textEdit.original || textEdit.replaceId) {
      const lines = textEdit.text.split('\n').length;
      const ann: Annotation = {
        ...base(),
        id: textEdit.replaceId ?? base().id,
        kind: 'textedit',
        rect: { ...textEdit.rect, h: Math.max(textEdit.rect.h, textEdit.size * 1.25 * lines) },
        text: textEdit.text,
        original: textEdit.original,
        fontSize: textEdit.size,
        fontFamily: textEdit.family,
        bold: textEdit.bold,
        italic: textEdit.italic,
        underline: textEdit.underline,
        align: textEdit.align,
        color: textEdit.color,
        bg: textEdit.bg,
        opacity: 1,
      };
      if (textEdit.replaceId) p.onUpdate(ann);
      else p.onAdd(ann);
    }
    setTextEdit(null);
  };

  const commitEditor = () => {
    if (!editor) return;
    if (editor.replaceId && !editorText.trim()) p.onDelete(editor.replaceId);
    else if (editorText.trim()) {
      const o = p.opts;
      const size = o.fontSize;
      const ann: Annotation =
        editor.kind === 'text'
          ? {
              ...base(),
              id: editor.replaceId ?? base().id,
              kind: 'text',
              rect: { x: editor.x, y: editor.y, w: measureText(editorText, o) + 2, h: size * 1.2 * editorText.split('\n').length },
              text: editorText,
              fontSize: size,
              fontFamily: o.fontFamily,
              bold: o.bold,
              italic: o.italic,
              underline: o.underline,
              align: o.align,
              bg: o.textBg ?? undefined,
              opacity: 1,
            }
          : { ...base(), kind: 'note', rect: { x: editor.x, y: editor.y, w: 20, h: 20 }, text: editorText, opacity: 1 };
      if (editor.replaceId) p.onUpdate(ann);
      else p.onAdd(ann);
    }
    setEditor(null);
  };
  const editorStyle: TextStyle = { fontFamily: p.opts.fontFamily, fontSize: p.opts.fontSize, bold: p.opts.bold, italic: p.opts.italic, underline: p.opts.underline, align: p.opts.align, color: p.opts.color, bg: p.opts.textBg };

  const navigateDest = async (dest: unknown, hoverOnly: boolean, ev?: React.MouseEvent) => {
    try {
      let d = dest;
      if (typeof d === 'string') d = await p.doc.getDestination(d);
      if (!Array.isArray(d)) return;
      const idx = typeof d[0] === 'number' ? d[0] : await p.doc.getPageIndex(d[0]);
      if (hoverOnly && ev) {
        const r = wrapRef.current!.getBoundingClientRect();
        setPreview({ x: ev.clientX - r.left, y: ev.clientY - r.top, page: idx });
      } else p.onNavigate(idx);
    } catch {
      /* destination invalide */
    }
  };

  const overlayActive = DRAW_TOOLS.includes(p.tool);
  const shown = drag ? p.annotations.map((a) => (a.id === drag.id ? drag.cur : a)) : p.annotations;
  const all = draft ? [...shown, draft] : shown;

  return (
    <div
      ref={wrapRef}
      className={`page tool-${p.tool}`}
      data-page={p.pageIndex}
      style={{ width: p.size.w * p.scale, height: p.size.h * p.scale }}
      onMouseUp={onMouseUp}
      onClick={onEditClick}
      onMouseMove={
        p.tool === 'edittext'
          ? (e) => {
              const [x, y] = toPage(e);
              const b = blockAt(x, y);
              setHoverBlock(b ? b.rect : null);
            }
          : undefined
      }
      onMouseLeave={() => setHoverBlock(null)}
    >
      {!rendered && <div className="page-loading">{p.pageIndex + 1}</div>}
      <canvas ref={canvasRef} className="page-canvas" />
      <div ref={textRef} className="textLayer" onMouseOver={onTextHover} onMouseLeave={() => setRefTip(null)} />
      <div className="link-layer">
        {links.map((l, i) => (
          <a
            key={i}
            className="pdf-link"
            href={l.url ?? '#'}
            target={l.url ? '_blank' : undefined}
            rel="noreferrer noopener"
            style={{ left: l.rect.x * p.scale, top: l.rect.y * p.scale, width: l.rect.w * p.scale, height: l.rect.h * p.scale }}
            onClick={(e) => {
              if (!l.url) {
                e.preventDefault();
                navigateDest(l.dest, false);
              }
            }}
            onMouseEnter={(e) => (l.dest ? navigateDest(l.dest, true, e) : setPreview(null))}
            onMouseLeave={() => setPreview(null)}
            title={l.url}
          />
        ))}
      </div>
      <svg
        className="ann-layer"
        viewBox={`0 0 ${p.size.w} ${p.size.h}`}
        style={{ pointerEvents: overlayActive ? 'all' : 'none', cursor: overlayActive ? (p.tool === 'eraser' ? 'not-allowed' : 'crosshair') : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {all.map((a) => (
          <AnnShape key={a.id} a={a} eraser={p.tool === 'eraser'} onDelete={p.onDelete} />
        ))}
        {p.tool === 'move' &&
          all.map((a) => {
            const b = bboxOf(a);
            if (!b) return null;
            return (
              <g key={`sel-${a.id}`} className="move-box">
                <rect x={b.x - 2} y={b.y - 2} width={b.w + 4} height={b.h + 4} />
                {a.rect && <rect className="handle" x={b.x + b.w - 3} y={b.y + b.h - 3} width={7} height={7} />}
              </g>
            );
          })}
      </svg>
      {p.tool === 'edittext' && hoverBlock && !textEdit && (
        <div
          className="edit-hover"
          style={{ left: (hoverBlock.x - 2) * p.scale, top: (hoverBlock.y - 2) * p.scale, width: (hoverBlock.w + 4) * p.scale, height: (hoverBlock.h + 4) * p.scale }}
        />
      )}
      {textEdit && (
        <div className="text-edit-box" style={{ left: textEdit.rect.x * p.scale, top: (textEdit.rect.y - 34 / p.scale) * p.scale }} onClick={(e) => e.stopPropagation()}>
          <div className="text-edit-bar">
            <TextStyleBar
              bgOptional={false}
              value={{ fontFamily: textEdit.family, fontSize: textEdit.size, bold: textEdit.bold, italic: !!textEdit.italic, underline: !!textEdit.underline, align: textEdit.align ?? 'left', color: textEdit.color, bg: textEdit.bg }}
              onChange={(st) => setTextEdit({ ...textEdit, family: st.fontFamily, size: st.fontSize, bold: st.bold, italic: st.italic, underline: st.underline, align: st.align, color: st.color, bg: st.bg ?? '#ffffff' })}
            />
            <button className="primary" onClick={commitTextEdit}>OK</button>
            <button onClick={() => setTextEdit(null)}>Annuler</button>
          </div>
          <textarea
            autoFocus
            className="text-edit-area"
            value={textEdit.text}
            onChange={(e) => setTextEdit({ ...textEdit, text: e.target.value })}
            onKeyDown={(e) => {
              const st: TextStyle = { fontFamily: textEdit.family, fontSize: textEdit.size, bold: textEdit.bold, italic: !!textEdit.italic, underline: !!textEdit.underline, align: textEdit.align ?? 'left', color: textEdit.color, bg: textEdit.bg };
              if (styleShortcut(e, st, (n) => setTextEdit({ ...textEdit, bold: n.bold, italic: n.italic, underline: n.underline }))) return;
              if (e.key === 'Escape') setTextEdit(null);
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitTextEdit();
              }
            }}
            style={{
              width: Math.max(textEdit.rect.w * p.scale + 30, 140),
              minHeight: textEdit.rect.h * p.scale + 6,
              fontSize: textEdit.size * p.scale,
              fontFamily: FONT_CSS[textEdit.family],
              fontWeight: textEdit.bold ? 700 : 400,
              fontStyle: textEdit.italic ? 'italic' : 'normal',
              textDecoration: textEdit.underline ? 'underline' : 'none',
              textAlign: textEdit.align ?? 'left',
              color: textEdit.color,
              background: textEdit.bg,
            }}
          />
        </div>
      )}
      {editor && (
        <textarea
          autoFocus
          className={`inline-editor ${editor.kind}`}
          style={{
            left: editor.x * p.scale,
            top: editor.y * p.scale,
            ...(editor.kind === 'text'
              ? {
                  fontSize: p.opts.fontSize * p.scale,
                  color: p.opts.color,
                  fontFamily: FONT_CSS[p.opts.fontFamily],
                  fontWeight: p.opts.bold ? 700 : 400,
                  fontStyle: p.opts.italic ? 'italic' : 'normal',
                  textDecoration: p.opts.underline ? 'underline' : 'none',
                  textAlign: p.opts.align,
                  background: p.opts.textBg ?? undefined,
                  lineHeight: 1.2,
                }
              : { fontSize: 13 }),
          }}
          placeholder={editor.kind === 'note' ? 'Votre note… (Ctrl+Entrée)' : 'Texte… (Ctrl+Entrée)'}
          value={editorText}
          onChange={(e) => setEditorText(e.target.value)}
          onBlur={(e) => {
            // passer à la barre de mise en forme ne termine pas la saisie
            const to = e.relatedTarget as HTMLElement | null;
            if (to?.closest('.tool-opts, .text-style-bar, .color-pop')) return;
            commitEditor();
          }}
          onKeyDown={(e) => {
            if (editor.kind === 'text' && styleShortcut(e, editorStyle, (st) => window.dispatchEvent(new CustomEvent('nova:text-style', { detail: st })))) return;
            if (e.key === 'Escape') setEditor(null);
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEditor();
          }}
        />
      )}
      {preview && <LinkPreview doc={p.doc} {...preview} />}
      {refTip && (
        <div className="ref-tip" style={{ left: Math.min(refTip.x, p.size.w * p.scale - 340), top: refTip.y }}>
          {refTip.items.map(([k, t]) => (
            <p key={k}>
              <b>[{k}]</b> {t}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function AnnShape({ a, eraser, onDelete }: { a: Annotation; eraser: boolean; onDelete: (id: string) => void }) {
  const common = {
    onPointerDown: eraser
      ? (e: React.PointerEvent) => {
          e.stopPropagation();
          onDelete(a.id);
        }
      : undefined,
    className: `ann ann-${a.kind}${eraser ? ' erasable' : ''}`,
  };
  switch (a.kind) {
    case 'highlight':
      return (
        <g {...common}>
          {a.rects?.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={a.color} opacity={a.opacity} style={{ mixBlendMode: 'multiply' }} />
          ))}
          {a.text && <title>{a.text}</title>}
        </g>
      );
    case 'underline':
    case 'strike':
      return (
        <g {...common}>
          {a.rects?.map((r, i) => {
            const y = a.kind === 'underline' ? r.y + r.h * 0.95 : r.y + r.h * 0.55;
            return <line key={i} x1={r.x} x2={r.x + r.w} y1={y} y2={y} stroke={a.color} strokeWidth={Math.max(1, r.h * 0.07)} opacity={a.opacity} />;
          })}
          <rect x={0} y={0} width={0} height={0} />
        </g>
      );
    case 'ink':
      return (
        <polyline
          {...common}
          points={a.points?.map((pt) => pt.join(',')).join(' ')}
          fill="none"
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={a.opacity}
        />
      );
    case 'rect':
      return <rect {...common} x={a.rect!.x} y={a.rect!.y} width={a.rect!.w} height={a.rect!.h} fill="none" stroke={a.color} strokeWidth={a.strokeWidth} opacity={a.opacity} />;
    case 'ellipse':
      return (
        <ellipse
          {...common}
          cx={a.rect!.x + a.rect!.w / 2}
          cy={a.rect!.y + a.rect!.h / 2}
          rx={a.rect!.w / 2}
          ry={a.rect!.h / 2}
          fill="none"
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          opacity={a.opacity}
        />
      );
    case 'arrow': {
      const [[x1, y1], [x2, y2]] = a.points as [number, number][];
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = 6 + a.strokeWidth * 3;
      const h1 = [x2 + len * Math.cos(ang + Math.PI * 0.85), y2 + len * Math.sin(ang + Math.PI * 0.85)];
      const h2 = [x2 + len * Math.cos(ang - Math.PI * 0.85), y2 + len * Math.sin(ang - Math.PI * 0.85)];
      return (
        <g {...common} stroke={a.color} strokeWidth={a.strokeWidth} strokeLinecap="round" opacity={a.opacity}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} />
          <line x1={x2} y1={y2} x2={h1[0]} y2={h1[1]} />
          <line x1={x2} y1={y2} x2={h2[0]} y2={h2[1]} />
        </g>
      );
    }
    case 'text': {
      const r = a.rect!;
      const fs = a.fontSize ?? 14;
      const ax = a.align === 'center' ? r.x + r.w / 2 : a.align === 'right' ? r.x + r.w : r.x;
      return (
        <g {...common} opacity={a.opacity}>
          {a.bg && <rect x={r.x - 1.5} y={r.y} width={r.w + 3} height={r.h} fill={a.bg} rx={1} />}
          <text
            x={ax}
            y={r.y}
            fill={a.color}
            fontSize={fs}
            fontFamily={FONT_CSS[a.fontFamily ?? 'sans']}
            fontWeight={a.bold ? 700 : 400}
            fontStyle={a.italic ? 'italic' : 'normal'}
            textDecoration={a.underline ? 'underline' : undefined}
            textAnchor={a.align === 'center' ? 'middle' : a.align === 'right' ? 'end' : 'start'}
          >
            {a.text?.split('\n').map((l, i) => (
              <tspan key={i} x={ax} dy={fs * (i === 0 ? 0.95 : 1.2)}>
                {l || ' '}
              </tspan>
            ))}
          </text>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />
        </g>
      );
    }
    case 'note':
      return (
        <g {...common} transform={`translate(${a.rect!.x} ${a.rect!.y})`} style={{ pointerEvents: 'visiblePainted', cursor: 'help' }}>
          <title>{a.text}</title>
          <rect width={18} height={18} rx={3} fill={a.color} stroke="#0006" />
          <path d="M4 6h10M4 9h10M4 12h6" stroke="#000a" strokeWidth={1.2} />
        </g>
      );
    case 'image':
      return <image {...common} href={a.dataUrl} x={a.rect!.x} y={a.rect!.y} width={a.rect!.w} height={a.rect!.h} />;
    case 'textedit':
      return (
        <g {...common}>
          <rect x={a.rect!.x} y={a.rect!.y} width={a.rect!.w} height={a.rect!.h} fill={a.bg ?? '#fff'} />
          {(() => {
            const r = a.rect!;
            const ax = a.align === 'center' ? r.x + r.w / 2 : a.align === 'right' ? r.x + r.w - 1.5 : r.x + 1.5;
            return (
              <text
                x={ax}
                y={r.y}
                fill={a.color}
                fontSize={a.fontSize}
                fontFamily={FONT_CSS[a.fontFamily ?? 'sans']}
                fontWeight={a.bold ? 700 : 400}
                fontStyle={a.italic ? 'italic' : 'normal'}
                textDecoration={a.underline ? 'underline' : undefined}
                textAnchor={a.align === 'center' ? 'middle' : a.align === 'right' ? 'end' : 'start'}
              >
                {a.text?.split('\n').map((l, i) => (
                  <tspan key={i} x={ax} dy={a.fontSize! * (i === 0 ? 0.95 : 1.2)}>{l}</tspan>
                ))}
              </text>
            );
          })()}
          <title>Texte modifié — d'origine : « {a.original} »</title>
        </g>
      );
    case 'whiteout':
      return <rect {...common} x={a.rect!.x} y={a.rect!.y} width={a.rect!.w} height={a.rect!.h} fill="#fff" stroke="#0002" strokeDasharray="2 2" />;
    case 'measure': {
      const [[x1, y1], [x2, y2]] = a.points as [number, number][];
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const nx = Math.sin(ang) * 5;
      const ny = -Math.cos(ang) * 5;
      return (
        <g {...common} stroke={a.color} strokeWidth={a.strokeWidth}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} />
          <line x1={x1 - nx} y1={y1 - ny} x2={x1 + nx} y2={y1 + ny} />
          <line x1={x2 - nx} y1={y2 - ny} x2={x2 + nx} y2={y2 + ny} />
          <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} fill={a.color} stroke="#fff" strokeWidth={3} paintOrder="stroke" fontSize={10} textAnchor="middle" fontFamily="Helvetica, Arial">
            {a.text}
          </text>
        </g>
      );
    }
    case 'field':
      return (
        <g {...common}>
          <rect x={a.rect!.x} y={a.rect!.y} width={a.rect!.w} height={a.rect!.h} fill="rgb(61 82 213 / 0.12)" stroke="#3d52d5" strokeDasharray="3 2" />
          <text x={a.rect!.x + 2} y={a.rect!.y - 2} fontSize={7} fill="#3d52d5" fontFamily="Helvetica, Arial">
            {a.fieldType === 'checkbox' ? '☐ ' : ''}{a.fieldType === 'signature' ? `✍ Signature : ${a.fieldName?.split(':')[1]}` : a.fieldName}
          </text>
        </g>
      );
    case 'redact':
      return (
        <g {...common}>
          <rect x={a.rect!.x} y={a.rect!.y} width={a.rect!.w} height={a.rect!.h} fill="#000" />
          <title>Zone caviardée (définitive à l'enregistrement)</title>
        </g>
      );
  }
}

function LinkPreview({ doc, page, x, y }: { doc: PDFDocumentProxy; page: number; x: number; y: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const pg = await doc.getPage(page + 1);
      const vp = pg.getViewport({ scale: 0.45 });
      const c = ref.current;
      if (!c) return;
      c.width = vp.width;
      c.height = vp.height;
      task = pg.render({ canvas: c, viewport: vp });
      await task.promise.catch(() => {});
    })();
    return () => task?.cancel();
  }, [doc, page]);
  return (
    <div className="link-preview" style={{ left: x + 12, top: y + 12 }}>
      <div className="link-preview-title">Aperçu — page {page + 1}</div>
      <canvas ref={ref} />
    </div>
  );
}


function bboxOf(a: Annotation): Rect | null {
  if (a.rect) return a.rect;
  const rs = a.rects?.length ? a.rects : null;
  if (rs) {
    const x0 = Math.min(...rs.map((r) => r.x));
    const y0 = Math.min(...rs.map((r) => r.y));
    return { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) - x0, h: Math.max(...rs.map((r) => r.y + r.h)) - y0 };
  }
  if (a.points?.length) {
    const xs = a.points.map((q) => q[0]);
    const ys = a.points.map((q) => q[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return null;
}

function moveAnn(a: Annotation, dx: number, dy: number): Annotation {
  return {
    ...a,
    rect: a.rect && { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy },
    rects: a.rects?.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })),
    points: a.points?.map((q) => [q[0] + dx, q[1] + dy] as [number, number]),
  };
}

function resizeAnn(a: Annotation, dx: number, dy: number): Annotation {
  if (!a.rect) return a;
  const keepRatio = a.kind === 'image';
  let w = Math.max(8, a.rect.w + dx);
  let h = Math.max(8, a.rect.h + dy);
  if (keepRatio) h = (w * a.rect.h) / a.rect.w;
  if (keepRatio && h < 8) [h, w] = [8, (8 * a.rect.w) / a.rect.h];
  const k = a.kind === 'text' || a.kind === 'textedit' ? h / a.rect.h : 1;
  return { ...a, rect: { ...a.rect, w, h }, fontSize: a.fontSize ? Math.max(4, a.fontSize * k) : a.fontSize };
}

function markHits(container: HTMLElement, query: string) {
  const q = query.trim().toLowerCase();
  container.querySelectorAll('span').forEach((s) => {
    s.classList.toggle('hit', !!q && (s.textContent ?? '').toLowerCase().includes(q));
  });
}

function dist(a: [number, number], b: [number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Fusionne les rectangles de sélection qui sont sur la même ligne. */
function mergeRects(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < r.h * 0.5 && r.x <= last.x + last.w + 2) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      last.y = Math.min(last.y, r.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else out.push({ ...r });
  }
  return out;
}

export const PageView = memo(PageViewImpl);
