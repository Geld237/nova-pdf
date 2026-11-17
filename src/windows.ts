import { del, get, set } from 'idb-keyval';
import type { Annotation } from './types';
import { isCapacitor, isTauri } from './platform';

/* Plusieurs fenêtres : ouvrir un document dans une nouvelle fenêtre (ou un nouvel onglet du navigateur),
   détacher un onglet en le faisant glisser hors de la fenêtre, le rattacher en le déposant sur une autre barre d'onglets.
   Le document passe d'une fenêtre à l'autre par le stockage local (IndexedDB), partagé par toutes les fenêtres. */

export interface DocTransfer {
  name: string;
  bytes: Uint8Array;
  path?: string;
  annotations: Annotation[];
  page: number;
  dirty: boolean;
  handle?: FileSystemFileHandle;
}

export const TAB_MIME = 'application/x-nova-tab';
export const canMultiWindow = !isCapacitor;

const key = (t: string) => `nova:transfer:${t}`;

// fenêtre ouverte par Nova PDF (et non par l'utilisateur) : on s'en souvient même après avoir nettoyé l'adresse
try {
  if (new URLSearchParams(location.search).has('win')) sessionStorage.setItem('nova:secondary', '1');
} catch {
  /* stockage indisponible */
}

export const newToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export async function stashDoc(t: DocTransfer, token = newToken()): Promise<string> {
  await set(key(token), t);
  return token;
}

/** Récupère (une seule fois) un document confié par une autre fenêtre. */
export async function takeDoc(token: string): Promise<DocTransfer | undefined> {
  const t = await get<DocTransfer>(key(token));
  if (t) await del(key(token));
  return t;
}

/** Le document confié a-t-il été repris par une autre fenêtre ? (on attend un peu la fenêtre qui reçoit) */
export async function wasTaken(token: string, waitMs = 900): Promise<boolean> {
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (!(await get(key(token)))) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export const dropStash = (token: string) => del(key(token)).catch(() => {});

/** Ouvre une nouvelle fenêtre de Nova PDF. `query` : transfer=…, lib=…, ou rien (fenêtre vide). */
export async function openWindow(query: Record<string, string>, opts: { title?: string; x?: number; y?: number; tab?: boolean } = {}): Promise<boolean> {
  const qs = new URLSearchParams({ ...query, win: '1' }).toString();
  if (isTauri) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const label = `doc-${Date.now().toString(36)}`;
      const w = new WebviewWindow(label, {
        url: `index.html${qs ? `?${qs}` : ''}`,
        title: opts.title ? `${opts.title} — Nova PDF` : 'Nova PDF',
        width: 1200,
        height: 860,
        ...(opts.x != null && opts.y != null ? { x: Math.max(0, opts.x - 120), y: Math.max(0, opts.y - 20) } : { center: true }),
      });
      return await new Promise<boolean>((res) => {
        w.once('tauri://created', () => res(true));
        w.once('tauri://error', () => res(false));
      });
    } catch {
      return false;
    }
  }
  const url = `${location.origin}${location.pathname}${qs ? `?${qs}` : ''}`;
  if (opts.tab) return !!window.open(url, '_blank');
  const left = opts.x != null ? Math.max(0, opts.x - 120) : (window.screenX ?? 0) + 40;
  const top = opts.y != null ? Math.max(0, opts.y - 20) : (window.screenY ?? 0) + 40;
  return !!window.open(url, `nova-${Date.now()}`, `popup,width=1200,height=860,left=${left},top=${top}`);
}

/** L'onglet a-t-il été lâché hors de la fenêtre ? */
export function droppedOutside(e: { clientX: number; clientY: number; screenX: number; screenY: number }) {
  const outClient = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
  const sx = window.screenX ?? 0;
  const sy = window.screenY ?? 0;
  const outScreen =
    (e.screenX || e.screenY) !== 0 && (e.screenX < sx || e.screenY < sy || e.screenX > sx + window.outerWidth || e.screenY > sy + window.outerHeight);
  return outClient || outScreen;
}

/** Ferme une fenêtre secondaire devenue vide (son dernier onglet est parti ailleurs). La fenêtre principale reste. */
export async function closeIfSecondary() {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      if (w.label !== 'main') await w.close();
    } catch {
      /* rien */
    }
  } else if (sessionStorage.getItem('nova:secondary') || window.opener) window.close();
}
