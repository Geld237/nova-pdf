import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';

/** Miniature de page, rendue seulement quand elle devient visible. */
export function Thumb({
  doc,
  page,
  width = 120,
  rotate = 0,
}: {
  doc: PDFDocumentProxy;
  page: number;
  width?: number;
  rotate?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setSeen(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || page < 0) return;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let dead = false;
    (async () => {
      const pg = await doc.getPage(page + 1);
      if (dead) return;
      const base = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: width / base.width });
      const c = ref.current!;
      c.width = vp.width;
      c.height = vp.height;
      task = pg.render({ canvas: c, viewport: vp });
      await task.promise.catch(() => {});
    })();
    return () => {
      dead = true;
      task?.cancel();
    };
  }, [seen, doc, page, width]);

  return (
    <canvas
      ref={ref}
      className="thumb-canvas"
      width={width}
      height={width * 1.3}
      style={{ width, transform: rotate ? `rotate(${rotate}deg)` : undefined }}
    />
  );
}
