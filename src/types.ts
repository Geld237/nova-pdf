export type ToolId =
  | 'select'
  | 'hand'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'text'
  | 'note'
  | 'signature'
  | 'redact'
  | 'eraser';

export type AnnKind =
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'text'
  | 'note'
  | 'image'
  | 'redact';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Une annotation. Toutes les coordonnées sont exprimées dans l'espace du
 * viewport pdf.js à l'échelle 1 (origine en haut à gauche de la page affichée).
 */
export interface Annotation {
  id: string;
  page: number; // index 0-based
  kind: AnnKind;
  color: string;
  opacity: number;
  strokeWidth: number;
  rects?: Rect[]; // highlight / underline / strike
  rect?: Rect; // rect / ellipse / text / note / image / redact
  points?: [number, number][]; // ink / arrow
  text?: string; // texte saisi ou texte surligné
  fontSize?: number;
  dataUrl?: string; // image (signature)
  createdAt: number;
}

export interface PageText {
  page: number;
  text: string;
}

export interface OutlineItem {
  title: string;
  page: number | null;
  items: OutlineItem[];
}

export interface SearchHit {
  page: number;
  snippet: string;
  index: number;
}
