import { useEffect, useRef } from 'react';
import type { Annotation } from '../types';
import { ColorPicker } from './ColorPicker';
import { ui } from '../dialogs';
import { isSvgUrl, recolorSvg, svgRatio, svgToDataUrl, traceToSvg } from '../vector';
import { TextStyleBar, measureText } from './TextStyleBar';

/* Petit inspecteur flottant : modifier une annotation déjà posée (couleur, épaisseur, opacité, texte…). */

const KIND_LABEL: Record<string, string> = {
  highlight: 'Surlignage', underline: 'Soulignement', strike: 'Texte barré', ink: 'Dessin', rect: 'Rectangle', ellipse: 'Ellipse',
  arrow: 'Flèche', text: 'Texte', note: 'Note', image: 'Image', redact: 'Caviardage', whiteout: 'Correcteur', measure: 'Mesure',
  field: 'Champ', textedit: 'Texte modifié',
};
const STROKED = ['ink', 'rect', 'ellipse', 'arrow', 'underline', 'strike', 'measure'];
const QUICK = ['#ffeb3b', '#8bc34a', '#4fc3f7', '#f48fb1', '#ff9800', '#e53935', '#3949ab', '#212121'];

interface Props {
  ann: Annotation;
  pos: { x: number; y: number };
  onChange: (a: Annotation) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onFront: () => void;
  onClose: () => void;
}

export function AnnInspector({ ann: a, pos, onChange, onDelete, onDuplicate, onFront, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest?.('.color-pop, .dialog')) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target as HTMLElement).closest('input, textarea, select')) {
        onDelete();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true));
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose, onDelete]);

  const W = a.kind === 'text' ? 560 : 300;
  const left = Math.max(8, Math.min(pos.x - 20, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(pos.y + 14, window.innerHeight - 260));
  const colored = !['image', 'redact', 'whiteout', 'field', 'textedit'].includes(a.kind);

  return (
    <div ref={ref} className="ann-inspector" style={{ left, top, width: W }} role="dialog" aria-label="Modifier l’annotation">
      <div className="ai-head">
        <b>{a.kind === 'image' && isSvgUrl(a.dataUrl) ? 'Signature / tampon' : KIND_LABEL[a.kind] ?? 'Annotation'}</b>
        <button className="icon-btn" onClick={onClose} title="Fermer">✕</button>
      </div>

      {a.kind === 'text' ? (
        <TextStyleBar
          value={{ fontFamily: a.fontFamily ?? 'sans', fontSize: a.fontSize ?? 14, bold: !!a.bold, italic: !!a.italic, underline: !!a.underline, align: a.align ?? 'left', color: a.color, bg: a.bg ?? null }}
          onChange={(st) => {
            const n = { ...a, fontFamily: st.fontFamily, fontSize: st.fontSize, bold: st.bold, italic: st.italic, underline: st.underline, align: st.align, color: st.color, bg: st.bg ?? undefined };
            const lines = (a.text ?? '').split('\n').length;
            n.rect = { ...a.rect!, w: measureText(a.text ?? '', st) + 2, h: st.fontSize * 1.2 * lines };
            onChange(n);
          }}
        />
      ) : (
        colored && (
          <div className="ai-row">
            <span>Couleur</span>
            <div className="ai-swatches">
              {QUICK.map((c) => (
                <button key={c} className={`acc ${a.color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => onChange({ ...a, color: c })} title={c} />
              ))}
              <ColorPicker value={a.color} onChange={(c) => c && onChange({ ...a, color: c })} title="Carte des couleurs" />
            </div>
          </div>
        )
      )}

      {a.kind === 'image' && a.rect && (
        <>
          <label className="ai-row">
            <span>Largeur</span>
            <input
              type="range"
              min={20}
              max={560}
              step={2}
              value={Math.round(a.rect.w)}
              onChange={(e) => {
                const w = +e.target.value;
                const k = w / a.rect!.w;
                onChange({ ...a, rect: { ...a.rect!, w, h: a.rect!.h * k } });
              }}
            />
            <output>{Math.round((a.rect.w * 25.4) / 72)} mm</output>
          </label>
          {isSvgUrl(a.dataUrl) ? (
            <div className="ai-row">
              <span>Encre</span>
              <div className="ai-swatches">
                {['#1a3a8f', '#111111', '#0b5d3b', '#8e1b1b', '#e53935'].map((c) => (
                  <button key={c} className="acc" style={{ background: c }} title={c} onClick={() => onChange({ ...a, dataUrl: recolorSvg(a.dataUrl!, c) })} />
                ))}
                <ColorPicker value={null} onChange={(c) => c && onChange({ ...a, dataUrl: recolorSvg(a.dataUrl!, c) })} title="Autre couleur" />
              </div>
              <small className="muted">vectoriel ✓</small>
            </div>
          ) : (
            <button
              className="ai-vectorize"
              title="Pour une signature, un tampon ou un logo : fond supprimé, tracé net à toutes les tailles"
              onClick={async () => {
                try {
                  const svg = svgToDataUrl(await traceToSvg(a.dataUrl!, null));
                  const r = svgRatio(svg);
                  onChange({ ...a, dataUrl: svg, rect: { ...a.rect!, h: a.rect!.w / r } });
                } catch (e) {
                  ui.alert((e as Error).message);
                }
              }}
            >
              ✦ Vectoriser (signature, tampon, logo)
            </button>
          )}
        </>
      )}
      {STROKED.includes(a.kind) && (
        <label className="ai-row">
          <span>Épaisseur</span>
          <input type="range" min={0.5} max={16} step={0.5} value={a.strokeWidth} onChange={(e) => onChange({ ...a, strokeWidth: +e.target.value })} />
          <output>{a.strokeWidth} pt</output>
        </label>
      )}
      {a.kind !== 'redact' && a.kind !== 'field' && (
        <label className="ai-row">
          <span>Opacité</span>
          <input type="range" min={0.1} max={1} step={0.05} value={a.opacity} onChange={(e) => onChange({ ...a, opacity: +e.target.value })} />
          <output>{Math.round(a.opacity * 100)} %</output>
        </label>
      )}
      {(a.kind === 'note' || a.kind === 'text') && (
        <textarea className="ai-text" value={a.text ?? ''} rows={3} onChange={(e) => onChange({ ...a, text: e.target.value })} placeholder="Texte" />
      )}

      <div className="ai-actions">
        <button onClick={onDuplicate}>Dupliquer</button>
        <button onClick={onFront}>Premier plan</button>
        <button
          className="danger"
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          Supprimer
        </button>
      </div>
    </div>
  );
}
