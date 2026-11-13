/**
 * Reconnaissance vocale via l'API du système/navigateur (Web Speech).
 * Attention : selon le navigateur (ex. Chrome), l'audio peut être traité par un service en ligne.
 */
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

export function speechSupported() {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function listen(opts: {
  continuous: boolean;
  onText: (text: string, final: boolean) => void;
  onEnd?: () => void;
  onError?: (e: string) => void;
  lang?: string;
}): () => void {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    opts.onError?.('La reconnaissance vocale n’est pas disponible dans ce navigateur.');
    return () => {};
  }
  const r = new Ctor();
  r.lang = opts.lang ?? (navigator.language || 'fr-FR');
  r.continuous = opts.continuous;
  r.interimResults = true;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) opts.onText(e.results[i][0].transcript, e.results[i].isFinal);
  };
  r.onend = () => opts.onEnd?.();
  r.onerror = (e) => opts.onError?.(e.error === 'not-allowed' ? 'Micro refusé.' : `Erreur vocale : ${e.error}`);
  r.start();
  return () => r.stop();
}

export type VoiceAction =
  | { type: 'next' } | { type: 'prev' } | { type: 'page'; n: number } | { type: 'first' } | { type: 'last' }
  | { type: 'zoomIn' } | { type: 'zoomOut' } | { type: 'fit' }
  | { type: 'tool'; tool: string } | { type: 'search'; q: string } | { type: 'panel'; panel: string }
  | { type: 'read' } | { type: 'stop' } | { type: 'save' } | { type: 'night' } | { type: 'present' }
  | { type: 'ask'; q: string } | { type: 'note'; text: string };

const NUM: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, vingt: 20, trente: 30 };

/** Interprète une phrase en commande (français, quelques variantes anglaises). */
export function parseCommand(raw: string): VoiceAction | null {
  const s = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,!?]/g, '').trim();
  const m = (re: RegExp) => s.match(re);
  let r;
  if ((r = m(/(?:page|aller a la page|va a la page|go to page)\s+(\d+|\w+)/))) {
    const n = /^\d+$/.test(r[1]) ? +r[1] : NUM[r[1]];
    if (n) return { type: 'page', n };
  }
  if (/\b(page suivante|suivant|next( page)?|avance)\b/.test(s)) return { type: 'next' };
  if (/\b(page precedente|precedent|previous|recule|retour)\b/.test(s)) return { type: 'prev' };
  if (/\b(premiere page|debut|first page)\b/.test(s)) return { type: 'first' };
  if (/\b(derniere page|fin du document|last page)\b/.test(s)) return { type: 'last' };
  if (/\b(zoom avant|agrandi|plus grand|zoom in)\b/.test(s)) return { type: 'zoomIn' };
  if (/\b(zoom arriere|reduis|plus petit|zoom out)\b/.test(s)) return { type: 'zoomOut' };
  if (/\b(pleine largeur|ajuste)\b/.test(s)) return { type: 'fit' };
  if (/\b(surlign|highlight)/.test(s)) return { type: 'tool', tool: 'highlight' };
  if (/\b(soulign)/.test(s)) return { type: 'tool', tool: 'underline' };
  if (/\b(dessin|crayon|draw)/.test(s)) return { type: 'tool', tool: 'ink' };
  if (/\b(selection|curseur|select)\b/.test(s)) return { type: 'tool', tool: 'select' };
  if ((r = m(/^(?:cherche|recherche|trouve|search(?: for)?)\s+(.+)$/))) return { type: 'search', q: r[1] };
  if (/\b(lis|lire|lecture a voix haute|read aloud)\b/.test(s)) return { type: 'read' };
  if (/\b(stop|arrete|silence|pause)\b/.test(s)) return { type: 'stop' };
  if (/\b(enregistre|sauvegarde|save)\b/.test(s)) return { type: 'save' };
  if (/\b(mode nuit|night)\b/.test(s)) return { type: 'night' };
  if (/\b(presentation|presente|diaporama)\b/.test(s)) return { type: 'present' };
  if ((r = m(/^(?:note|prends note|ajoute une note)\s*:?\s*(.+)$/))) return { type: 'note', text: raw.replace(/^\s*\S+(?:\s+note)?\s*:?\s*/i, '') };
  if ((r = m(/^(?:question|demande|explique)\s*:?\s*(.+)$/))) return { type: 'ask', q: raw.replace(/^\s*\S+\s*:?\s*/, '') };
  for (const [k, p] of [['notes', 'notes'], ['bibliotheque', 'library'], ['outils', 'tools'], ['etude', 'study'], ['revision', 'study'], ['ia', 'ai'], ['assistant', 'ai'], ['formulaire', 'form'], ['parametres', 'settings']] as const)
    if (new RegExp(`\\b(ouvre|affiche|montre)\\b.*\\b${k}\\b`).test(s)) return { type: 'panel', panel: p };
  return null;
}
