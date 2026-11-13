import { registerSW } from 'virtual:pwa-register';
import { isNative } from './platform';

/** Gestion des mises à jour de l'application (service worker + vérification GitHub). */
export const APP_VERSION = __APP_VERSION__;
export const APP_COMMIT = __APP_COMMIT__;
export const BUILD_DATE = __BUILD_DATE__;
export const REPO = 'Geld237/nova-pdf';

type Listener = () => void;
const listeners = new Set<Listener>();
export const updateState = { needRefresh: false, offlineReady: false, checking: false, lastCheck: 0 };
let registration: ServiceWorkerRegistration | undefined;
let doUpdate: ((reload?: boolean) => Promise<void>) | null = null;

const emit = () => listeners.forEach((l) => l());
export const onUpdateState = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function initUpdates() {
  // Les applications natives sont mises à jour par leur installeur (GitHub Releases).
  if (isNative || !('serviceWorker' in navigator) || import.meta.env.DEV) return;
  doUpdate = registerSW({
    onNeedRefresh() {
      updateState.needRefresh = true;
      emit();
    },
    onOfflineReady() {
      updateState.offlineReady = true;
      emit();
    },
    onRegisteredSW(_url, reg) {
      registration = reg;
      // vérification automatique toutes les heures
      setInterval(() => reg?.update(), 60 * 60 * 1000);
    },
  });
}

/** Demande au navigateur de vérifier si une nouvelle version de l'app est publiée. */
export async function checkForAppUpdate(): Promise<boolean> {
  updateState.checking = true;
  emit();
  try {
    await registration?.update();
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    updateState.checking = false;
    updateState.lastCheck = Date.now();
    emit();
  }
  return updateState.needRefresh;
}

export async function applyAppUpdate() {
  if (doUpdate) await doUpdate(true);
  else location.reload();
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  date: string;
  url: string;
  assets: { name: string; url: string; size: number }[];
}

/** Dernière version publiée (installeurs Windows, macOS, Linux, Android, iOS). */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
  const j = await r.json();
  return {
    tag: j.tag_name,
    name: j.name || j.tag_name,
    date: j.published_at,
    url: j.html_url,
    assets: (j.assets ?? []).map((a: { name: string; browser_download_url: string; size: number }) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
}

/** Compare deux versions « 1.2.3 ». */
export function isNewer(remote: string, local: string): boolean {
  const a = remote.replace(/^v/, '').split('.').map(Number);
  const b = local.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export interface RemoteVersion {
  sha: string;
  message: string;
  date: string;
  url: string;
}

/** Dernière version publiée sur GitHub (branche main). */
export async function fetchLatestCommit(): Promise<RemoteVersion> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
  const j = await r.json();
  return {
    sha: j.sha,
    message: String(j.commit?.message ?? '').split('\n')[0],
    date: j.commit?.committer?.date ?? '',
    url: j.html_url,
  };
}

/* ----- Application de bureau : mise à jour automatique (Tauri) --------------- */

export interface NativeUpdate {
  version: string;
  notes?: string;
  install: (onProgress: (ratio: number) => void) => Promise<void>;
}

/** Vérifie s'il existe une version plus récente de l'application de bureau. */
export async function checkNativeUpdate(): Promise<NativeUpdate | null> {
  const { isTauri } = await import('./platform');
  if (!isTauri) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const u = await check();
  if (!u) return null;
  return {
    version: u.version,
    notes: u.body,
    install: async (onProgress) => {
      let total = 0;
      let done = 0;
      await u.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0;
        else if (e.event === 'Progress') {
          done += e.data.chunkLength;
          if (total) onProgress(done / total);
        } else if (e.event === 'Finished') onProgress(1);
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}
