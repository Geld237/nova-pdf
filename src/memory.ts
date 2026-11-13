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
