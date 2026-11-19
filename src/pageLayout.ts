import type { Annotation, Rect } from './types';

/** Une page du document final : venant du document ouvert (doc 0) ou d'un PDF inséré (doc 1…) ; src -1 = page blanche. */
export interface LayoutItem {
  doc: number;
  src: number;
  rotate: number;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Fait pivoter la géométrie d'une annotation (sens horaire) sur une page de taille W×H (avant rotation). */
function rotateAnn(a: Annotation, deg: number, W: number, H: number): Annotation {
  const d = ((deg % 360) + 360) % 360;
  if (!d) return a;
  const pt = ([x, y]: [number, number]): [number, number] => (d === 90 ? [H - y, x] : d === 180 ? [W - x, H - y] : [y, W - x]);
  const rc = (r: Rect): Rect =>
    d === 90 ? { x: H - r.y - r.h, y: r.x, w: r.h, h: r.w } : d === 180 ? { x: W - r.x - r.w, y: H - r.y - r.h, w: r.w, h: r.h } : { x: r.y, y: W - r.x - r.w, w: r.h, h: r.w };
  const keepSize = a.kind === 'text' || a.kind === 'note' || a.kind === 'image' || a.kind === 'field';
  const out: Annotation = { ...a };
  if (a.rect) {
    if (keepSize) {
      // texte, note, signature : on garde le sens de lecture, seule la position tourne (autour du centre)
      const [cx, cy] = pt([a.rect.x + a.rect.w / 2, a.rect.y + a.rect.h / 2]);
      out.rect = { ...a.rect, x: cx - a.rect.w / 2, y: cy - a.rect.h / 2 };
    } else out.rect = rc(a.rect);
  }
  if (a.rects) out.rects = a.rects.map(rc);
  if (a.points) out.points = a.points.map(pt);
  return out;
}

/**
 * Annotations du document ouvert replacées selon la nouvelle disposition des pages :
 * pages déplacées, dupliquées (annotations copiées), supprimées (annotations retirées), pivotées.
 */
export function remapAnnotations(anns: Annotation[], items: LayoutItem[], sizes: { w: number; h: number }[]): Annotation[] {
  const byPage = new Map<number, Annotation[]>();
  for (const a of anns) byPage.set(a.page, [...(byPage.get(a.page) ?? []), a]);
  const out: Annotation[] = [];
  const used = new Set<number>();
  items.forEach((it, i) => {
    if (it.doc !== 0 || it.src < 0) return;
    const list = byPage.get(it.src) ?? [];
    const first = !used.has(it.src);
    used.add(it.src);
    const sz = sizes[it.src] ?? { w: 595, h: 842 };
    for (const a of list) out.push(rotateAnn({ ...a, page: i, id: first ? a.id : newId() }, it.rotate, sz.w, sz.h));
  });
  return out;
}

/** Disposition « identité » d'un document de n pages. */
export const identity = (n: number): LayoutItem[] => Array.from({ length: n }, (_, i) => ({ doc: 0, src: i, rotate: 0 }));

/** Déplace les pages `from` (indices) pour les insérer avant la position `to` (indice dans la liste d'origine). */
export function movePages<T>(list: T[], from: number[], to: number): T[] {
  const set = new Set(from);
  const moving = list.filter((_, i) => set.has(i));
  const before = list.slice(0, to).filter((_, i) => !set.has(i));
  const after = list.slice(to).filter((_, i) => !set.has(i + to));
  return [...before, ...moving, ...after];
}
