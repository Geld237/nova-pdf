/**
 * Jeu d'icônes de l'application (Lucide, licence ISC) : trait fin et arrondi,
 * dans l'esprit des icônes macOS / iOS.
 */
import {
  Archive, ArrowRightLeft, Camera, ChevronRight, BookOpen, Bookmark, BookmarkPlus, ChevronLeft, Circle, ClipboardList, Combine, Copy, Crop,
  Droplets, Eraser, EyeOff, FileOutput, FilePlus2, FileSignature, FileText, FileType2, Files, FolderOpen,
  GalleryVertical, GitCompareArrows, GraduationCap, Hash, Highlighter, Image, ImageDown, Info, Languages, Layers,
  LayoutGrid, Library, ListOrdered, ListTree, Lock, LockOpen, Maximize, MessageSquareQuote, Mic, Minimize2, Minus,
  Monitor, Moon, MoonStar, MousePointer2, MoveUpRight, Notebook, NotebookPen, Paintbrush, Palette, PanelLeft,
  Paperclip, PenLine, Plus, Presentation, Printer, Quote, Redo2, RotateCcw, RotateCw, Rows3, Ruler, Save, SaveAll,
  Scaling, ScanLine, TextCursor, ImagePlus, Move, ScanText, Scissors, Search, Share2, ShieldCheck, Signature, Sparkles, Square, SquarePen, Stamp,
  StickyNote, Strikethrough, Sun, TextCursorInput, Trash2, Type, Underline, Undo2, Volume2, Wrench, X,
  type LucideIcon,
} from 'lucide-react';

export type { LucideIcon };

export const Icons = {
  // outils d'annotation
  select: MousePointer2, highlight: Highlighter, underline: Underline, strike: Strikethrough, ink: PenLine,
  rect: Square, ellipse: Circle, arrow: MoveUpRight, text: Type, note: StickyNote, signature: Signature,
  stamp: Stamp, edittext: TextCursor, image: ImagePlus, move: Move, whiteout: Paintbrush, measure: Ruler, field: TextCursorInput, redact: EyeOff, eraser: Eraser, snapshot: Camera,
  // barre du haut
  open: FolderOpen, save: Save, saveAs: SaveAll, print: Printer, undo: Undo2, redo: Redo2, sun: Sun, moon: Moon, mic: Mic,
  // barre de vue
  sidebar: PanelLeft, zoomOut: Minus, zoomIn: Plus, night: MoonStar, focus: Maximize, present: Presentation,
  translate: Languages, ruler: Rows3,
  // panneaux
  library: Library, ai: Sparkles, notes: NotebookPen, study: GraduationCap, reading: BookOpen, form: ClipboardList,
  organize: Files, tools: Wrench, share: Share2, settings: Info,
  // panneau latéral
  pages: GalleryVertical, outline: ListTree, search: Search, annotations: Highlighter, notebook: Notebook,
  // outils
  merge: Combine, split: Scissors, extract: FileOutput, grid: LayoutGrid, resize: Scaling, crop: Crop,
  create: FilePlus2, scan: ScanLine, convert: FileType2, export: ImageDown, ocr: ScanText, watermark: Droplets,
  pagenum: ListOrdered, bookmarks: Bookmark, attach: Paperclip, viewer: Monitor, flatten: Layers, protect: Lock,
  unlock: LockOpen, pii: ShieldCheck, meta: Info, compress: Minimize2, repair: Wrench, compare: GitCompareArrows,
  refs: Quote, archive: Archive,
  // menus contextuels
  copy: Copy, trash: Trash2, rotateCw: RotateCw, rotateCcw: RotateCcw, speak: Volume2, cite: MessageSquareQuote,
  card: BookmarkPlus, back: ChevronLeft, next: ChevronRight, close: X, palette: Palette, file: FileText, picture: Image, hash: Hash,
  sign: FileSignature, swap: ArrowRightLeft, edit: SquarePen,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof Icons;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const C = Icons[name];
  return <C size={size} strokeWidth={1.75} className={className} aria-hidden />;
}
