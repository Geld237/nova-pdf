import { get, set } from 'idb-keyval';
import { getLibText, listLibrary, type LibItem } from './library';

/* Recherche « par le sens » dans la bibliothèque.
   - avec Ollama et un modèle d'embeddings (nomic-embed-text, bge-m3, mxbai-embed-large…) : vraie recherche sémantique ;
   - sinon : recherche intelligente locale (racines des mots, accents, synonymes, ordre de pertinence BM25). */

export interface SemHit {
  item: LibItem;
  page: number;
  snippet: string;
  score: number;
}

interface Chunk {
  page: number;
  text: string;
}

function chunksOf(texts: { page: number; text: string }[]): Chunk[] {
  const out: Chunk[] = [];
  for (const t of texts) {
    const clean = t.text.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < clean.length; i += 700) {
      const part = clean.slice(Math.max(0, i - 100), i + 700);
      if (part.length > 40) out.push({ page: t.page, text: part });
    }
  }
  return out;
}

// ---------- recherche locale intelligente ----------
const STOP = new Set(
  'le la les un une des de du d l et ou en au aux a à ce ces cet cette qui que quoi dont où pour par sur dans avec sans sous est sont été être avoir ont il elle ils elles on nous vous je tu se sa son ses leur leurs ne pas plus moins tout tous toute toutes the of and or to in on for with is are be by an as at it this that from'.split(' '),
);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** racinisation légère (français + anglais) */
function stem(w: string) {
  for (const suf of ['issements', 'issement', 'ations', 'ation', 'ements', 'ement', 'ments', 'ment', 'euses', 'euse', 'eurs', 'eur', 'ités', 'ité', 'ives', 'ive', 'ifs', 'if', 'ions', 'ion', 'ances', 'ance', 'ences', 'ence', 'ables', 'able', 'ing', 'ies', 'es', 'er', 'ez', 'ée', 'és', 'é', 'ed', 's', 'x', 'e'])
    if (w.length - suf.length >= 4 && w.endsWith(suf)) return w.slice(0, -suf.length);
  return w;
}
const tokens = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);

/** familles de mots proches (élargit la requête) */
const RELATED: string[][] = [
  ['resiliation', 'resilier', 'rupture', 'annulation', 'annuler', 'fin', 'terminer', 'termination', 'cancel', 'preavis'],
  ['contrat', 'convention', 'accord', 'engagement', 'agreement', 'contract'],
  ['prix', 'tarif', 'cout', 'montant', 'paiement', 'payer', 'facture', 'price', 'cost', 'payment', 'invoice'],
  ['salaire', 'remuneration', 'paie', 'salary', 'wage'],
  ['employe', 'salarie', 'collaborateur', 'personnel', 'employee', 'staff'],
  ['delai', 'echeance', 'date', 'duree', 'deadline', 'periode'],
  ['penalite', 'amende', 'sanction', 'indemnite', 'penalty', 'fine'],
  ['confidentialite', 'confidentiel', 'secret', 'donnees', 'privacy', 'confidential'],
  ['responsabilite', 'garantie', 'assurance', 'liability', 'warranty', 'insurance'],
  ['vente', 'achat', 'commande', 'acheter', 'vendre', 'sale', 'purchase', 'order'],
  ['loyer', 'bail', 'location', 'locataire', 'proprietaire', 'rent', 'lease', 'tenant'],
  ['sante', 'medical', 'maladie', 'soin', 'patient', 'health'],
  ['ecole', 'cours', 'etudiant', 'examen', 'universite', 'school', 'student', 'exam'],
  ['voiture', 'vehicule', 'automobile', 'car', 'vehicle'],
  ['impot', 'taxe', 'fiscal', 'tva', 'tax'],
  ['risque', 'danger', 'menace', 'securite', 'risk', 'threat', 'security'],
];
const RELATED_STEMS = RELATED.map((g) => new Set(g.map(stem)));

function expand(q: string[]): Map<string, number> {
  const w = new Map<string, number>();
  for (const t of q) {
    w.set(t, 1);
    for (const g of RELATED_STEMS) if (g.has(t)) for (const r of g) if (!w.has(r)) w.set(r, 0.45);
  }
  return w;
}

async function localSearch(query: string, items: LibItem[]): Promise<SemHit[]> {
  const q = expand(tokens(query));
  if (!q.size) return [];
  const all: { item: LibItem; c: Chunk; toks: string[] }[] = [];
  for (const item of items) {
    const texts = (await getLibText(item.id)) ?? [];
    for (const c of chunksOf(texts)) all.push({ item, c, toks: tokens(c.text) });
  }
  const N = all.length || 1;
  const avg = all.reduce((s, d) => s + d.toks.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of all) for (const t of new Set(d.toks)) if (q.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.4;
  const b = 0.75;
  const hits: SemHit[] = [];
  for (const d of all) {
    const tf = new Map<string, number>();
    for (const t of d.toks) if (q.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    if (!tf.size) continue;
    let score = 0;
    for (const [t, f] of tf) {
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += q.get(t)! * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.toks.length) / avg)));
    }
    // bonus quand plusieurs idées de la requête sont présentes
    score *= 1 + 0.3 * ([...tf.keys()].filter((t) => q.get(t) === 1).length - 1);
    hits.push({ item: d.item, page: d.c.page, snippet: d.c.text.slice(0, 220), score });
  }
  return hits;
}

// ---------- embeddings via Ollama ----------
const EMBED_HINT = /embed|bge|minilm|e5|gte|arctic|snowflake|nomic/i;

export async function embeddingModel(ollamaUrl: string): Promise<string | null> {
  try {
    const { listOllamaModels } = await import('./ai/llm');
    const ms = await listOllamaModels(ollamaUrl);
    return ms.find((m) => EMBED_HINT.test(m)) ?? null;
  } catch {
    return null;
  }
}

async function embed(ollamaUrl: string, model: string, input: string[]): Promise<number[][]> {
  const { ollamaFetch } = await import('./ai/llm');
  const r = await ollamaFetch(`${ollamaUrl.replace(/\/$/, '')}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!r.ok) throw new Error(`Ollama /api/embed : ${r.status}`);
  return (await r.json()).embeddings as number[][];
}

const cos = (a: number[], b: number[]) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na * nb) || 1);
};

async function vectorSearch(query: string, items: LibItem[], ollamaUrl: string, model: string, onProgress?: (t: string) => void): Promise<SemHit[]> {
  const [qv] = await embed(ollamaUrl, model, [query]);
  const hits: SemHit[] = [];
  let k = 0;
  for (const item of items) {
    k++;
    const key = `nova:emb:${model}:${item.id}`;
    let cached = await get<{ chunks: Chunk[]; vecs: number[][] }>(key);
    if (!cached) {
      onProgress?.(`Indexation ${k}/${items.length} : ${item.name}`);
      const chunks = chunksOf((await getLibText(item.id)) ?? []).slice(0, 400);
      const vecs: number[][] = [];
      for (let i = 0; i < chunks.length; i += 16) vecs.push(...(await embed(ollamaUrl, model, chunks.slice(i, i + 16).map((c) => c.text))));
      cached = { chunks, vecs };
      await set(key, cached);
    }
    cached.chunks.forEach((c, i) => hits.push({ item, page: c.page, snippet: c.text.slice(0, 220), score: cos(qv, cached!.vecs[i]) }));
  }
  return hits;
}

/** Recherche par le sens : renvoie les meilleurs passages (au plus 3 par document) et le moteur utilisé. */
export async function semanticSearch(
  query: string,
  ollamaUrl: string,
  onProgress?: (t: string) => void,
): Promise<{ hits: SemHit[]; engine: string }> {
  const items = await listLibrary();
  const model = await embeddingModel(ollamaUrl);
  let raw: SemHit[];
  let engine: string;
  if (model) {
    try {
      raw = await vectorSearch(query, items, ollamaUrl, model, onProgress);
      engine = `sémantique (${model})`;
    } catch {
      raw = await localSearch(query, items);
      engine = 'locale (mots proches)';
    }
  } else {
    raw = await localSearch(query, items);
    engine = 'locale (mots proches)';
  }
  raw.sort((a, b) => b.score - a.score);
  const per = new Map<string, number>();
  const out: SemHit[] = [];
  for (const h of raw) {
    const c = per.get(h.item.id) ?? 0;
    if (c >= 3) continue;
    per.set(h.item.id, c + 1);
    out.push(h);
    if (out.length >= 30) break;
  }
  return { hits: out, engine };
}
