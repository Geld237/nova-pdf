import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* « Carte de couleurs » façon macOS : palette, spectre, récentes, code hex, pipette. */

const PALETTE: string[] = [
  // gris
  '#000000', '#3a3a3c', '#636366', '#8e8e93', '#aeaeb2', '#c7c7cc', '#e5e5ea', '#f2f2f7', '#ffffff',
  // couleurs vives (Apple)
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7', '#007aff', '#5856d6', '#af52de',
  // pastels / surligneurs
  '#ffd6d6', '#ffe5c2', '#fff59d', '#d4f5d4', '#c9f2ee', '#cdeefa', '#d0e3ff', '#dedcff', '#f1d9fb',
  // foncés
  '#8b0000', '#a0522d', '#8b7500', '#1b5e20', '#00695c', '#01579b', '#0d47a1', '#311b92', '#4a148c',
];

const RECENT_KEY = 'nova:recent-colors';
const loadRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
};
const pushRecent = (c: string) => {
  try {
    const r = [c, ...loadRecent().filter((x) => x !== c)].slice(0, 9);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  } catch {
    /* stockage indisponible */
  }
};

// ---- conversions ----
function hexToHsv(hex: string): [number, number, number] {
  const m = hex.replace('#', '').padEnd(6, '0');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}
function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}
const normHex = (s: string) => {
  let t = s.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(t) ? `#${t.toLowerCase()}` : null;
};

interface Props {
  value: string | null;
  onChange: (c: string | null) => void;
  title?: string;
  /** autorise « aucune couleur » (fond transparent) */
  allowNone?: boolean;
  /** petite icône à afficher dans la pastille (ex. « A » pour le texte) */
  glyph?: string;
}

export function ColorPicker({ value, onChange, title = 'Couleur', allowNone, glyph }: Props) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const toggle = () => {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      const W = 268;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), top: Math.min(r.bottom + 6, window.innerHeight - 420) });
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`color-well ${open ? 'open' : ''}`}
        title={title}
        aria-label={title}
        onMouseDown={(e) => e.preventDefault() /* ne pas faire perdre le focus à l'éditeur de texte */}
        onClick={toggle}
      >
        <span className={`swatch ${value ? '' : 'none'}`} style={{ background: value ?? undefined }}>
          {glyph && <b style={{ color: value && hexToHsv(value)[2] < 0.6 ? '#fff' : '#000' }}>{glyph}</b>}
        </span>
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 3l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      {open &&
        createPortal(
          <ColorPopover
            value={value}
            allowNone={allowNone}
            style={pos}
            onClose={() => setOpen(false)}
            onPick={(c, close) => {
              onChange(c);
              if (c) pushRecent(c);
              if (close) setOpen(false);
            }}
          />,
          document.body,
        )}
    </>
  );
}

function ColorPopover({
  value,
  allowNone,
  style,
  onPick,
  onClose,
}: {
  value: string | null;
  allowNone?: boolean;
  style: { left: number; top: number };
  onPick: (c: string | null, close: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'grid' | 'spectrum'>('grid');
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(value ?? '#007aff'));
  const [hex, setHex] = useState(value ?? '');
  const recent = loadRecent();

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.color-well')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const setFromHsv = (n: [number, number, number], close = false) => {
    setHsv(n);
    const c = hsvToHex(...n);
    setHex(c);
    onPick(c, close);
  };

  const dragArea = (e: React.PointerEvent<HTMLDivElement>, fn: (fx: number, fy: number) => void) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const go = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    };
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const eyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;
  const pickScreen = async () => {
    try {
      const ED = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const r = await new ED().open();
      const c = normHex(r.sRGBHex);
      if (c) {
        setHsv(hexToHsv(c));
        setHex(c);
        onPick(c, false);
      }
    } catch {
      /* annulé */
    }
  };

  return (
    <div ref={ref} className="color-pop" style={style} onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}>
      <div className="seg color-tabs">
        <button className={tab === 'grid' ? 'active' : ''} onClick={() => setTab('grid')}>Palette</button>
        <button className={tab === 'spectrum' ? 'active' : ''} onClick={() => setTab('spectrum')}>Spectre</button>
      </div>

      {tab === 'grid' ? (
        <div className="color-grid">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={`cg ${value?.toLowerCase() === c ? 'active' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => {
                setHsv(hexToHsv(c));
                setHex(c);
                onPick(c, true);
              }}
            />
          ))}
        </div>
      ) : (
        <div className="spectrum">
          <div
            className="sv"
            style={{ background: `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv[0]},100%,50%))` }}
            onPointerDown={(e) => dragArea(e, (fx, fy) => setFromHsv([hsv[0], fx, 1 - fy]))}
          >
            <i style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: hsvToHex(...hsv) }} />
          </div>
          <div className="hue" onPointerDown={(e) => dragArea(e, (fx) => setFromHsv([fx * 359.9, hsv[1] || 0.85, hsv[2] || 0.9]))}>
            <i style={{ left: `${(hsv[0] / 360) * 100}%` }} />
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <>
          <small className="cp-label">Récentes</small>
          <div className="color-recent">
            {recent.map((c) => (
              <button key={c} className="cg" style={{ background: c }} title={c} onClick={() => onPick(c, true)} />
            ))}
          </div>
        </>
      )}

      <div className="cp-foot">
        <span className="cp-preview" style={{ background: value ?? 'transparent' }} />
        <input
          value={hex}
          spellCheck={false}
          placeholder="#RRGGBB"
          onChange={(e) => {
            setHex(e.target.value);
            const c = normHex(e.target.value);
            if (c) {
              setHsv(hexToHsv(c));
              onPick(c, false);
            }
          }}
          onKeyDown={(e) => e.key === 'Enter' && onClose()}
          aria-label="Code hexadécimal"
        />
        {eyeDropper && (
          <button className="icon-btn" title="Pipette : prendre une couleur à l’écran" onClick={pickScreen}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m2 22 1-1h3l9-9" /><path d="M3 21v-3l9-9" /><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" /></svg>
          </button>
        )}
        <label className="icon-btn" title="Plus de couleurs (sélecteur du système)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18" opacity=".4" /></svg>
          <input type="color" value={value ?? '#000000'} onChange={(e) => onPick(e.target.value, false)} />
        </label>
      </div>
      {allowNone && (
        <button className="cp-none" onClick={() => onPick(null, true)}>
          <span className="swatch none" /> Aucune couleur
        </button>
      )}
    </div>
  );
}
