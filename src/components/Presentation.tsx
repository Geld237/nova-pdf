import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';

/** Mode présentation : plein écran, pointeur laser, dessin éphémère, écran noir/blanc, chronomètre. */
export function Presentation({ pdf, start, onExit }: { pdf: PDFDocumentProxy; start: number; onExit: (page: number) => void }) {
  const [page, setPage] = useState(start);
  const [laser, setLaser] = useState(true);
  const [draw, setDraw] = useState(false);
  const [blank, setBlank] = useState<'black' | 'white' | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [ink, setInk] = useState<Record<number, [number, number][][]>>({});
  const [t0] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [hud, setHud] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const n = pdf.numPages;

  const go = useCallback((p: number) => setPage(Math.max(0, Math.min(n - 1, p))), [n]);

  useEffect(() => {
    root.current?.requestFullscreen?.().catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 1000);
    const onFs = () => !document.fullscreenElement && onExit(page);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      clearInterval(t);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // rendu de la page à la taille de l'écran
  useEffect(() => {
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const pg = await pdf.getPage(page + 1);
      const base = pg.getViewport({ scale: 1 });
      const W = window.innerWidth;
      const H = window.innerHeight;
      const scale = Math.min(W / base.width, H / base.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = pg.getViewport({ scale: scale * dpr });
      const c = canvas.current!;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = `${vp.width / dpr}px`;
      c.style.height = `${vp.height / dpr}px`;
      task = pg.render({ canvas: c, viewport: vp });
      await task.promise.catch(() => {});
    })();
    return () => task?.cancel();
  }, [page, pdf]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (['arrowright', 'arrowdown', 'pagedown', ' ', 'enter', 'n'].includes(key)) { e.preventDefault(); go(page + 1); }
      else if (['arrowleft', 'arrowup', 'pageup', 'backspace', 'p'].includes(key)) { e.preventDefault(); go(page - 1); }
      else if (key === 'home') go(0);
      else if (key === 'end') go(n - 1);
      else if (key === 'escape') onExit(page);
      else if (key === 'l') { setLaser((x) => !x); setDraw(false); }
      else if (key === 'd') { setDraw((x) => !x); setLaser(false); }
      else if (key === 'e') setInk((x) => ({ ...x, [page]: [] }));
      else if (key === 'b' || key === '.') setBlank((b) => (b === 'black' ? null : 'black'));
      else if (key === 'w' || key === ',') setBlank((b) => (b === 'white' ? null : 'white'));
      else if (key === 'h') setHud((h) => !h);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [page, go, n, onExit]);

  const rel = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as [number, number];
  };
  const elapsed = Math.floor((now - t0) / 1000);
  const cw = canvas.current?.getBoundingClientRect();

  return (
    <div
      ref={root}
      className={`presentation ${laser ? 'laser-on' : ''} ${draw ? 'draw-on' : ''}`}
      onPointerMove={(e) => {
        setPos({ x: e.clientX, y: e.clientY });
        if (drawing.current) {
          const p = rel(e);
          setInk((x) => {
            const strokes = [...(x[page] ?? [])];
            strokes[strokes.length - 1] = [...strokes[strokes.length - 1], p];
            return { ...x, [page]: strokes };
          });
        }
      }}
      onPointerDown={(e) => {
        if (draw) {
          drawing.current = true;
          setInk((x) => ({ ...x, [page]: [...(x[page] ?? []), [rel(e)]] }));
        } else if (!laser) go(e.clientX > window.innerWidth / 2 ? page + 1 : page - 1);
      }}
      onPointerUp={() => (drawing.current = false)}
      onPointerLeave={() => setPos(null)}
    >
      <canvas ref={canvas} />
      {cw && (ink[page]?.length ?? 0) > 0 && (
        <svg className="pres-ink" style={{ left: cw.left, top: cw.top, width: cw.width, height: cw.height }} viewBox="0 0 1 1" preserveAspectRatio="none">
          {ink[page].map((s, i) => (
            <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} fill="none" stroke="#e53935" strokeWidth={0.004} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 4 }} />
          ))}
        </svg>
      )}
      {laser && pos && <div className="laser" style={{ left: pos.x, top: pos.y }} />}
      {blank && <div className={`blank-screen ${blank}`} onClick={() => setBlank(null)} />}
      {hud && (
        <div className="pres-hud">
          <button onClick={() => go(page - 1)}>‹</button>
          <span>{page + 1} / {n}</span>
          <button onClick={() => go(page + 1)}>›</button>
          <span className="sep" />
          <button className={laser ? 'active' : ''} onClick={() => { setLaser(!laser); setDraw(false); }} title="Pointeur laser (L)">🔴 Laser</button>
          <button className={draw ? 'active' : ''} onClick={() => { setDraw(!draw); setLaser(false); }} title="Dessiner (D) · effacer (E)">✎ Dessiner</button>
          <button onClick={() => setBlank('black')} title="Écran noir (B)">■</button>
          <span>⏱ {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
          <button onClick={() => onExit(page)} title="Quitter (Échap)">✕</button>
        </div>
      )}
    </div>
  );
}
