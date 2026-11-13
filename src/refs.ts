import type { PageText } from './types';

/** Extraction de la bibliographie d'un article et export BibTeX / RIS (Zotero, Mendeley, EndNote). */
export interface RefEntry {
  n?: number; // numéro [n] si style numérique
  raw: string;
  authors: string[];
  year?: string;
  title?: string;
  journal?: string;
  doi?: string;
  url?: string;
  page: number;
}

const HEAD = /^\s*(?:\d+\.?\s*)?(references|reference list|bibliography|bibliographie|références(?: bibliographiques)?|works cited|literature cited|sources)\s*$/im;
const DOI = /\b(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/i;

export function extractDois(texts: PageText[]): string[] {
  const set = new Set<string>();
  for (const t of texts) for (const m of t.text.matchAll(new RegExp(DOI.source, 'gi'))) set.add(m[1]);
  return [...set];
}

export function extractReferences(texts: PageText[]): RefEntry[] {
  // repère la section de bibliographie (en partant de la fin)
  let startPage = -1;
  let startIdx = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    const m = HEAD.exec(texts[i].text);
    if (m) {
      startPage = i;
      startIdx = m.index + m[0].length;
      break;
    }
  }
  if (startPage < 0) return [];
  const lines: { s: string; page: number }[] = [];
  for (let i = startPage; i < texts.length; i++) {
    const txt = i === startPage ? texts[i].text.slice(startIdx) : texts[i].text;
    for (const l of txt.split('\n')) if (l.trim()) lines.push({ s: l.trim(), page: i });
  }
  // découpe en entrées
  const numbered = lines.filter((l) => /^\[\d+\]|^\d{1,3}\.\s+[A-ZÀ-Ý]/.test(l.s)).length >= 3;
  const entries: { raw: string; page: number; n?: number }[] = [];
  for (const l of lines) {
    const num = l.s.match(/^\[(\d+)\]\s*|^(\d{1,3})\.\s+(?=[A-ZÀ-Ý])/);
    const authorStart = /^[A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]+,\s+(?:[A-ZÀ-Ý]\.|[A-ZÀ-Ý][a-zà-ÿ]+)/.test(l.s);
    const bracket = /^\[\d+\]/.test(l.s);
    if (bracket || (numbered && num) || (!numbered && authorStart && entries.length && /[.)]\s*$/.test(entries[entries.length - 1].raw))) {
      entries.push({ raw: num ? l.s.slice(num[0].length) : l.s, page: l.page, n: num ? +(num[1] ?? num[2]) : undefined });
    } else if (!entries.length && (authorStart || num)) {
      entries.push({ raw: num ? l.s.slice(num[0].length) : l.s, page: l.page, n: num ? +(num[1] ?? num[2]) : undefined });
    } else if (entries.length) {
      const last = entries[entries.length - 1];
      last.raw = last.raw.replace(/-$/, '') + (last.raw.endsWith('-') ? '' : ' ') + l.s;
    }
    if (entries.length > 500) break;
  }
  return entries.map((e) => parseEntry(e.raw, e.page, e.n));
}

function parseEntry(raw: string, page: number, n?: number): RefEntry {
  const doi = raw.match(DOI)?.[1];
  const url = raw.match(/https?:\/\/\S+/)?.[0];
  const yearM = raw.match(/\(?((?:19|20)\d{2})[a-z]?\)?/);
  const year = yearM?.[1];
  let authors: string[] = [];
  let title: string | undefined;
  let journal: string | undefined;
  const quoted = raw.match(/[“"«]\s*([^”"»]{8,})\s*[”"»]/);
  if (yearM && yearM.index! > 0) {
    const before = raw.slice(0, yearM.index).replace(/[.(,\s]+$/, '');
    authors = before.split(/\s*(?:;|,?\s+(?:and|et|&)\s+|(?<=\.),\s+)\s*/).map((a) => a.trim()).filter((a) => a.length > 1 && a.length < 60);
    const after = raw.slice(yearM.index! + yearM[0].length).replace(/^[).,:\s]+/, '');
    const parts = after.split(/\.\s+/);
    title = quoted?.[1] ?? parts[0]?.trim();
    journal = parts[1]?.replace(/[,;]?\s*\d.*$/, '').trim() || undefined;
  } else if (quoted) {
    title = quoted[1];
    authors = raw.slice(0, quoted.index).split(/,|;| and | et /).map((a) => a.trim()).filter((a) => a.length > 1 && a.length < 60).slice(0, 8);
  } else {
    const parts = raw.split(/\.\s+/);
    authors = (parts[0] ?? '').split(/,|;| and | et /).map((a) => a.trim()).filter((a) => a.length > 1 && a.length < 40).slice(0, 8);
    title = parts[1];
  }
  return { n, raw, authors, year, title: title?.replace(/[.,]$/, ''), journal, doi, url, page };
}

const esc = (s = '') => s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

function keyOf(e: RefEntry, i: number) {
  const last = (e.authors[0] ?? 'ref').split(/[ ,]/)[0].normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase() || 'ref';
  return `${last}${e.year ?? ''}${String.fromCharCode(97 + (i % 26))}`;
}

export function toBibTeX(entries: RefEntry[]): string {
  return entries
    .map((e, i) => {
      const f = [
        e.authors.length && `  author = {${esc(e.authors.join(' and '))}}`,
        e.title && `  title = {${esc(e.title)}}`,
        e.journal && `  journal = {${esc(e.journal)}}`,
        e.year && `  year = {${e.year}}`,
        e.doi && `  doi = {${e.doi}}`,
        e.url && `  url = {${e.url}}`,
        `  note = {${esc(e.raw).slice(0, 400)}}`,
      ].filter(Boolean);
      return `@${e.journal ? 'article' : 'misc'}{${keyOf(e, i)},\n${f.join(',\n')}\n}`;
    })
    .join('\n\n');
}

export function toRIS(entries: RefEntry[]): string {
  return entries
    .map((e) =>
      [
        `TY  - ${e.journal ? 'JOUR' : 'GEN'}`,
        ...e.authors.map((a) => `AU  - ${a}`),
        e.title && `TI  - ${e.title}`,
        e.journal && `JO  - ${e.journal}`,
        e.year && `PY  - ${e.year}`,
        e.doi && `DO  - ${e.doi}`,
        e.url && `UR  - ${e.url}`,
        `N1  - ${e.raw.slice(0, 400)}`,
        'ER  - ',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

/** Facultatif, en ligne : récupère la notice BibTeX officielle d'un DOI (Crossref). */
export async function crossrefBibTeX(doi: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`);
    return r.ok ? (await r.text()).trim() : null;
  } catch {
    return null;
  }
}

/** Table numéro → référence, pour l'aperçu au survol des appels [n]. */
export function refMap(entries: RefEntry[]): Map<number, string> {
  const m = new Map<number, string>();
  entries.forEach((e, i) => m.set(e.n ?? i + 1, e.raw));
  return m;
}
