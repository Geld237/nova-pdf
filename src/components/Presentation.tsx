import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';
import { isTauri } from '../platform';
import type { Annotation } from '../types';
import { PRESENT_CHANNEL, type PresentMsg } from './Audience';

interface Props {
  pdf: PDFDocumentProxy;
  start: number;
  onExit: (page: number) => void;
  /** pour la vue présentateur */
  bytes?: Uint8Array;
  fingerprint?: string;
  annotations?: Annotation[];
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.abs(s) % 60).padStart(2, '0')}`;

/** Ouvre la fenêtre « public » (2e écran). */
async function openAudienceWindow(): Promise<boolean> {
  const url = `${location.origin}${location.pathname}?audience=1`;
  if (isTauri) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const w = new WebviewWindow('audience', { url: 'index.html?audience=1', title: 'Nova PDF — Présentation', width: 1280, height: 720 });
      w.once('tauri://error', () => {});
      return true;
    } catch {
      return false;
    }
  }
  return !!window.open(url, 'nova-audience', 'popup,width=1280,height=720');
}

/** Mode présentation : plein écran, pointeur laser, dessin éphémère, écran noir/blanc, chronomètre,
 *  et vue présentateur (diapo suivante, notes, minuteur) avec l'affichage public sur un deuxième écran. */
export function Presentation({ pdf, start, onExit, bytes, fingerprint, annotations = [] }: Props) {
  const [page, setPage] = useState(start);
  const [laser, setLaser] = useState(true);
  const [draw, setDraw] = useState(false);
  const [blank, setBlank] = useState<'black' | 'white' | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [rpos, setRpos] = useState<[number, number] | null>(null);
  const [ink, setInk] = useState<Record<number, [number, number][][]>>({});
  const [t0, setT0] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [hud, setHud] = useState(true);
  const [presenter, setPresenter] = useState(false);
  const [target, setTarget] = useState(0); // durée prévue (minutes), 0 = aucune
  const [notes, setNotes] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const nextCanvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const chan = useRef<BroadcastChannel | null>(null);
  const switching = useRef(false);
  const n = pdf.numPages;

  const go = useCallback((p: number) => setPage(Math.max(0, Math.min(n - 1, p))), [n]);

  useEffect(() => {
    root.current?.requestFullscreen?.().catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    // en mode simple, sortir du plein écran = quitter ; en vue présentateur on reste
    const onFs = () => !document.fullscreenElement && !presenter && !switching.current && onExit(page);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [presenter, page, onExit]);

  // ---- vue présentateur : canal vers la fenêtre public ----
  const startPresenter = async () => {
    if (presenter) return;
    switching.current = true;
    const ch = new BroadcastChannel(PRESENT_CHANNEL);
    chan.current = ch;
    ch.onmessage = (e: MessageEvent<PresentMsg>) => {
      if (e.data.type === 'ready' && bytes) ch.postMessage({ type: 'doc', bytes } satisfies PresentMsg);
    };
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    const ok = await openAudienceWindow();
    setPresenter(true);
    setT0(Date.now());
    if (!ok) alertOnce();
  };
  const [popupBlocked, setPopupBlocked] = useState(false);
  const alertOnce = () => setPopupBlocked(true);
  useEffect(
    () => () => {
      chan.current?.postMessage({ type: 'close' } satisfies PresentMsg);
      chan.current?.close();
    },
    [],
  );
  useEffect(() => {
    chan.current?.postMessage({ type: 'state', page, blank, laser: laser ? rpos : null, ink: ink[page] ?? [] } satisfies PresentMsg);
  }, [page, blank, laser, rpos, ink, presenter]);

  // notes de l'orateur : enregistrées par page, préremplies avec les notes posées sur la page
  const noteKey = `nova:speaker:${fingerprint ?? 'doc'}:${page}`;
  useEffect(() => {
    const saved = localStorage.getItem(noteKey);
    const fromAnns = annotations
      .filter((a) => a.page === page && (a.kind === 'note' || a.kind === 'text') && a.text)
      .map((a) => `• ${a.text}`)
      .join('\n');
    setNotes(saved ?? fromAnns);
  }, [noteKey, annotations, page]);

  // rendu de la diapo courante (et de la suivante en vue présentateur)
  useEffect(() => {
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let task2: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const pg = await pdf.getPage(page + 1);
      const base = pg.getViewport({ scale: 1 });
      const st = stage.current?.getBoundingClientRect();
      const W = presenter && st ? st.width - 24 : window.innerWidth;
      const H = presenter && st ? st.height - 24 : window.innerHeight;
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
      if (presenter && nextCanvas.current) {
        const nc = nextCanvas.current;
        if (page + 1 < n) {
          const np = await pdf.getPage(page + 2);
          const nb = np.getViewport({ scale: 1 });
          const nvp = np.getViewport({ scale: (300 / nb.width) * dpr });
          nc.width = nvp.width;
          nc.height = nvp.height;
          nc.style.width = '300px';
          nc.style.height = `${nvp.height / dpr}px`;
          task2 = np.render({ canvas: nc, viewport: nvp });
          await task2.promise.catch(() => {});
        } else {
          nc.width = 0;
          nc.height = 0;
        }
      }
    })();
    return () => {
      task?.cancel();
      task2?.cancel();
    };
  }, [page, pdf, presenter, n]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('textarea, input')) return;
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
      else if (key === 'v') startPresenter();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, go, n, onExit]);

  const rel = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as [number, number];
  };
  const elapsed = Math.floor((now - t0) / 1000);
  const left = target ? target * 60 - elapsed : 0;
  const cw = canvas.current?.getBoundingClientRect();

  const slide = (
    <div
      ref={stage}
      className={`pres-stage ${laser ? 'laser-on' : ''} ${draw ? 'draw-on' : ''}`}
      onPointerMove={(e) => {
        setPos({ x: e.clientX, y: e.clientY });
        const p = rel(e);
        setRpos(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1 ? p : null);
        if (drawing.current) {
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
        } else if (!laser) {
          const r = stage.current!.getBoundingClientRect();
          go(e.clientX > r.left + r.width / 2 ? page + 1 : page - 1);
        }
      }}
      onPointerUp={() => (drawing.current = false)}
      onPointerLeave={() => {
        setPos(null);
        setRpos(null);
      }}
    >
      <canvas ref={canvas} />
      {cw && (ink[page]?.length ?? 0) > 0 && (
        <svg className="pres-ink" style={{ left: cw.left, top: cw.top, width: cw.width, height: cw.height }} viewBox="0 0 1 1" preserveAspectRatio="none">
          {ink[page].map((s, i) => (
            <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} fill="none" stroke="#e53935" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 4 }} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      )}
      {laser && pos && <div className="laser" style={{ left: pos.x, top: pos.y }} />}
      {blank && !presenter && <div className={`blank-screen ${blank}`} onClick={() => setBlank(null)} />}
      {blank && presenter && <div className="pres-blank-badge">Écran {blank === 'black' ? 'noir' : 'blanc'} affiché au public</div>}
    </div>
  );

  const tools = (
    <>
      <button onClick={() => go(page - 1)} title="Précédente">‹</button>
      <span>{page + 1} / {n}</span>
      <button onClick={() => go(page + 1)} title="Suivante">›</button>
      <span className="sep" />
      <button className={laser ? 'active' : ''} onClick={() => { setLaser(!laser); setDraw(false); }} title="Pointeur laser (L)">🔴 Laser</button>
      <button className={draw ? 'active' : ''} onClick={() => { setDraw(!draw); setLaser(false); }} title="Dessiner (D) · effacer (E)">✎ Dessiner</button>
      <button className={blank === 'black' ? 'active' : ''} onClick={() => setBlank(blank === 'black' ? null : 'black')} title="Écran noir (B)">■</button>
    </>
  );

  if (presenter)
    return (
      <div ref={root} className="presentation presenter">
        <div className="pv-main">
          {slide}
          <div className="pv-bar">
            {tools}
            <span className="sep" />
            <button onClick={() => onExit(page)} title="Terminer (Échap)">Terminer</button>
          </div>
        </div>
        <aside className="pv-side">
          <div className="pv-clock">
            <div>
              <small>Écoulé</small>
              <b>{fmt(elapsed)}</b>
            </div>
            {target > 0 && (
              <div className={left < 0 ? 'late' : left < 120 ? 'soon' : ''}>
                <small>Restant</small>
                <b>{left < 0 ? '+' : ''}{fmt(Math.abs(left))}</b>
              </div>
            )}
            <div>
              <small>Heure</small>
              <b>{new Date(now).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</b>
            </div>
          </div>
          <div className="pv-row">
            <label>
              Durée prévue
              <select value={target} onChange={(e) => setTarget(+e.target.value)}>
                <option value={0}>—</option>
                {[5, 10, 15, 20, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </label>
            <button onClick={() => setT0(Date.now())}>↺ Remettre à zéro</button>
          </div>
          <div className="pv-next">
            <small>Diapositive suivante</small>
            {page + 1 < n ? <canvas ref={nextCanvas} onClick={() => go(page + 1)} /> : <div className="pv-end">Fin de la présentation</div>}
          </div>
          <div className="pv-notes">
            <small>Notes de l’orateur (page {page + 1})</small>
            <textarea
              value={notes}
              placeholder="Vos notes pour cette diapositive…"
              onChange={(e) => {
                setNotes(e.target.value);
                localStorage.setItem(noteKey, e.target.value);
              }}
            />
          </div>
          {popupBlocked && (
            <p className="pv-warn">
              La fenêtre du public n’a pas pu s’ouvrir (fenêtres surgissantes bloquées ?). <button onClick={() => openAudienceWindow().then((ok) => setPopupBlocked(!ok))}>Réessayer</button>
            </p>
          )}
          <small className="muted">Faites glisser la fenêtre « Présentation » sur l’écran du public, puis double-cliquez dedans pour le plein écran.</small>
        </aside>
      </div>
    );

  return (
    <div ref={root} className="presentation">
      {slide}
      {hud && (
        <div className="pres-hud">
          {tools}
          <span>⏱ {fmt(elapsed)}</span>
          {bytes && <button onClick={startPresenter} title="Vue présentateur sur cet écran, diapositives sur le 2e écran (V)">🖥 Présentateur</button>}
          <button onClick={() => onExit(page)} title="Quitter (Échap)">✕</button>
        </div>
      )}
    </div>
  );
}
