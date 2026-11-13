import { memo, useEffect, useRef, useState } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../pdf/engine';
import type { Annotation, Rect, ToolId } from '../types';

export interface ToolOptions {
  color: string;
  strokeWidth: number;
  opacity: number;
  fontSize: number;
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
  onNavigate: (page: number) => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const DRAW_TOOLS: ToolId[] = ['ink', 'rect', 'ellipse', 'arrow', 'text', 'note', 'signature', 'redact', 'eraser'];
const SELECTION_TOOLS: ToolId[] = ['highlight', 'underline', 'strike'];

function PageViewImpl(p: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [editor, setEditor] = useState<{ x: number; y: number; kind: 'text' | 'note' } | null>(null);
  const [editorText, setEditorText] = useState('');
  const [preview, setPreview] = useState<{ x: number; y: number; page: number; url?: string } | null>(null);
  const [rendered, setRendered] = useState(false);

  // Rendu canvas + couche texte + liens (uniquement si la page est visible)
  useEffect(() => {
    if (!p.visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    (async () => {
      const page = await p.doc.getPage(p.pageIndex + 1);
      if (cancelled) return;
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
    if (!SELECTION_TOOLS.includes(p.tool)) return;
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
    const kind = p.tool as 'highlight' | 'underline' | 'strike';
    p.onAdd({
      ...base(),
      kind,
      opacity: kind === 'highlight' ? Math.min(p.opts.opacity, 0.45) : p.opts.opacity,
      rects: merged,
      text: sel.toString().replace(/\s+/g, ' ').trim(),
    });
    sel.removeAllRanges();
  };

  // --- Outils de dessin ---------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (!DRAW_TOOLS.includes(p.tool) || p.tool === 'eraser') return;
    const [x, y] = toPage(e);
    if (p.tool === 'text' || p.tool === 'note') {
      setEditor({ x, y, kind: p.tool });
      setEditorText('');
      e.preventDefault();
      return;
    }
    if (p.tool === 'signature') {
      if (!p.signature) return;
      const img = new Image();
      img.onload = () => {
        const w = 160;
        const h = (img.height / img.width) * w;
        p.onAdd({ ...base(), kind: 'image', opacity: 1, rect: { x: x - w / 2, y: y - h / 2, w, h }, dataUrl: p.signature! });
      };
      img.src = p.signature;
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const b = base();
    if (p.tool === 'ink') setDraft({ ...b, kind: 'ink', points: [[x, y]] });
    else if (p.tool === 'arrow') setDraft({ ...b, kind: 'arrow', points: [[x, y], [x, y]] });
    else if (p.tool === 'redact') setDraft({ ...b, kind: 'redact', color: '#000000', opacity: 1, rect: { x, y, w: 0, h: 0 } });
    else setDraft({ ...b, kind: p.tool as 'rect' | 'ellipse', rect: { x, y, w: 0, h: 0 } });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const [x, y] = toPage(e);
    if (draft.kind === 'ink') setDraft({ ...draft, points: [...draft.points!, [x, y]] });
    else if (draft.kind === 'arrow') setDraft({ ...draft, points: [draft.points![0], [x, y]] });
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
    if (!draft) return;
    const d = { ...draft } as Annotation & { _sx?: number; _sy?: number };
    delete d._sx;
    delete d._sy;
    const big =
      (d.rect && d.rect.w > 3 && d.rect.h > 3) ||
      (d.kind === 'ink' && (d.points?.length ?? 0) > 1) ||
      (d.kind === 'arrow' && dist(d.points![0], d.points![1]) > 5);
    if (big) p.onAdd(d);
    setDraft(null);
  };

  const commitEditor = () => {
    if (editor && editorText.trim()) {
      const size = p.opts.fontSize;
      p.onAdd({
        ...base(),
        kind: editor.kind,
        rect:
          editor.kind === 'text'
            ? { x: editor.x, y: editor.y, w: 200, h: size * 1.3 * editorText.split('\n').length }
            : { x: editor.x, y: editor.y, w: 20, h: 20 },
        text: editorText,
        fontSize: size,
        opacity: 1,
      });
    }
    setEditor(null);
  };

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
  const all = draft ? [...p.annotations, draft] : p.annotations;

  return (
    <div
      ref={wrapRef}
      className={`page tool-${p.tool}`}
      data-page={p.pageIndex}
      style={{ width: p.size.w * p.scale, height: p.size.h * p.scale }}
      onMouseUp={onMouseUp}
    >
      {!rendered && <div className="page-loading">{p.pageIndex + 1}</div>}
      <canvas ref={canvasRef} className="page-canvas" />
      <div ref={textRef} className="textLayer" />
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
      </svg>
      {editor && (
        <textarea
          autoFocus
          className={`inline-editor ${editor.kind}`}
          style={{
            left: editor.x * p.scale,
            top: editor.y * p.scale,
            fontSize: (editor.kind === 'text' ? p.opts.fontSize : 13) * (editor.kind === 'text' ? p.scale : 1),
            color: editor.kind === 'text' ? p.opts.color : undefined,
          }}
          placeholder={editor.kind === 'note' ? 'Votre note… (Ctrl+Entrée)' : 'Texte… (Ctrl+Entrée)'}
          value={editorText}
          onChange={(e) => setEditorText(e.target.value)}
          onBlur={commitEditor}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditor(null);
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEditor();
          }}
        />
      )}
      {preview && <LinkPreview doc={p.doc} {...preview} />}
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
    case 'text':
      return (
        <text {...common} x={a.rect!.x} y={a.rect!.y} fill={a.color} fontSize={a.fontSize} fontFamily="Helvetica, Arial, sans-serif" opacity={a.opacity}>
          {a.text?.split('\n').map((l, i) => (
            <tspan key={i} x={a.rect!.x} dy={a.fontSize! * (i === 0 ? 1 : 1.2)}>
              {l}
            </tspan>
          ))}
        </text>
      );
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
