import { isTauri } from './platform';

/* Présentation sur deux écrans, comme PowerPoint :
   - détection des écrans (application de bureau : moniteurs Tauri ; navigateur : Window Management API) ;
   - fenêtre « public » ouverte EN PLEIN ÉCRAN sur l'autre écran ;
   - canal de communication entre la vue présentateur et la fenêtre public. */

export interface ScreenInfo {
  id: string;
  label: string;
  x: number; // coordonnées logiques (CSS px)
  y: number;
  w: number;
  h: number;
  primary: boolean;
  current: boolean;
}

/** Écrans disponibles. `ask` : autorise la demande de permission du navigateur (gestion des fenêtres). */
export async function listScreens(ask = false): Promise<ScreenInfo[]> {
  if (isTauri) {
    try {
      const { availableMonitors, currentMonitor, primaryMonitor } = await import('@tauri-apps/api/window');
      const [all, cur, prim] = await Promise.all([availableMonitors(), currentMonitor(), primaryMonitor()]);
      return all.map((m, i) => {
        const k = m.scaleFactor || 1;
        return {
          id: m.name ?? String(i),
          label: m.name ?? `Écran ${i + 1}`,
          x: m.position.x / k,
          y: m.position.y / k,
          w: m.size.width / k,
          h: m.size.height / k,
          primary: !!prim && prim.position.x === m.position.x && prim.position.y === m.position.y,
          current: !!cur && cur.position.x === m.position.x && cur.position.y === m.position.y,
        };
      });
    } catch {
      return [];
    }
  }
  const w = window as unknown as {
    getScreenDetails?: () => Promise<{ screens: (Screen & { availLeft: number; availTop: number; left: number; top: number; isPrimary: boolean; label: string })[]; currentScreen: Screen }>;
  };
  const extended = (screen as Screen & { isExtended?: boolean }).isExtended;
  if (!w.getScreenDetails || extended === false) return [];
  try {
    if (!ask) {
      const st = await navigator.permissions.query({ name: 'window-management' as PermissionName }).catch(() => null);
      if (st?.state !== 'granted') return [];
    }
    const d = await w.getScreenDetails();
    return d.screens.map((s, i) => ({
      id: String(i),
      label: s.label || `Écran ${i + 1}`,
      x: s.left,
      y: s.top,
      w: s.width,
      h: s.height,
      primary: s.isPrimary,
      current: s === (d.currentScreen as unknown),
    }));
  } catch {
    return [];
  }
}

/** Y a-t-il (probablement) un second écran ? Sans demander de permission. */
export async function hasSecondScreen(): Promise<boolean> {
  if (isTauri) return (await listScreens()).length > 1;
  const ext = (screen as Screen & { isExtended?: boolean }).isExtended;
  return !!ext;
}

let audienceWin: Window | null = null;

/** Ouvre la fenêtre public sur l'écran `target` (plein écran), ou une fenêtre ordinaire si aucun écran n'est donné. */
export async function openAudience(target: ScreenInfo | null): Promise<boolean> {
  if (isTauri) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const old = await WebviewWindow.getByLabel('audience');
      if (old) await old.close().catch(() => {});
      const w = new WebviewWindow('audience', {
        url: 'index.html?audience=1',
        title: 'Nova PDF — Présentation',
        ...(target ? { x: target.x + 40, y: target.y + 40, width: Math.min(1280, target.w - 80), height: Math.min(720, target.h - 80), fullscreen: true, decorations: false, focus: false } : { width: 1280, height: 720 }),
      });
      return await new Promise<boolean>((res) => {
        w.once('tauri://created', async () => {
          if (target) {
            // certains systèmes ignorent « fullscreen » à la création : on le réapplique sur le bon écran
            try {
              await w.setFullscreen(true);
            } catch {
              /* rien */
            }
          }
          res(true);
        });
        w.once('tauri://error', () => res(false));
      });
    } catch {
      return false;
    }
  }
  const url = `${location.origin}${location.pathname}?audience=1`;
  const feat = target && target.w ? `popup,left=${target.x},top=${target.y},width=${target.w},height=${target.h}` : 'popup,width=1280,height=720';
  audienceWin = window.open(url, 'nova-audience', feat);
  if (audienceWin && target && target.w) {
    try {
      audienceWin.moveTo(target.x, target.y);
      audienceWin.resizeTo(target.w, target.h);
    } catch {
      /* navigateur restrictif */
    }
  }
  return !!audienceWin;
}

/** Déplace la fenêtre public sur un autre écran (bouton « Changer d'écran »). */
export async function moveAudience(target: ScreenInfo) {
  if (isTauri) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi');
    const w = await WebviewWindow.getByLabel('audience');
    if (!w) return;
    await w.setFullscreen(false);
    await w.setPosition(new LogicalPosition(target.x + 40, target.y + 40));
    await w.setSize(new LogicalSize(Math.min(1280, target.w - 80), Math.min(720, target.h - 80)));
    await w.setFullscreen(true);
    return;
  }
  try {
    audienceWin?.moveTo(target.x, target.y);
    audienceWin?.resizeTo(target.w, target.h);
  } catch {
    /* rien */
  }
}

export async function closeAudience() {
  if (isTauri) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      await (await WebviewWindow.getByLabel('audience'))?.close();
    } catch {
      /* rien */
    }
  } else {
    try {
      audienceWin?.close();
    } catch {
      /* rien */
    }
  }
  audienceWin = null;
}

// ---------------------------------------------------------------- canal présentateur ↔ public
export interface Channel {
  post: (m: unknown) => void;
  close: () => void;
}
/** Canal entre fenêtres : événements Tauri dans l'application de bureau, BroadcastChannel dans le navigateur. */
export function openChannel(onMessage: (m: unknown) => void): Channel {
  const NAME = 'nova-present';
  if (isTauri) {
    let unlisten: (() => void) | null = null;
    let closed = false;
    const me = Math.random().toString(36).slice(2);
    import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ from: string; m: unknown }>(NAME, (e) => e.payload.from !== me && onMessage(e.payload.m)).then((u) => (closed ? u() : (unlisten = u))),
    );
    // la BroadcastChannel sert aussi de secours si les événements ne passent pas
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(NAME) : null;
    const seen = new Set<string>();
    if (bc) bc.onmessage = (e) => !seen.has(e.data?.id) && onMessage(e.data?.m);
    return {
      post: (m) => {
        const id = Math.random().toString(36).slice(2);
        seen.add(id);
        import('@tauri-apps/api/event').then(({ emit }) => emit(NAME, { from: me, m })).catch(() => bc?.postMessage({ id, m }));
      },
      close: () => {
        closed = true;
        unlisten?.();
        bc?.close();
      },
    };
  }
  const bc = new BroadcastChannel(NAME);
  bc.onmessage = (e) => onMessage(e.data);
  return { post: (m) => bc.postMessage(m), close: () => bc.close() };
}

// ---------------------------------------------------------------- document partagé avec la fenêtre public
import { get, set } from 'idb-keyval';
export const putPresentDoc = (bytes: Uint8Array) => set('nova:present-doc', bytes);
export const getPresentDoc = () => get<Uint8Array>('nova:present-doc');
