import { useEffect, useRef, useState } from 'react';
import { openPdf, type PDFDocumentProxy } from '../pdf/engine';

/* Fenêtre « public » de la vue présentateur : affiche seulement la diapositive, plein écran,
   pilotée par la fenêtre principale via BroadcastChannel. */

export type PresentMsg =
  | { type: 'ready' }
  | { type: 'doc'; bytes: Uint8Array }
  | { type: 'state'; page: number; blank: 'black' | 'white' | null; laser: [number, number] | null; ink: [number, number][][] }
  | { type: 'close' };

export const PRESENT_CHANNEL = 'nova-present';

export function Audience() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [st, setSt] = useState<Extract<PresentMsg, { type: 'state' }>>({ type: 'state', page: 0, blank: null, laser: null, ink: [] });
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    document.title = 'Nova PDF — Présentation';
    const ch = new BroadcastChannel(PRESENT_CHANNEL);
    ch.onmessage = async (e: MessageEvent<PresentMsg>) => {
      const m = e.data;
      if (m.type === 'doc') setPdf(await openPdf(m.bytes, () => null));
      else if (m.type === 'state') setSt(m);
      else if (m.type === 'close') window.close();
    };
    ch.postMessage({ type: 'ready' } satisfies PresentMsg);
    const r = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', r);
    return () => {
      ch.close();
      window.removeEventListener('resize', r);
    };
  }, []);

  useEffect(() => {
    if (!pdf) return;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const pg = await pdf.getPage(Math.min(st.page, pdf.numPages - 1) + 1);
      const base = pg.getViewport({ scale: 1 });
      const scale = Math.min(size.w / base.width, size.h / base.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = pg.getViewport({ scale: scale * dpr });
      const c = canvas.current!;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = `${vp.width / dpr}px`;
      c.style.height = `${vp.height / dpr}px`;
      task = pg.render({ canvas: c, viewport: vp });
      await task.promise.catch(() => {});
      setBox(c.getBoundingClientRect());
    })();
    return () => task?.cancel();
  }, [pdf, st.page, size]);

  return (
    <div
      className="presentation audience"
      onDoubleClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}
      title="Double-cliquez pour passer en plein écran"
    >
      {!pdf && <p className="aud-wait">En attente de la présentation…<br /><small>Placez cette fenêtre sur l’écran du public puis double-cliquez pour le plein écran.</small></p>}
      <canvas ref={canvas} />
      {box && st.ink.length > 0 && (
        <svg className="pres-ink" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} viewBox="0 0 1 1" preserveAspectRatio="none">
          {st.ink.map((s, i) => (
            <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} fill="none" stroke="#e53935" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 4 }} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      )}
      {box && st.laser && <div className="laser" style={{ left: box.left + st.laser[0] * box.width, top: box.top + st.laser[1] * box.height }} />}
      {st.blank && <div className={`blank-screen ${st.blank}`} />}
    </div>
  );
}
