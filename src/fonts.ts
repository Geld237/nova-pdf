import { del, get, set } from 'idb-keyval';
import type { TextStyle } from './components/TextStyleBar';

/* Polices personnelles (.ttf/.otf) et styles de texte enregistrés. */

export interface CustomFont {
  id: string; // « custom:xxxx »
  name: string;
}

const LIST_KEY = 'nova:fonts';
const listeners = new Set<() => void>();
let cache: CustomFont[] = [];
const loaded = new Set<string>();

export const customFonts = () => cache;
export const onFontsChange = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const emit = () => listeners.forEach((l) => l());

/** CSS font-family utilisable dans l'interface pour une police perso. */
export const customCss = (id: string) => `"nova-${id.slice(7)}", sans-serif`;

async function register(f: CustomFont) {
  if (loaded.has(f.id) || typeof FontFace === 'undefined') return;
  const bytes = await get<Uint8Array>(`nova:font:${f.id}`);
  if (!bytes) return;
  try {
    const ff = new FontFace(`nova-${f.id.slice(7)}`, bytes.slice().buffer as ArrayBuffer);
    await ff.load();
    document.fonts.add(ff);
    loaded.add(f.id);
  } catch {
    /* police illisible */
  }
}

export async function initFonts() {
  cache = (await get<CustomFont[]>(LIST_KEY).catch(() => undefined)) ?? [];
  await Promise.all(cache.map(register));
  emit();
}

export async function addFont(file: File): Promise<CustomFont> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sig = String.fromCharCode(...bytes.slice(0, 4));
  if (!['\0\x01\0\0', 'OTTO', 'true'].includes(sig)) throw new Error('Format non reconnu : choisissez un fichier .ttf ou .otf.');
  const f: CustomFont = { id: `custom:${Date.now().toString(36)}`, name: file.name.replace(/\.(ttf|otf)$/i, '') };
  await set(`nova:font:${f.id}`, bytes);
  cache = [...cache, f];
  await set(LIST_KEY, cache);
  await register(f);
  emit();
  return f;
}

export async function removeFont(id: string) {
  await del(`nova:font:${id}`);
  cache = cache.filter((f) => f.id !== id);
  await set(LIST_KEY, cache);
  emit();
}

export const fontBytes = (id: string) => get<Uint8Array>(`nova:font:${id}`);

/* ---- Styles enregistrés ---- */
export interface SavedStyle {
  name: string;
  style: TextStyle;
}
const STYLE_KEY = 'nova:text-styles';
export const BUILTIN_STYLES: SavedStyle[] = [
  { name: 'Titre', style: { fontFamily: 'sans', fontSize: 24, bold: true, italic: false, underline: false, align: 'left', color: '#1c1c1e', bg: null } },
  { name: 'Commentaire', style: { fontFamily: 'sans', fontSize: 12, bold: false, italic: true, underline: false, align: 'left', color: '#3949ab', bg: null } },
  { name: 'Correction en rouge', style: { fontFamily: 'sans', fontSize: 13, bold: true, italic: false, underline: false, align: 'left', color: '#e53935', bg: null } },
  { name: 'Surligné jaune', style: { fontFamily: 'sans', fontSize: 13, bold: false, italic: false, underline: false, align: 'left', color: '#1c1c1e', bg: '#fff59d' } },
  { name: 'Machine à écrire', style: { fontFamily: 'mono', fontSize: 12, bold: false, italic: false, underline: false, align: 'left', color: '#1c1c1e', bg: null } },
];
export function savedStyles(): SavedStyle[] {
  try {
    return JSON.parse(localStorage.getItem(STYLE_KEY) || '[]');
  } catch {
    return [];
  }
}
export function saveStyle(s: SavedStyle) {
  const l = [s, ...savedStyles().filter((x) => x.name !== s.name)].slice(0, 30);
  localStorage.setItem(STYLE_KEY, JSON.stringify(l));
}
export function deleteStyle(name: string) {
  localStorage.setItem(STYLE_KEY, JSON.stringify(savedStyles().filter((x) => x.name !== name)));
}
