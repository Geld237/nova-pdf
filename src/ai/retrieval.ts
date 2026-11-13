import type { PageText } from '../types';

export interface Chunk {
  id: number;
  page: number;
  text: string;
  tokens: string[];
}

const STOP = new Set(
  (
    'le la les un une des du de d l et ou à au aux en dans par pour sur avec sans ce cet cette ces qui que quoi dont ' +
    'est sont été être a ont avoir il elle ils elles on nous vous je tu se sa son ses leur leurs ne pas plus ' +
    'the a an and or of to in on for with by is are was were be been it this that these those as at from'
  ).split(' '),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Découpe chaque page en morceaux d'environ `size` caractères. */
export function chunkPages(pages: PageText[], size = 900): Chunk[] {
  const chunks: Chunk[] = [];
  for (const p of pages) {
    const paras = p.text.split(/\n+/);
    let buf = '';
    const flush = () => {
      if (buf.trim()) chunks.push({ id: chunks.length, page: p.page, text: buf.trim(), tokens: tokenize(buf) });
      buf = '';
    };
    for (const para of paras) {
      if (buf.length + para.length > size) flush();
      buf += para + '\n';
    }
    flush();
  }
  return chunks;
}

/** Recherche lexicale BM25 : fonctionne hors ligne, sans modèle d'embedding. */
export class Bm25Index {
  private df = new Map<string, number>();
  private avgLen = 0;
  chunks: Chunk[];
  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    for (const c of chunks) {
      for (const t of new Set(c.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.avgLen += c.tokens.length;
    }
    this.avgLen /= Math.max(1, chunks.length);
  }
  search(query: string, k = 5): Chunk[] {
    const q = tokenize(query);
    const N = this.chunks.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored = this.chunks.map((c) => {
      const tf = new Map<string, number>();
      for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / this.avgLen));
      }
      return { c, s };
    });
    return scored
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.c);
  }
}
