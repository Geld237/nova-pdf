import { del, get, keys, set } from 'idb-keyval';
import type { PageText } from './types';

/** Bibliothèque locale : les PDF sont conservés dans le navigateur (IndexedDB). */
export interface LibItem {
  id: string; // empreinte pdf.js
  name: string;
  folder: string; // "" = racine ; "Cours/Chimie" = sous-dossier
  tags: string[];
  size: number;
  pages: number;
  addedAt: number;
  openedAt: number;
  favorite: boolean;
}

const META = (id: string) => `lib:${id}`;
const FILE = (id: string) => `libfile:${id}`;
const TEXT = (id: string) => `libtext:${id}`;

export async function listLibrary(): Promise<LibItem[]> {
  try {
    const ks = (await keys()).filter((k) => String(k).startsWith('lib:'));
    const items = (await Promise.all(ks.map((k) => get(k)))) as LibItem[];
    return items.filter(Boolean).sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export async function addToLibrary(item: Omit<LibItem, 'addedAt' | 'openedAt' | 'folder' | 'tags' | 'favorite'> & Partial<LibItem>, bytes: Uint8Array) {
  try {
    const prev = (await get(META(item.id))) as LibItem | undefined;
    const meta: LibItem = {
      folder: '', tags: [], favorite: false, addedAt: Date.now(), ...prev, ...item, openedAt: Date.now(),
    };
    await set(META(item.id), meta);
    await set(FILE(item.id), bytes);
    window.dispatchEvent(new Event('nova:library-changed'));
  } catch {
    /* quota dépassé : la bibliothèque reste partielle */
  }
}

export async function updateLibItem(id: string, patch: Partial<LibItem>) {
  const prev = (await get(META(id))) as LibItem | undefined;
  if (!prev) return;
  await set(META(id), { ...prev, ...patch });
  window.dispatchEvent(new Event('nova:library-changed'));
}

export async function saveLibText(id: string, texts: PageText[]) {
  try {
    await set(TEXT(id), texts);
  } catch {
    /* rien */
  }
}

export async function getLibText(id: string): Promise<PageText[] | undefined> {
  try {
    return await get(TEXT(id));
  } catch {
    return undefined;
  }
}

export async function getLibFile(id: string): Promise<Uint8Array | undefined> {
  try {
    return await get(FILE(id));
  } catch {
    return undefined;
  }
}

export async function removeFromLibrary(id: string) {
  await Promise.all([del(META(id)), del(FILE(id)), del(TEXT(id))]);
  window.dispatchEvent(new Event('nova:library-changed'));
}

export interface LibHit {
  item: LibItem;
  page: number;
  snippet: string;
}

/** Recherche plein texte dans toute la bibliothèque. */
export async function searchLibrary(query: string, limit = 200): Promise<LibHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const items = await listLibrary();
  const out: LibHit[] = [];
  for (const item of items) {
    if (item.name.toLowerCase().includes(q)) out.push({ item, page: 0, snippet: '(nom du fichier)' });
    const texts = await getLibText(item.id);
    for (const t of texts ?? []) {
      const hay = t.text.toLowerCase();
      let i = hay.indexOf(q);
      let perPage = 0;
      while (i >= 0 && perPage < 3) {
        out.push({ item, page: t.page, snippet: t.text.slice(Math.max(0, i - 50), i + q.length + 70).replace(/\s+/g, ' ') });
        i = hay.indexOf(q, i + q.length);
        perPage++;
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}
