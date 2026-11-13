import { get, keys, set } from 'idb-keyval';

/** Fiches de révision avec répétition espacée (algorithme SM-2 simplifié). */
export interface Card {
  id: string;
  front: string;
  back: string;
  page?: number;
  ease: number;
  interval: number; // jours
  reps: number;
  lapses: number;
  due: number; // timestamp
  createdAt: number;
}

export interface Deck {
  fingerprint: string;
  name: string;
  cards: Card[];
}

const DAY = 86_400_000;
const uid = () => Math.random().toString(36).slice(2, 10);

export function newCard(front: string, back: string, page?: number): Card {
  return { id: uid(), front, back, page, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: Date.now(), createdAt: Date.now() };
}

export type Grade = 0 | 1 | 2 | 3; // à revoir, difficile, bien, facile

export function schedule(c: Card, g: Grade, now = Date.now()): Card {
  let { ease, interval, reps, lapses } = c;
  if (g === 0) {
    reps = 0;
    lapses++;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    return { ...c, ease, interval, reps, lapses, due: now + 10 * 60_000 }; // revoir dans 10 min
  }
  reps++;
  if (reps === 1) interval = g === 3 ? 3 : 1;
  else if (reps === 2) interval = g === 1 ? 3 : 6;
  else interval = Math.round(interval * (g === 1 ? 1.2 : g === 3 ? ease * 1.3 : ease));
  ease = Math.max(1.3, ease + (g === 1 ? -0.15 : g === 3 ? 0.15 : 0));
  return { ...c, ease, interval, reps, lapses, due: now + interval * DAY };
}

export function nextIntervalLabel(c: Card, g: Grade): string {
  const n = schedule(c, g);
  const d = (n.due - Date.now()) / DAY;
  return d < 1 / 24 ? '10 min' : d < 1 ? `${Math.round(d * 24)} h` : d < 30 ? `${Math.round(d)} j` : `${Math.round(d / 30)} mois`;
}

export async function loadDeck(fp: string, name: string): Promise<Deck> {
  try {
    return ((await get(`deck:${fp}`)) as Deck) ?? { fingerprint: fp, name, cards: [] };
  } catch {
    return { fingerprint: fp, name, cards: [] };
  }
}

export async function saveDeck(d: Deck) {
  try {
    await set(`deck:${d.fingerprint}`, d);
  } catch {
    /* rien */
  }
}

export async function allDecks(): Promise<Deck[]> {
  try {
    const ks = (await keys()).filter((k) => String(k).startsWith('deck:'));
    return ((await Promise.all(ks.map((k) => get(k)))) as Deck[]).filter((d) => d?.cards?.length);
  } catch {
    return [];
  }
}

export const dueCards = (d: Deck, now = Date.now()) => d.cards.filter((c) => c.due <= now);

/** Lit des fiches au format « Q : … / R : … [p. N] ». */
export function parseCards(text: string): { front: string; back: string; page?: number }[] {
  const out: { front: string; back: string; page?: number }[] = [];
  const re = /(?:^|\n)\s*(?:\d+[.)]\s*)?\**Q\**\s*[:：]\s*([\s\S]+?)\n\s*\**R\**\s*[:：]\s*([\s\S]+?)(?=\n\s*(?:\d+[.)]\s*)?\**Q\**\s*[:：]|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    const back = m[2].trim();
    const pg = back.match(/\[p\.?\s*(\d+)/i);
    out.push({ front: m[1].trim(), back: back.replace(/\s*\[p\.?\s*\d+[^\]]*\]\s*$/i, '').trim(), page: pg ? +pg[1] - 1 : undefined });
  }
  return out;
}

export interface QuizQuestion {
  question: string;
  choices: string[];
  answer: number;
  explanation?: string;
  page?: number;
}

/** Lit des QCM générés par l'IA. */
export function parseQuiz(text: string): QuizQuestion[] {
  const blocks = text.split(/\n(?=\s*(?:\d+[.)]|Q\s*\d*\s*[:：]|Question))/i);
  const out: QuizQuestion[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    const choices: string[] = [];
    let question = '';
    let answer = -1;
    let explanation = '';
    for (const l of lines) {
      const c = l.match(/^\(?([A-Da-d])[).:]\s*(.+)$/);
      const a = l.match(/^\**(?:Réponse|Bonne réponse|Answer)\**\s*[:：]\s*\(?([A-Da-d])/i);
      const e = l.match(/^\**(?:Explication|Explanation)\**\s*[:：]\s*(.+)$/i);
      if (a) answer = a[1].toUpperCase().charCodeAt(0) - 65;
      else if (e) explanation = e[1];
      else if (c && question) choices.push(c[2]);
      else if (!question) question = l.replace(/^(?:\d+[.)]|Q\s*\d*\s*[:：]|Question\s*\d*\s*[:：]?)\s*/i, '');
    }
    if (question && choices.length >= 2 && answer >= 0 && answer < choices.length) {
      const pg = explanation.match(/\[p\.?\s*(\d+)/i);
      out.push({ question, choices, answer, explanation, page: pg ? +pg[1] - 1 : undefined });
    }
  }
  return out;
}

/** QCM hors ligne à partir des fiches : les autres réponses servent de distracteurs. */
export function quizFromCards(cards: Card[], n = 10): QuizQuestion[] {
  if (cards.length < 4) return [];
  const pool = [...cards].sort(() => Math.random() - 0.5).slice(0, n);
  return pool.map((c) => {
    const others = cards.filter((x) => x.id !== c.id && x.back !== c.back).sort(() => Math.random() - 0.5).slice(0, 3).map((x) => x.back);
    const choices = [...others, c.back].sort(() => Math.random() - 0.5);
    return { question: c.front, choices, answer: choices.indexOf(c.back), page: c.page };
  });
}
