import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
