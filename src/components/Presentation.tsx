import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';
import type { Annotation } from '../types';
import type { PresentMsg } from './Audience';
import { DEFAULT_TIMER, TimerControls, TimerOverlay, type TimerState } from './PublicTimer';
import { closeAudience, hasSecondScreen, listScreens, moveAudience, openAudience, openChannel, putPresentDoc, type Channel, type ScreenInfo } from '../present';

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
  const chan = useRef<Channel | null>(null);
  const [screens, setScreens] = useState<ScreenInfo[]>([]);
  const [audScreen, setAudScreen] = useState<ScreenInfo | null>(null);
  const [grid, setGrid] = useState(false);
  const [qTimer, setQTimer] = useState<TimerState>(() => {
    try {
      return { ...DEFAULT_TIMER, ...JSON.parse(localStorage.getItem('nova:public-timer') ?? '{}'), endsAt: null };
    } catch {
      return DEFAULT_TIMER;
    }
  });
  useEffect(() => {
    const { endsAt: _e, ...keep } = qTimer;
    void _e;
    localStorage.setItem('nova:public-timer', JSON.stringify({ ...keep, left: qTimer.total }));
  }, [qTimer]);
  const [timerPop, setTimerPop] = useState(false);
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
  /** Vue présentateur (comme PowerPoint) : diapositives en plein écran sur l'autre écran, console ici. */
  const startPresenter = async (ask = true) => {
    if (presenter || !bytes) return;
    switching.current = true;
    await putPresentDoc(bytes);
    const ch = openChannel((raw) => {
      const m = raw as PresentMsg;
      if (m.type === 'ready') ch.post({ type: 'doc' } satisfies PresentMsg);
      else if (m.type === 'key') keyRef.current(m.key);
    });
    chan.current = ch;
    const scr = await listScreens(ask);
    setScreens(scr);
    // écran du public : un autre que celui de cette fenêtre (de préférence pas l'écran principal)
    const other = scr.find((x) => !x.current && !x.primary) ?? scr.find((x) => !x.current) ?? null;
    setAudScreen(other);
    const ok = await openAudience(other);
    setPresenter(true);
    setT0(Date.now());
    if (!ok) alertOnce();
    // la console reste en plein écran sur l'écran principal
    if (!document.fullscreenElement) root.current?.requestFullscreen?.().catch(() => {});
    setTimeout(() => (switching.current = false), 800);
  };
  // deux écrans branchés → vue présentateur automatiquement (réglable)
  useEffect(() => {
    if (!bytes || localStorage.getItem('nova:presenter-auto') === '0') return;
    hasSecondScreen().then((two) => {
      if (two) startPresenter(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const switchScreen = async () => {
    const list = screens.length > 1 ? screens : await listScreens(true);
    setScreens(list);
    if (list.length < 2) return;
    const i = audScreen ? list.findIndex((x) => x.id === audScreen.id) : -1;
    const next = list[(i + 1) % list.length];
    setAudScreen(next);
    await moveAudience(next);
  };
  const [popupBlocked, setPopupBlocked] = useState(false);
  const alertOnce = () => setPopupBlocked(true);
  useEffect(
    () => () => {
      chan.current?.post({ type: 'close' } satisfies PresentMsg);
      chan.current?.close();
      closeAudience();
    },
    [],
  );
  useEffect(() => {
    chan.current?.post({ type: 'state', page, blank, laser: laser ? rpos : null, ink: ink[page] ?? [], timer: qTimer } satisfies PresentMsg);
  }, [page, blank, laser, rpos, ink, presenter, qTimer]);

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

  // touches : clavier de cette fenêtre OU de la fenêtre public (télécommande de présentation)
  const keyRef = useRef<(key: string) => boolean>(() => false);
  keyRef.current = (raw: string) => {
    const key = raw.toLowerCase();
    if (grid && key === 'escape') {
      setGrid(false);
      return true;
    }
    if (['arrowright', 'arrowdown', 'pagedown', ' ', 'enter', 'n'].includes(key)) go(page + 1);
    else if (['arrowleft', 'arrowup', 'pageup', 'backspace', 'p'].includes(key)) go(page - 1);
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
    else if (key === 'g' || key === '-') setGrid((g) => !g);
    else return false;
    return true;
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('textarea, input, select')) return;
      if (keyRef.current(e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

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
            <label title="Durée de la présentation, en minutes (n’importe quelle valeur)">
              Durée prévue
              <span className="pv-dur">
                <input type="number" min={0} max={600} step={1} list="nova-durations" value={target || ''} placeholder="—" onChange={(e) => setTarget(Math.max(0, +e.target.value || 0))} /> min
              </span>
              <datalist id="nova-durations">
                {[5, 10, 15, 20, 30, 45, 60, 90].map((m) => <option key={m} value={m} />)}
              </datalist>
            </label>
            <button onClick={() => setT0(Date.now())}>↺ Remettre à zéro</button>
          </div>
          <details className="pv-timer" open={qTimer.mode !== 'off' || qTimer.endsAt != null}>
            <summary>⏱ Minuteur pour le public (question minutée…)</summary>
            <TimerControls t={qTimer} set={setQTimer} />
          </details>
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
              La fenêtre du public n’a pas pu s’ouvrir (fenêtres surgissantes bloquées ?). <button onClick={() => openAudience(audScreen).then((ok) => setPopupBlocked(!ok))}>Réessayer</button>
            </p>
          )}
          <div className="pv-row">
            <button onClick={switchScreen} title="Afficher les diapositives sur un autre écran">🖥 Changer d’écran</button>
            <button onClick={() => setGrid(true)} title="Voir toutes les diapositives (G)">▦ Toutes les diapositives</button>
          </div>
          <label className="check pv-auto">
            <input type="checkbox" defaultChecked={localStorage.getItem('nova:presenter-auto') !== '0'} onChange={(e) => localStorage.setItem('nova:presenter-auto', e.target.checked ? '1' : '0')} />
            Vue présentateur automatique quand un 2e écran est branché
          </label>
          <small className="muted">
            {audScreen ? `Public : ${audScreen.label}. ` : 'Si la fenêtre « Présentation » n’est pas sur l’écran du public, utilisez « Changer d’écran ». '}
            Une télécommande ou le clavier fonctionnent sur les deux écrans.
          </small>
        </aside>
        {grid && <SlideGrid pdf={pdf} current={page} onPick={(i) => { go(i); setGrid(false); }} onClose={() => setGrid(false)} />}
      </div>
    );

  return (
    <div ref={root} className="presentation">
      {slide}
      {grid && <SlideGrid pdf={pdf} current={page} onPick={(i) => { go(i); setGrid(false); }} onClose={() => setGrid(false)} />}
      <TimerOverlay t={qTimer} />
      {timerPop && (
        <div className="pres-timer-pop" onPointerDown={(e) => e.stopPropagation()}>
          <TimerControls t={qTimer} set={setQTimer} compact />
          <button className="tp-close" onClick={() => setTimerPop(false)}>Fermer</button>
        </div>
      )}
      {hud && (
        <div className="pres-hud">
          <button className={qTimer.mode !== 'off' || qTimer.clock ? 'active' : ''} onClick={() => setTimerPop((v) => !v)} title="Minuteur / horloge à l’écran">⏱ Minuteur</button>
          {tools}
          <span>⏱ {fmt(elapsed)}</span>
          {bytes && <button onClick={() => startPresenter()} title="Vue présentateur sur cet écran, diapositives sur le 2e écran (V)">🖥 Présentateur</button>}
          <button onClick={() => onExit(page)} title="Quitter (Échap)">✕</button>
        </div>
      )}
    </div>
  );
}

/** Toutes les diapositives en vignettes (touche G), pour sauter directement à l'une d'elles. */
function SlideGrid({ pdf, current, onPick, onClose }: { pdf: PDFDocumentProxy; current: number; onPick: (i: number) => void; onClose: () => void }) {
  return (
    <div className="slide-grid" onClick={onClose}>
      <div className="sg-inner" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>Toutes les diapositives</b>
          <button onClick={onClose}>Fermer (Échap)</button>
        </header>
        <div className="sg-list">
          {Array.from({ length: pdf.numPages }, (_, i) => (
            <SlideThumb key={i} pdf={pdf} i={i} active={i === current} onPick={() => onPick(i)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SlideThumb({ pdf, i, active, onPick }: { pdf: PDFDocumentProxy; i: number; active: boolean; onPick: () => void }) {
  const c = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting || !c.current) return;
      io.disconnect();
      const pg = await pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 220 / pg.getViewport({ scale: 1 }).width });
      c.current.width = vp.width;
      c.current.height = vp.height;
      task = pg.render({ canvas: c.current, viewport: vp });
      task.promise.catch(() => {});
    });
    if (c.current) io.observe(c.current);
    if (active) c.current?.scrollIntoView({ block: 'center' });
    return () => {
      io.disconnect();
      task?.cancel();
    };
  }, [pdf, i, active]);
  return (
    <button className={`sg-item ${active ? 'active' : ''}`} onClick={onPick}>
      <canvas ref={c} />
      <span>{i + 1}</span>
    </button>
  );
}
