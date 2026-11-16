import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';
import type { Annotation, ToolId } from '../types';
import { PageView, type ToolOptions } from './PageView';

export interface ViewerHandle {
  scrollToPage: (page: number) => void;
  containerWidth: () => number;
  containerHeight: () => number;
}

interface Props {
  doc: PDFDocumentProxy;
  docKey: string;
  sizes: { w: number; h: number }[];
  scale: number;
  layout: 'single' | 'double';
  tool: ToolId;
  opts: ToolOptions;
  annotations: Annotation[];
  searchQuery: string;
  signature: string | null;
  night: boolean;
  onAdd: (a: Annotation) => void;
  onDelete: (id: string) => void;
  onUpdate: (a: Annotation) => void;
  onPageChange: (page: number) => void;
  refs?: Map<number, string> | null;
  ruler?: boolean;
  /** zoom par pincement (2 doigts) ou Ctrl + molette / pincement du pavé tactile */
  onZoomBy?: (factor: number) => void;
}

export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer(p, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const [rulerY, setRulerY] = useState<number | null>(null);
  const [visible, setVisible] = useState<Set<number>>(new Set([0, 1]));
  const ratios = useRef(new Map<number, number>());
  const onPageChange = p.onPageChange;

  const scrollToPage = useCallback((page: number) => {
    const el = scroller.current?.querySelector(`[data-page="${page}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'start' });
  }, []);

  // Garde la même position de lecture quand le zoom change (ex. fermeture d'un panneau en « Largeur »)
  const anchor = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const on = () => (anchor.current = el.scrollHeight ? el.scrollTop / el.scrollHeight : 0);
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);
  // point à garder sous les doigts lors d'un zoom par pincement
  const pinchAnchor = useRef<{ mx: number; my: number; cx: number; cy: number; s: number } | null>(null);
  const prevScale = useRef(p.scale);
  useLayoutEffect(() => {
    const el = scroller.current;
    const pa = pinchAnchor.current;
    if (el && pa) {
      const r = p.scale / pa.s;
      el.scrollLeft = pa.cx * r - pa.mx;
      el.scrollTop = pa.cy * r - pa.my;
      pinchAnchor.current = null;
    } else if (el && anchor.current) el.scrollTop = anchor.current * el.scrollHeight;
    prevScale.current = p.scale;
  }, [p.scale]);

  // ---- zoom avec deux doigts (iPhone, iPad, Android) et Ctrl + molette ----
  const zoomBy = useRef(p.onZoomBy);
  zoomBy.current = p.onZoomBy;
  const scaleRef = useRef(p.scale);
  scaleRef.current = p.scale;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const pages = el.querySelector('.pages') as HTMLElement | null;
    let start: { d: number; mx: number; my: number; cx: number; cy: number } | null = null;
    let ratio = 1;
    let last = { mx: 0, my: 0 };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => {
      const r = el.getBoundingClientRect();
      return { mx: (t[0].clientX + t[1].clientX) / 2 - r.left, my: (t[0].clientY + t[1].clientY) / 2 - r.top };
    };
    const commit = (f: number, mx: number, my: number, cx: number, cy: number) => {
      const target = Math.max(0.25, Math.min(5, scaleRef.current * f));
      if (Math.abs(target - scaleRef.current) < 0.01) return;
      pinchAnchor.current = { mx, my, cx, cy, s: scaleRef.current };
      zoomBy.current?.(target / scaleRef.current);
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const m = mid(e.touches);
      start = { d: dist(e.touches), ...m, cx: el.scrollLeft + m.mx, cy: el.scrollTop + m.my };
      ratio = 1;
      last = m;
      if (pages) pages.style.transformOrigin = `${start.cx}px ${start.cy}px`;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault(); // pas de défilement ni de zoom de toute l'interface
      ratio = Math.max(0.25 / scaleRef.current, Math.min(5 / scaleRef.current, dist(e.touches) / start.d));
      const m = mid(e.touches);
      last = m;
      // aperçu fluide pendant le geste : zoom + déplacement à deux doigts
      if (pages) pages.style.transform = `translate(${m.mx - start.mx}px, ${m.my - start.my}px) scale(${ratio})`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || e.touches.length >= 2) return;
      const s0 = start;
      start = null;
      if (pages) {
        pages.style.transform = '';
        pages.style.transformOrigin = '';
      }
      // le point de la page qui était sous les doigts se retrouve sous leur nouvelle position
      if (Math.abs(ratio - 1) < 0.02) {
        el.scrollLeft = s0.cx - last.mx;
        el.scrollTop = s0.cy - last.my;
      } else commit(ratio, last.mx, last.my, s0.cx, s0.cy);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      commit(Math.exp(-e.deltaY * 0.01), mx, my, el.scrollLeft + mx, el.scrollTop + my);
    };
    // Safari (Mac, iPhone) : gestes de pincement natifs → on les remplace par notre zoom
    const stopGesture = (e: Event) => e.preventDefault();
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', stopGesture);
    el.addEventListener('gesturechange', stopGesture);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', stopGesture);
      el.removeEventListener('gesturechange', stopGesture);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToPage,
    containerWidth: () => scroller.current?.clientWidth ?? 800,
    containerHeight: () => scroller.current?.clientHeight ?? 800,
  }));

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(i);
            ratios.current.set(i, e.isIntersecting ? e.intersectionRatio : 0);
          }
          return next;
        });
        let best = -1;
        let bestR = 0;
        for (const [i, r] of ratios.current) if (r > bestR) [best, bestR] = [i, r];
        if (best >= 0) onPageChange(best);
      },
      { root, rootMargin: '600px 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    root.querySelectorAll('[data-page]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [p.docKey, p.sizes.length, onPageChange]);

  const byPage = new Map<number, Annotation[]>();
  for (const a of p.annotations) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page)!.push(a);
  }

  return (
    <div
      ref={scroller}
      className={`viewer ${p.night ? 'night' : ''} layout-${p.layout}`}
      onMouseMove={p.ruler ? (e) => setRulerY(e.clientY - scroller.current!.getBoundingClientRect().top) : undefined}
      onMouseLeave={() => setRulerY(null)}
    >
      {p.ruler && rulerY !== null && (
        <div className="reading-ruler" style={{ top: (scroller.current?.scrollTop ?? 0), ['--ry' as string]: `${rulerY}px` }} />
      )}
      <div className="pages">
        {p.sizes.map((s, i) => (
          <PageView
            key={`${p.docKey}-${i}`}
            doc={p.doc}
            docKey={p.docKey}
            pageIndex={i}
            size={s}
            scale={p.scale}
            visible={visible.has(i)}
            tool={p.tool}
            opts={p.opts}
            annotations={byPage.get(i) ?? EMPTY}
            searchQuery={p.searchQuery}
            signature={p.signature}
            onAdd={p.onAdd}
            onDelete={p.onDelete}
            onUpdate={p.onUpdate}
            onNavigate={scrollToPage}
            refs={p.refs}
          />
        ))}
      </div>
    </div>
  );
});

const EMPTY: Annotation[] = [];
