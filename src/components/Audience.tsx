import { useEffect, useRef, useState } from 'react';
import { openPdf, type PDFDocumentProxy } from '../pdf/engine';
import { getPresentDoc, openChannel } from '../present';
import { isTauri } from '../platform';
import { TimerOverlay, type TimerState } from './PublicTimer';

/* Fenêtre « public » de la vue présentateur : affiche seulement la diapositive, plein écran,
   pilotée par la fenêtre principale via BroadcastChannel. */

export type PresentMsg =
  | { type: 'ready' }
  | { type: 'doc' } // le document est dans le stockage local (getPresentDoc)
  | { type: 'key'; key: string } // touche / clic reçu par la fenêtre public (télécommande, clavier)
  | { type: 'state'; page: number; blank: 'black' | 'white' | null; laser: [number, number] | null; ink: [number, number][][]; timer?: TimerState }
  | { type: 'close' };

export const PRESENT_CHANNEL = 'nova-present';

export function Audience() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [st, setSt] = useState<Extract<PresentMsg, { type: 'state' }>>({ type: 'state', page: 0, blank: null, laser: null, ink: [] });
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [full, setFull] = useState(false);
  const chRef = useRef<ReturnType<typeof openChannel> | null>(null);

  useEffect(() => {
    document.title = 'Nova PDF — Présentation';
    let loaded = false;
    const ch = openChannel(async (raw) => {
      const m = raw as PresentMsg;
      if (m.type === 'doc' && !loaded) {
        const bytes = await getPresentDoc();
        if (bytes) {
          loaded = true;
          setPdf(await openPdf(bytes, () => null));
        }
      } else if (m.type === 'state') setSt(m);
      else if (m.type === 'close') window.close();
    });
    chRef.current = ch;
    // on se signale tant que le document n'est pas arrivé
    const hello = setInterval(() => !loaded && ch.post({ type: 'ready' } satisfies PresentMsg), 700);
    ch.post({ type: 'ready' } satisfies PresentMsg);
    const r = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', r);
    // une télécommande ou le clavier branché sur cet écran pilote aussi la présentation
    const key = (e: KeyboardEvent) => {
      if (['F11'].includes(e.key)) return;
      e.preventDefault();
      ch.post({ type: 'key', key: e.key } satisfies PresentMsg);
    };
    window.addEventListener('keydown', key);
    const fs = () => setFull(!!document.fullscreenElement || window.innerHeight >= screen.height - 2);
    document.addEventListener('fullscreenchange', fs);
    fs();
    return () => {
      clearInterval(hello);
      ch.close();
      window.removeEventListener('resize', r);
      window.removeEventListener('keydown', key);
      document.removeEventListener('fullscreenchange', fs);
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
      onClick={() => {
        if (!document.fullscreenElement && !isTauri) document.documentElement.requestFullscreen?.().catch(() => {});
        else chRef.current?.post({ type: 'key', key: 'ArrowRight' } satisfies PresentMsg); // clic = diapositive suivante
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        chRef.current?.post({ type: 'key', key: 'ArrowLeft' } satisfies PresentMsg);
      }}
    >
      {!pdf && <p className="aud-wait">En attente de la présentation…</p>}
      {pdf && !full && !isTauri && <div className="aud-full-hint">Cliquez n’importe où pour passer en plein écran</div>}
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
      {st.timer && <TimerOverlay t={st.timer} />}
    </div>
  );
}
