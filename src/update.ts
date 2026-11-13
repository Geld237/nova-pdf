import { registerSW } from 'virtual:pwa-register';

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
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
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
