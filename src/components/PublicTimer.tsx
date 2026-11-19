import { useEffect, useRef, useState } from 'react';

/* Minuteur affiché au public (question minutée, exercice, pause…) : dans un coin, ou en grand sur fond clair,
   avec l'heure en option. Le même état est envoyé à la fenêtre du public. */

export interface TimerState {
  total: number; // durée en secondes
  endsAt: number | null; // en cours : heure de fin (ms)
  left: number; // en pause : secondes restantes
  mode: 'off' | 'corner' | 'big';
  corner: 'tr' | 'tl' | 'br' | 'bl';
  clock: boolean; // afficher aussi l'heure
  label: string; // ex. « Question 3 »
}

export const DEFAULT_TIMER: TimerState = { total: 120, endsAt: null, left: 120, mode: 'off', corner: 'tr', clock: false, label: '' };

export const remaining = (t: TimerState, now = Date.now()) => (t.endsAt ? Math.max(0, Math.ceil((t.endsAt - now) / 1000)) : t.left);
export const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Affichage (écran public et diapositive) */
export function TimerOverlay({ t }: { t: TimerState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const prevLeft = useRef<number | null>(null);
  const left = remaining(t, now);
  // petit signal sonore à la fin
  useEffect(() => {
    if (prevLeft.current != null && prevLeft.current > 0 && left === 0 && t.endsAt) beep();
    prevLeft.current = left;
  }, [left, t.endsAt]);
  if (t.mode === 'off' && !t.clock) return null;
  const done = t.mode !== 'off' && left === 0 && (t.endsAt != null || t.left === 0);
  const ratio = t.total ? left / t.total : 0;
  const warn = left <= 10 && left > 0 ? 'warn' : '';
  const clock = new Date(now).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (t.mode === 'big')
    return (
      <div className={`ptimer-big ${done ? 'done' : warn}`}>
        {t.label && <div className="pt-label">{t.label}</div>}
        <div className="pt-ring">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="45" className="bg" />
            <circle cx="50" cy="50" r="45" className="fg" style={{ strokeDasharray: `${ratio * 282.7} 282.7` }} />
          </svg>
          <b>{done ? 'Temps écoulé' : fmtSec(left)}</b>
        </div>
        {t.clock && <div className="pt-clock">{clock}</div>}
      </div>
    );
  return (
    <div className={`ptimer-corner c-${t.corner} ${done ? 'done' : warn}`}>
      {t.mode === 'corner' && (
        <span className="pt-count">
          {t.label && <small>{t.label}</small>}
          {done ? 'Temps écoulé' : fmtSec(left)}
        </span>
      )}
      {t.clock && <span className="pt-time">{clock}</span>}
    </div>
  );
}

function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.25, 0.5].forEach((d) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + d + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + d);
      o.stop(ctx.currentTime + d + 0.22);
    });
  } catch {
    /* son indisponible */
  }
}

/** Réglages du minuteur (vue présentateur / barre de présentation) */
export function TimerControls({ t, set, compact }: { t: TimerState; set: (t: TimerState) => void; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const left = remaining(t, now);
  const running = t.endsAt != null && left > 0;
  const setDur = (sec: number) => set({ ...t, total: sec, left: sec, endsAt: null });
  const min = Math.floor(t.total / 60);
  const sec = t.total % 60;
  return (
    <div className={`timer-ctl ${compact ? 'compact' : ''}`}>
      <div className="tc-row">
        <b className={`tc-left ${left <= 10 && t.endsAt ? 'warn' : ''}`}>{fmtSec(left)}</b>
        {!running ? (
          <button className="tc-go" onClick={() => set({ ...t, endsAt: Date.now() + (left || t.total) * 1000, left: left || t.total, mode: t.mode === 'off' ? 'corner' : t.mode })}>
            ▶ {t.endsAt == null && left !== t.total && left > 0 ? 'Reprendre' : 'Démarrer'}
          </button>
        ) : (
          <button onClick={() => set({ ...t, endsAt: null, left })}>⏸ Pause</button>
        )}
        <button onClick={() => set({ ...t, endsAt: null, left: t.total })} title="Remettre à zéro">↺</button>
        <button onClick={() => set({ ...t, endsAt: t.endsAt ? t.endsAt + 30000 : null, left: t.endsAt ? t.left : left + 30 })} title="Ajouter 30 secondes">+30 s</button>
      </div>
      <div className="tc-row">
        <label title="Durée (minutes et secondes)">
          Durée
          <input type="number" min={0} max={300} value={min} onChange={(e) => setDur(Math.max(0, +e.target.value) * 60 + sec)} /> min
          <input type="number" min={0} max={59} value={sec} onChange={(e) => setDur(min * 60 + Math.min(59, Math.max(0, +e.target.value)))} /> s
        </label>
      </div>
      <div className="tc-row presets">
        {[30, 60, 120, 300, 600].map((p) => (
          <button key={p} className={t.total === p ? 'active' : ''} onClick={() => setDur(p)}>
            {p < 60 ? `${p} s` : `${p / 60} min`}
          </button>
        ))}
      </div>
      <div className="tc-row">
        <span>Écran public</span>
        <select value={t.mode} onChange={(e) => set({ ...t, mode: e.target.value as TimerState['mode'] })}>
          <option value="off">Masqué</option>
          <option value="corner">Dans un coin</option>
          <option value="big">En grand, sur fond clair</option>
        </select>
        {t.mode === 'corner' && (
          <select value={t.corner} onChange={(e) => set({ ...t, corner: e.target.value as TimerState['corner'] })} title="Coin">
            <option value="tr">↗ haut droite</option>
            <option value="tl">↖ haut gauche</option>
            <option value="br">↘ bas droite</option>
            <option value="bl">↙ bas gauche</option>
          </select>
        )}
      </div>
      <div className="tc-row">
        <label className="check">
          <input type="checkbox" checked={t.clock} onChange={(e) => set({ ...t, clock: e.target.checked })} /> Afficher l’heure
        </label>
        <input className="tc-label" placeholder="Titre (ex. Question 3)" value={t.label} onChange={(e) => set({ ...t, label: e.target.value })} />
      </div>
    </div>
  );
}
