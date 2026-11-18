import { useEffect, useMemo, useRef, useState } from 'react';
import { loadSignatures, saveSignatures } from '../memory';
import { SIG_FONTS, isSvgUrl, loadVectorFont, recolorSvg, strokePath, strokesToSvg, svgToDataUrl, traceToSvg, typedSignatureSvg, type InkPoint } from '../vector';
import { ColorPicker } from './ColorPicker';
import '@fontsource/great-vibes/400.css';
import '@fontsource/dancing-script/700.css';

/** Création / choix d'une signature — toujours en VECTORIEL : tracé lissé à épaisseur variable,
 *  écriture manuscrite (contours de lettres) ou image vectorisée. Nette à toutes les tailles. */

const INKS = [
  { c: '#1a3a8f', label: 'Bleu stylo' },
  { c: '#111111', label: 'Noir' },
  { c: '#0b5d3b', label: 'Vert' },
  { c: '#8e1b1b', label: 'Bordeaux' },
];
const WEIGHTS = [
  { v: 3.5, label: 'Fin' },
  { v: 6, label: 'Moyen' },
  { v: 9, label: 'Épais' },
];
const PAD_W = 640;
const PAD_H = 220;

export function SignatureModal({ onPick, onClose }: { onPick: (dataUrl: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'draw' | 'type' | 'image'>('draw');
  const [saved, setSaved] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [font, setFont] = useState<string>(SIG_FONTS[0].id);
  const [color, setColor] = useState('#1a3a8f');
  const [weight, setWeight] = useState(6);
  const [strokes, setStrokes] = useState<InkPoint[][]>([]);
  const [current, setCurrent] = useState<InkPoint[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pad = useRef<SVGSVGElement>(null);
  const penSeen = useRef(false);

  // signatures enregistrées ; les anciennes (images) sont converties en vectoriel une fois pour toutes
  useEffect(() => {
    (async () => {
      const list = await loadSignatures();
      setSaved(list);
      if (list.some((s) => !isSvgUrl(s))) {
        const conv = await Promise.all(list.map(async (s) => (isSvgUrl(s) ? s : await traceToSvg(s).then(svgToDataUrl).catch(() => s))));
        setSaved(conv);
        await saveSignatures(conv);
      }
    })();
    SIG_FONTS.forEach((f) => loadVectorFont(f.id).catch(() => {}));
  }, []);

  const finish = async (dataUrl: string) => {
    const next = [dataUrl, ...saved.filter((s) => s !== dataUrl)].slice(0, 8);
    await saveSignatures(next);
    onPick(dataUrl);
  };

  // ---- tracé à la main
  const inkOpts = useMemo(() => ({ size: weight, thinning: 0.62, simulatePressure: !penSeen.current }), [weight, strokes.length]);
  const pt = (e: React.PointerEvent | PointerEvent): InkPoint => {
    const r = pad.current!.getBoundingClientRect();
    return [((e.clientX - r.left) * PAD_W) / r.width, ((e.clientY - r.top) * PAD_H) / r.height, e.pressure && e.pointerType === 'pen' ? e.pressure : 0.5];
  };

  // ---- écrire
  const [typedSvg, setTypedSvg] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    if (!typed.trim()) return setTypedSvg(null);
    typedSignatureSvg(typed.trim(), font, color)
      .then((s) => !dead && setTypedSvg(s))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [typed, font, color]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sig-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Signature">
        <header className="panel-head">
          <h2>Signature</h2>
          <button className="icon" onClick={onClose}>
            ✕
          </button>
        </header>
        {saved.length > 0 && (
          <>
            <small className="muted">Mes signatures (vectorielles, nettes à toutes les tailles)</small>
            <div className="saved-sigs">
              {saved.map((s) => (
                <div key={s} className="saved-sig">
                  <button onClick={() => onPick(s)} title="Utiliser">
                    <img src={s} alt="Signature enregistrée" />
                  </button>
                  {isSvgUrl(s) && (
                    <button className="icon" title="Utiliser dans la couleur choisie" onClick={() => finish(recolorSvg(s, color))}>
                      <span className="dot" style={{ background: color }} />
                    </button>
                  )}
                  <button
                    className="icon"
                    title="Oublier"
                    onClick={async () => {
                      const n = saved.filter((x) => x !== s);
                      setSaved(n);
                      await saveSignatures(n);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="seg sig-tabs">
          {(['draw', 'type', 'image'] as const).map((m) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {{ draw: '✍ Dessiner', type: 'Aa Écrire', image: '🖼 Depuis une image' }[m]}
            </button>
          ))}
        </div>

        <div className="sig-ink-row">
          {INKS.map((i) => (
            <button key={i.c} className={`acc ${color === i.c ? 'active' : ''}`} style={{ background: i.c }} title={i.label} onClick={() => setColor(i.c)} />
          ))}
          <ColorPicker value={color} onChange={(c) => c && setColor(c)} title="Autre couleur d’encre" />
          {mode === 'draw' && (
            <div className="seg ie-seg">
              {WEIGHTS.map((w) => (
                <button key={w.v} className={weight === w.v ? 'active' : ''} onClick={() => setWeight(w.v)}>
                  {w.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {mode === 'draw' && (
          <>
            <svg
              ref={pad}
              className="sig-pad"
              viewBox={`0 0 ${PAD_W} ${PAD_H}`}
              style={{ touchAction: 'none' }}
              onPointerDown={(e) => {
                if (e.pointerType === 'pen') penSeen.current = true;
                (e.target as Element).setPointerCapture(e.pointerId);
                setCurrent([pt(e)]);
              }}
              onPointerMove={(e) => {
                if (!current) return;
                const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []) as PointerEvent[];
                const add = (evs.length ? evs : [e.nativeEvent]).map(pt);
                setCurrent((c) => (c ? [...c, ...add] : c));
              }}
              onPointerUp={() => {
                if (current) setStrokes((s) => [...s, current]);
                setCurrent(null);
              }}
              onPointerCancel={() => setCurrent(null)}
            >
              <line x1="30" x2={PAD_W - 30} y1={PAD_H - 50} y2={PAD_H - 50} className="sig-baseline" />
              <g fill={color}>
                {strokes.map((s, i) => (
                  <path key={i} d={s.length > 1 ? strokePath(s, inkOpts) : strokePath([s[0], [s[0][0] + 0.5, s[0][1] + 0.5, s[0][2]]], inkOpts)} />
                ))}
                {current && current.length > 1 && <path d={strokePath(current, inkOpts, false)} />}
              </g>
              {!strokes.length && !current && (
                <text x={PAD_W / 2} y={PAD_H / 2} textAnchor="middle" className="sig-hint">
                  Signez ici avec la souris, le doigt ou le stylet
                </text>
              )}
            </svg>
            <div className="row">
              <button onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}>
                ↶ Annuler le trait
              </button>
              <button onClick={() => setStrokes([])} disabled={!strokes.length}>
                Effacer
              </button>
              <span style={{ flex: 1 }} />
              <button
                className="primary"
                disabled={!strokes.length}
                onClick={() => {
                  const svg = strokesToSvg(strokes, inkOpts, color);
                  if (svg) finish(svgToDataUrl(svg));
                }}
              >
                Utiliser
              </button>
            </div>
          </>
        )}

        {mode === 'type' && (
          <>
            <input className="typed-sig" placeholder="Votre nom" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            <div className="sig-fonts">
              {SIG_FONTS.map((f) => (
                <button key={f.id} className={`sig-font ${font === f.id ? 'active' : ''}`} onClick={() => setFont(f.id)}>
                  <span style={{ fontFamily: f.css }}>{typed.trim() || 'Signature'}</span>
                  <small>{f.label}</small>
                </button>
              ))}
            </div>
            <div className="sig-preview">{typedSvg ? <img src={svgToDataUrl(typedSvg)} alt="Aperçu" /> : <small className="muted">Aperçu de votre signature</small>}</div>
            <button className="primary" disabled={!typedSvg} onClick={() => typedSvg && finish(svgToDataUrl(typedSvg))}>
              Utiliser
            </button>
          </>
        )}

        {mode === 'image' && (
          <>
            <p className="muted small">
              Photo ou scan d’une signature (ou d’un logo) sur fond clair : elle est <b>vectorisée</b> — le fond disparaît et le tracé devient net à toutes les tailles.
            </p>
            <label className="file-btn">
              Choisir une image…
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  setErr(null);
                  setBusy('Vectorisation…');
                  try {
                    setPreview(svgToDataUrl(await traceToSvg(f, null)));
                  } catch (x) {
                    setErr((x as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            </label>
            {busy && <small className="muted">⏳ {busy}</small>}
            {err && <p className="error">{err}</p>}
            {preview && (
              <>
                <div className="sig-preview checker">
                  <img src={preview} alt="Signature vectorisée" />
                </div>
                <div className="row">
                  <button onClick={() => setPreview(recolorSvg(preview, color))}>Mettre dans la couleur choisie</button>
                  <span style={{ flex: 1 }} />
                  <button className="primary" onClick={() => finish(preview)}>
                    Utiliser
                  </button>
                </div>
              </>
            )}
          </>
        )}
        <p className="muted">Ensuite, cliquez sur la page pour placer la signature. Outil « Déplacer » (G) ou clic droit → Modifier pour la redimensionner.</p>
      </div>
    </div>
  );
}
