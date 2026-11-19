import { assemblePages, imagesToPdf } from './pdf/tools';
import type { Annotation } from './types';

/* Opérations sur les pages appliquées DIRECTEMENT au document (comme les vignettes d'Acrobat),
   avec annuler / rétablir. Les annotations suivent leurs pages (déplacées, dupliquées). */

export interface PItem {
  doc: number; // 0 = document ouvert, 1… = PDF inséré
  src: number; // index de page, -1 = page blanche
  rotate: number;
}

export interface PageCtx {
  docId: string;
  name: string;
  numPages: number;
  annotations: Annotation[];
  getBytesRaw: () => Promise<Uint8Array>; // sans les annotations
  getBytes: () => Promise<Uint8Array>; // annotations intégrées
  /** remplace le document en gardant (ou non) des annotations modifiables */
  replaceKeep: (bytes: Uint8Array, label: string, annotations: Annotation[]) => Promise<void>;
  notify: (m: string) => void;
}

interface Snapshot {
  bytes: Uint8Array;
  annotations: Annotation[];
  label: string;
}
const undoStacks = new Map<string, Snapshot[]>();
const redoStacks = new Map<string, Snapshot[]>();
const listeners = new Set<() => void>();
export const onPageHistory = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const emit = () => listeners.forEach((l) => l());
export const canUndoPages = (docId: string) => (undoStacks.get(docId)?.length ?? 0) > 0;
export const canRedoPages = (docId: string) => (redoStacks.get(docId)?.length ?? 0) > 0;

export const identity = (n: number): PItem[] => Array.from({ length: n }, (_, i) => ({ doc: 0, src: i, rotate: 0 }));

/** Applique un nouvel ordre de pages au document ouvert. */
export async function commitPages(ctx: PageCtx, items: PItem[], sources: Uint8Array[], label: string) {
  if (!items.length) return ctx.notify('Un document doit garder au moins une page.');
  const raw = await ctx.getBytesRaw();
  // annotations des pages pivotées : on les intègre au contenu (leurs coordonnées ne suivraient pas la rotation)
  const rotatedWithAnns = items.some((it) => it.rotate && it.doc === 0 && ctx.annotations.some((a) => a.page === it.src));
  const base = rotatedWithAnns ? await ctx.getBytes() : raw;
  const bytes = await assemblePages(base, sources, items);
  const anns: Annotation[] = [];
  if (!rotatedWithAnns) {
    const seen = new Set<number>();
    items.forEach((it, j) => {
      if (it.doc !== 0 || it.src < 0) return;
      const dup = seen.has(it.src);
      seen.add(it.src);
      for (const a of ctx.annotations) if (a.page === it.src) anns.push({ ...a, page: j, id: dup ? crypto.randomUUID() : a.id });
    });
  }
  pushUndo(ctx.docId, { bytes: raw, annotations: ctx.annotations, label });
  redoStacks.set(ctx.docId, []);
  await ctx.replaceKeep(bytes, label, anns);
  emit();
}

function pushUndo(id: string, s: Snapshot) {
  const st = undoStacks.get(id) ?? [];
  st.push(s);
  if (st.length > 20) st.shift();
  undoStacks.set(id, st);
}

export async function undoPages(ctx: PageCtx) {
  const s = undoStacks.get(ctx.docId)?.pop();
  if (!s) return;
  const r = redoStacks.get(ctx.docId) ?? [];
  r.push({ bytes: await ctx.getBytesRaw(), annotations: ctx.annotations, label: s.label });
  redoStacks.set(ctx.docId, r);
  await ctx.replaceKeep(s.bytes, `Annulé : ${s.label}`, s.annotations);
  emit();
}
export async function redoPages(ctx: PageCtx) {
  const s = redoStacks.get(ctx.docId)?.pop();
  if (!s) return;
  pushUndo(ctx.docId, { bytes: await ctx.getBytesRaw(), annotations: ctx.annotations, label: s.label });
  await ctx.replaceKeep(s.bytes, `Rétabli : ${s.label}`, s.annotations);
  emit();
}

/** Fichiers (PDF ou images) → octets PDF prêts à être insérés. */
export async function filesToPdfs(files: File[]): Promise<{ name: string; bytes: Uint8Array }[]> {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  for (const f of files) if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  if (imgs.length) out.push({ name: imgs.length > 1 ? `${imgs.length} images` : imgs[0].name, bytes: await imagesToPdf(imgs) });
  return out;
}

// presse-papiers de pages (copier / couper / coller entre documents ou dans le même)
export interface PageClip {
  bytes: Uint8Array;
  count: number;
}
let clip: PageClip | null = null;
export const setPageClip = (c: PageClip | null) => {
  clip = c;
  emit();
};
export const pageClip = () => clip;
