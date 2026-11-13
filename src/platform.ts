/**
 * Couche plateforme : le même code tourne sur le web (PWA), en application
 * de bureau (Tauri : Windows, macOS, Linux) et en application mobile
 * (Capacitor : Android, iOS). Seules l'ouverture et l'enregistrement de
 * fichiers diffèrent.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const isCapacitor = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
export const isNative = isTauri || isCapacitor;

export function platformName(): string {
  if (isCapacitor) return window.Capacitor?.getPlatform?.() === 'ios' ? 'iOS' : 'Android';
  if (isTauri) {
    const ua = navigator.userAgent;
    return /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : 'Linux';
  }
  return 'Web';
}

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  path?: string; // chemin natif (bureau) pour réenregistrer sur place
}

const toBytes = async (data: Uint8Array | Blob | string, type: string): Promise<Uint8Array> =>
  data instanceof Uint8Array
    ? data
    : new Uint8Array(await (data instanceof Blob ? data : new Blob([data], { type })).arrayBuffer());

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

const extOf = (name: string) => (name.split('.').pop() ?? 'bin').toLowerCase();

/** Ouvre des PDF avec la boîte de dialogue native (bureau). Renvoie null hors Tauri. */
export async function nativeOpenPdfs(): Promise<OpenedFile[] | null> {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const sel = await open({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!sel) return [];
  const paths = Array.isArray(sel) ? sel : [sel];
  return Promise.all(paths.map((p) => readNativeFile(String(p))));
}

export async function readNativeFile(path: string): Promise<OpenedFile> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  return { name: path.split(/[\\/]/).pop() ?? 'document.pdf', bytes: await readFile(path), path };
}

export async function writeNativeFile(path: string, bytes: Uint8Array) {
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  await writeFile(path, bytes);
}

/**
 * Enregistre un fichier produit par l'app.
 * - Web : téléchargement ;
 * - Bureau : boîte « Enregistrer sous » native, renvoie le chemin ;
 * - Mobile : fichier temporaire + feuille de partage (Fichiers, Drive, mail…).
 */
export async function saveFile(data: Uint8Array | Blob | string, name: string, type = 'application/pdf'): Promise<string | null> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const ext = extOf(name);
    const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return null;
    await writeNativeFile(path, await toBytes(data, type));
    return path;
  }
  if (isCapacitor) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const res = await Filesystem.writeFile({
      path: `exports/${name}`,
      data: toBase64(await toBytes(data, type)),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({ title: name, files: [res.uri], dialogTitle: `Enregistrer ou partager « ${name} »` }).catch(() => {});
    return res.uri;
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return null;
}

/** Ouvre un lien externe dans le navigateur du système. */
export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}

/**
 * Fichiers transmis par le système (« Ouvrir avec Nova PDF », double-clic sur un .pdf).
 * Le rappel est appelé au démarrage puis à chaque nouvelle ouverture.
 */
export async function listenOpenedFiles(cb: (files: OpenedFile[]) => void) {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const handle = async (paths: string[]) => {
      const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
      if (pdfs.length) cb(await Promise.all(pdfs.map(readNativeFile)));
    };
    await listen<string[]>('open-files', (e) => handle(e.payload));
    handle(await invoke<string[]>('take_opened_files'));
  }
  if (isCapacitor) {
    const { App } = await import('@capacitor/app');
    const { Filesystem } = await import('@capacitor/filesystem');
    const handle = async (url?: string) => {
      if (!url) return;
      try {
        const r = await Filesystem.readFile({ path: url });
        const b64 = typeof r.data === 'string' ? r.data : await blobToBase64(r.data);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        cb([{ name: decodeURIComponent(url.split('/').pop() ?? 'document.pdf').replace(/\?.*$/, ''), bytes }]);
      } catch {
        /* fichier illisible */
      }
    };
    App.addListener('appUrlOpen', (e) => handle(e.url));
    const launch = await App.getLaunchUrl();
    handle(launch?.url);
  }
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.readAsDataURL(b);
  });
}

/** En natif, les liens externes doivent sortir de la WebView. */
export function interceptExternalLinks() {
  if (!isNative) return;
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.hasAttribute('download')) return;
      if (/^https?:/i.test(a.href) && a.target === '_blank') {
        e.preventDefault();
        openExternal(a.href);
      }
    },
    true,
  );
}
