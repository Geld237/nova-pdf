import { get, set, keys, del } from 'idb-keyval';
import type { Annotation } from './types';

/** Mémoire de lecture : annotations et position, conservées localement (IndexedDB). */
export interface DocMemory {
  fingerprint: string;
  name: string;
  annotations: Annotation[];
  lastPage: number;
  updatedAt: number;
}

const key = (fp: string) => `doc:${fp}`;

export async function loadMemory(fp: string): Promise<DocMemory | undefined> {
  try {
    return await get(key(fp));
  } catch {
    return undefined;
  }
}

export async function saveMemory(m: DocMemory) {
  try {
    await set(key(m.fingerprint), m);
  } catch {
    /* stockage indisponible */
  }
}

export async function allMemories(): Promise<DocMemory[]> {
  try {
    const ks = (await keys()).filter((k) => String(k).startsWith('doc:'));
    const all = await Promise.all(ks.map((k) => get(k)));
    return (all.filter(Boolean) as DocMemory[]).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function forgetMemory(fp: string) {
  try {
    await del(key(fp));
  } catch {
    /* rien */
  }
}

export function loadSetting<T>(name: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`nova:${name}`);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting(name: string, value: unknown) {
  try {
    localStorage.setItem(`nova:${name}`, JSON.stringify(value));
  } catch {
    /* rien */
  }
}

/** Signatures enregistrées (images PNG en data URL). */
export async function loadSignatures(): Promise<string[]> {
  try {
    return (await get('signatures')) ?? [];
  } catch {
    return [];
  }
}

export async function saveSignatures(list: string[]) {
  try {
    await set('signatures', list);
  } catch {
    /* rien */
  }
}

/* ----- Notes ------------------------------------------------------------- */

export interface DocNotes {
  fingerprint: string;
  name: string;
  text: string;
  updatedAt: number;
}

export async function loadNotes(fp: string): Promise<DocNotes | undefined> {
  try {
    return await get(`notes:${fp}`);
  } catch {
    return undefined;
  }
}

export async function saveNotes(n: DocNotes) {
  try {
    await set(`notes:${n.fingerprint}`, n);
  } catch {
    /* rien */
  }
}

export async function allNotes(): Promise<DocNotes[]> {
  try {
    const ks = (await keys()).filter((k) => String(k).startsWith('notes:'));
    const all = (await Promise.all(ks.map((k) => get(k)))) as DocNotes[];
    return all.filter((n) => n?.text?.trim()).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Ajoute un bloc à la fin des notes d'un document (utilisé par l'assistant IA). */
export async function appendNote(fp: string, name: string, block: string) {
  const cur = await loadNotes(fp);
  const text = `${cur?.text?.trimEnd() ?? ''}${cur?.text?.trim() ? '\n\n' : ''}${block}`;
  await saveNotes({ fingerprint: fp, name, text, updatedAt: Date.now() });
  window.dispatchEvent(new CustomEvent('nova:notes-changed', { detail: fp }));
}

/* ----- Sauvegarde complète ------------------------------------------------- */

export async function exportAllData(): Promise<string> {
  const ks = await keys();
  const entries = await Promise.all(ks.map(async (k) => [String(k), await get(k)]));
  const ls: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('nova:')) ls[k] = localStorage.getItem(k)!;
    }
  } catch {
    /* rien */
  }
  return JSON.stringify({ app: 'nova-pdf', version: 1, exportedAt: new Date().toISOString(), idb: Object.fromEntries(entries), localStorage: ls });
}

export async function importAllData(json: string): Promise<number> {
  const data = JSON.parse(json);
  if (data.app !== 'nova-pdf') throw new Error("Ce fichier n'est pas une sauvegarde Nova PDF");
  const idb = Object.entries(data.idb ?? {});
  for (const [k, v] of idb) await set(k, v);
  try {
    for (const [k, v] of Object.entries(data.localStorage ?? {})) localStorage.setItem(k, String(v));
  } catch {
    /* rien */
  }
  return idb.length;
}

export async function clearAllData() {
  const { clear } = await import('idb-keyval');
  await clear();
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('nova:'))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* rien */
  }
}

/* ----- Paramètres de l'application ---------------------------------------- */

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  defaultFit: 'width' | 'page' | 'actual';
  highlightColor: string;
  resumeLastPage: boolean;
  rememberAnnotations: boolean;
  confirmClose: boolean;
  ocrLang: string;
  autoCheckUpdates: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  defaultFit: 'width',
  highlightColor: '#ffeb3b',
  resumeLastPage: true,
  rememberAnnotations: true,
  confirmClose: true,
  ocrLang: 'fra+eng',
  autoCheckUpdates: true,
};
