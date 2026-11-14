import { ColorPicker } from './ColorPicker';

export type FontFam = 'sans' | 'serif' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  fontFamily: FontFam;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextAlign;
  color: string;
  bg: string | null;
}

export const FONT_CSS: Record<FontFam, string> = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};

export const FONT_LABEL: Record<FontFam, string> = {
  sans: 'Helvetica',
  serif: 'Times',
  mono: 'Courier',
};

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

/** Largeur (points) de la ligne la plus longue, mesurée avec la police d'affichage. */
let ctx: CanvasRenderingContext2D | null = null;
export function measureText(text: string, s: Pick<TextStyle, 'fontFamily' | 'fontSize' | 'bold' | 'italic'>) {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * s.fontSize * 0.55;
  ctx.font = `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${s.fontSize}px ${FONT_CSS[s.fontFamily]}`;
  return Math.max(...text.split('\n').map((l) => ctx!.measureText(l).width), s.fontSize);
}

const AlignIcon = ({ a }: { a: TextAlign }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    {a === 'left' && <path d="M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h7" />}
    {a === 'center' && <path d="M2 3.5h12M4 6.5h8M2 9.5h12M4.5 12.5h7" />}
    {a === 'right' && <path d="M2 3.5h12M6 6.5h8M2 9.5h12M7 12.5h7" />}
  </svg>
);

interface Props {
  value: TextStyle;
  onChange: (s: TextStyle) => void;
  /** le fond peut-il être « aucun » (transparent) */
  bgOptional?: boolean;
}

/** Barre de mise en forme du texte : police, taille, gras, italique, souligné, alignement, couleurs. */
export function TextStyleBar({ value: v, onChange, bgOptional = true }: Props) {
  const set = (p: Partial<TextStyle>) => onChange({ ...v, ...p });
  const keep = (e: React.MouseEvent) => e.preventDefault(); // garde le focus dans la zone de texte
  return (
    <div className="text-style-bar" role="toolbar" aria-label="Mise en forme du texte">
      <select
        className="tsb-font"
        value={v.fontFamily}
        onChange={(e) => set({ fontFamily: e.target.value as FontFam })}
        title="Police"
        style={{ fontFamily: FONT_CSS[v.fontFamily] }}
      >
        {(Object.keys(FONT_LABEL) as FontFam[]).map((f) => (
          <option key={f} value={f} style={{ fontFamily: FONT_CSS[f] }}>
            {FONT_LABEL[f]}
          </option>
        ))}
      </select>
      <input
        className="tsb-size"
        type="number"
        min={4}
        max={144}
        step={0.5}
        list="nova-font-sizes"
        value={v.fontSize}
        onChange={(e) => set({ fontSize: Math.max(4, Math.min(144, +e.target.value || 12)) })}
        title="Taille (pt)"
      />
      <datalist id="nova-font-sizes">
        {SIZES.map((s) => <option key={s} value={s} />)}
      </datalist>
      <div className="seg tsb-seg">
        <button onMouseDown={keep} className={v.bold ? 'active' : ''} onClick={() => set({ bold: !v.bold })} title="Gras (Ctrl+B)"><b>G</b></button>
        <button onMouseDown={keep} className={v.italic ? 'active' : ''} onClick={() => set({ italic: !v.italic })} title="Italique (Ctrl+I)"><i style={{ fontFamily: 'Georgia, serif' }}>I</i></button>
        <button onMouseDown={keep} className={v.underline ? 'active' : ''} onClick={() => set({ underline: !v.underline })} title="Souligné (Ctrl+U)"><u>S</u></button>
      </div>
      <div className="seg tsb-seg">
        {(['left', 'center', 'right'] as TextAlign[]).map((a) => (
          <button key={a} onMouseDown={keep} className={v.align === a ? 'active' : ''} onClick={() => set({ align: a })} title={{ left: 'Aligner à gauche', center: 'Centrer', right: 'Aligner à droite' }[a]}>
            <AlignIcon a={a} />
          </button>
        ))}
      </div>
      <ColorPicker value={v.color} onChange={(c) => c && set({ color: c })} title="Couleur du texte" glyph="A" />
      <ColorPicker value={v.bg} onChange={(c) => set({ bg: c ?? (bgOptional ? null : '#ffffff') })} title="Couleur de fond (surlignage)" allowNone={bgOptional} glyph="▤" />
    </div>
  );
}

/** Raccourcis Ctrl+B / I / U dans une zone de saisie. Renvoie true si traité. */
export function styleShortcut(e: React.KeyboardEvent, v: TextStyle, onChange: (s: TextStyle) => void) {
  if (!(e.ctrlKey || e.metaKey)) return false;
  const k = e.key.toLowerCase();
  if (k === 'b') onChange({ ...v, bold: !v.bold });
  else if (k === 'i') onChange({ ...v, italic: !v.italic });
  else if (k === 'u') onChange({ ...v, underline: !v.underline });
  else return false;
  e.preventDefault();
  return true;
}
