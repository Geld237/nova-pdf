import { get, keys, set } from 'idb-keyval';
import { addToLibrary, getLibFile, getLibText, listLibrary, saveLibText, type LibItem } from './library';
import type { Peer, Msg } from './p2p';
import type { DocMemory, DocNotes } from './memory';
import type { Deck } from './study';
import type { PageText } from './types';

/** Synchronisation de la bibliothèque, des annotations, notes et fiches entre deux appareils connectés. */
const SMALL = ['doc:', 'notes:', 'deck:'];

async function smallRecords(): Promise<[string, unknown][]> {
  const ks = (await keys()).map(String).filter((k) => SMALL.some((p) => k.startsWith(p)));
  return Promise.all(ks.map(async (k) => [k, await get(k)] as [string, unknown]));
}

async function mergeRecord(k: string, remote: unknown) {
  const local = await get(k);
  if (!local) return set(k, remote);
  if (k.startsWith('doc:')) {
    const a = local as DocMemory;
    const b = remote as DocMemory;
    const byId = new Map(a.annotations.map((x) => [x.id, x]));
    for (const x of b.annotations) if (!byId.has(x.id)) byId.set(x.id, x);
    const newer = b.updatedAt > a.updatedAt ? b : a;
    return set(k, { ...newer, annotations: [...byId.values()], updatedAt: Math.max(a.updatedAt, b.updatedAt) });
  }
  if (k.startsWith('notes:')) {
    const a = local as DocNotes;
    const b = remote as DocNotes;
    return b.updatedAt > a.updatedAt ? set(k, b) : undefined;
  }
  if (k.startsWith('deck:')) {
    const a = local as Deck;
    const b = remote as Deck;
    const byId = new Map(a.cards.map((c) => [c.id, c]));
    for (const c of b.cards) {
      const mine = byId.get(c.id);
      if (!mine || c.reps > mine.reps || (c.reps === mine.reps && c.due > mine.due)) byId.set(c.id, c);
    }
    return set(k, { ...a, cards: [...byId.values()] });
  }
}

export interface SyncProgress {
  sent: number;
  received: number;
  status: string;
}

/** Démarre l'échange ; `reply` évite les allers-retours infinis. */
export async function sendManifest(peer: Peer, reply = false) {
  const lib = await listLibrary();
  peer.send({ type: 'sync-manifest', reply, lib: lib.map((i) => ({ id: i.id, openedAt: i.openedAt })), records: await smallRecords() });
}

/** À brancher sur peer.on(...). Renvoie true si le message concernait la synchro. */
export async function handleSyncMessage(peer: Peer, m: Msg, progress: (p: Partial<SyncProgress>) => void): Promise<boolean> {
  if (m.type === 'sync-manifest') {
    progress({ status: 'Fusion des annotations, notes et fiches…' });
    for (const [k, v] of m.records as [string, unknown][]) await mergeRecord(k, v);
    if (!m.reply) await sendManifest(peer, true);
    // envoie les documents que l'autre appareil n'a pas
    const remote = new Set((m.lib as { id: string }[]).map((x) => x.id));
    const mine = await listLibrary();
    const missing = mine.filter((i) => !remote.has(i.id));
    let sent = 0;
    for (const item of missing) {
      const bytes = await getLibFile(item.id);
      if (!bytes) continue;
      progress({ status: `Envoi de « ${item.name} »…` });
      await peer.sendFile({ type: 'lib-file', item, texts: (await getLibText(item.id)) ?? null }, bytes);
      progress({ sent: ++sent });
    }
    progress({ status: missing.length ? 'Envoi terminé.' : 'Rien à envoyer : vos documents sont déjà sur l’autre appareil.' });
    window.dispatchEvent(new Event('nova:library-changed'));
    return true;
  }
  if (m.type === 'lib-file') {
    const item = m.item as LibItem;
    await addToLibrary(item, m.bytes as Uint8Array);
    if (m.texts) await saveLibText(item.id, m.texts as PageText[]);
    progress({ status: `Reçu : « ${item.name} »` });
    return true;
  }
  return false;
}
