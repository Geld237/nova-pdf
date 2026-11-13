import { useEffect, useMemo, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';
import type { Annotation, OutlineItem, PageText, SearchHit } from '../types';
import { allMemories, forgetMemory, type DocMemory } from '../memory';
import { Thumb } from './Thumb';

type Tab = 'pages' | 'outline' | 'search' | 'annotations' | 'notebook';

interface Props {
  doc: PDFDocumentProxy;
  numPages: number;
  current: number;
  outline: OutlineItem[];
  texts: PageText[] | null;
  annotations: Annotation[];
  query: string;
  setQuery: (q: string) => void;
  goTo: (p: number) => void;
  onDelete: (id: string) => void;
  tab: Tab;
  setTab: (t: Tab) => void;
}

const KIND_LABEL: Record<string, string> = {
  highlight: 'Surlignage', underline: 'Soulignement', strike: 'Barré', ink: 'Dessin', rect: 'Rectangle',
  ellipse: 'Ellipse', arrow: 'Flèche', text: 'Texte', note: 'Note', image: 'Signature / image', redact: 'Caviardage',
};

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <nav className="side-tabs" role="tablist">
        {(
          [
            ['pages', '▦', 'Pages'],
            ['outline', '☰', 'Sommaire'],
            ['search', '⌕', 'Recherche'],
            ['annotations', '✎', 'Annotations'],
            ['notebook', '◫', 'Carnet'],
          ] as [Tab, string, string][]
        ).map(([id, icon, label]) => (
          <button key={id} role="tab" aria-selected={p.tab === id} className={p.tab === id ? 'active' : ''} onClick={() => p.setTab(id)} title={label}>
            <span aria-hidden>{icon}</span>
            <small>{label}</small>
          </button>
        ))}
      </nav>
      <div className="side-body">
        {p.tab === 'pages' && <Pages {...p} />}
        {p.tab === 'outline' && <Outline items={p.outline} goTo={p.goTo} />}
        {p.tab === 'search' && <Search {...p} />}
        {p.tab === 'annotations' && <AnnList {...p} />}
        {p.tab === 'notebook' && <Notebook />}
      </div>
    </aside>
  );
}

function Pages({ doc, numPages, current, goTo }: Props) {
  return (
    <div className="thumbs">
      {Array.from({ length: numPages }, (_, i) => (
        <button key={i} className={`thumb ${i === current ? 'current' : ''}`} onClick={() => goTo(i)}>
          <Thumb doc={doc} page={i} width={110} />
          <span>{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

function Outline({ items, goTo }: { items: OutlineItem[]; goTo: (p: number) => void }) {
  if (!items.length) return <p className="empty">Ce document n'a pas de sommaire.</p>;
  const render = (list: OutlineItem[], depth: number) => (
    <ul className="outline" style={{ paddingLeft: depth ? 12 : 0 }}>
      {list.map((it, i) => (
        <li key={i}>
          <button disabled={it.page === null} onClick={() => it.page !== null && goTo(it.page)}>
            {it.title}
            {it.page !== null && <small>{it.page + 1}</small>}
          </button>
          {it.items.length > 0 && render(it.items, depth + 1)}
        </li>
      ))}
    </ul>
  );
  return render(items, 0);
}

function Search({ texts, query, setQuery, goTo }: Props) {
  const [local, setLocal] = useState(query);
  const [caseSens, setCaseSens] = useState(false);
  const hits = useMemo<SearchHit[]>(() => {
    if (!texts || query.trim().length < 2) return [];
    const q = caseSens ? query : query.toLowerCase();
    const out: SearchHit[] = [];
    for (const t of texts) {
      const hay = caseSens ? t.text : t.text.toLowerCase();
      let i = hay.indexOf(q);
      while (i >= 0 && out.length < 500) {
        const s = Math.max(0, i - 40);
        out.push({ page: t.page, index: i, snippet: t.text.slice(s, i + q.length + 60).replace(/\s+/g, ' ') });
        i = hay.indexOf(q, i + q.length);
      }
    }
    return out;
  }, [texts, query, caseSens]);

  return (
    <div className="search">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(local);
        }}
      >
        <input autoFocus type="search" placeholder="Rechercher dans le document…" value={local} onChange={(e) => setLocal(e.target.value)} />
      </form>
      <label className="check">
        <input type="checkbox" checked={caseSens} onChange={(e) => setCaseSens(e.target.checked)} /> Respecter la casse
      </label>
      {!texts && <p className="empty">Indexation du texte…</p>}
      {texts && query.length >= 2 && <p className="muted">{hits.length} résultat(s)</p>}
      <ul className="hits">
        {hits.map((h, i) => (
          <li key={i}>
            <button onClick={() => goTo(h.page)}>
              <small>p. {h.page + 1}</small> {highlight(h.snippet, query)}
            </button>
          </li>
        ))}
      </ul>
      {texts && query.length >= 2 && hits.length === 0 && (
        <p className="empty">Aucun résultat. Si c'est un scan, lancez l'OCR (panneau Outils).</p>
      )}
    </div>
  );
}

function highlight(s: string, q: string) {
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return s;
  return (
    <>
      {s.slice(0, i)}
      <mark>{s.slice(i, i + q.length)}</mark>
      {s.slice(i + q.length)}
    </>
  );
}

function AnnList({ annotations, goTo, onDelete }: Props) {
  if (!annotations.length) return <p className="empty">Aucune annotation. Choisissez un outil dans la barre du haut.</p>;
  const sorted = [...annotations].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  return (
    <ul className="ann-list">
      {sorted.map((a) => (
        <li key={a.id}>
          <button onClick={() => goTo(a.page)}>
            <span className="swatch" style={{ background: a.color }} />
            <b>{KIND_LABEL[a.kind]}</b> <small>p. {a.page + 1}</small>
            {a.text && <q>{a.text.slice(0, 140)}</q>}
          </button>
          <button className="icon" title="Supprimer" onClick={() => onDelete(a.id)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Carnet : toutes les notes et surlignages, tous documents confondus. */
function Notebook() {
  const [mems, setMems] = useState<DocMemory[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    allMemories().then(setMems);
  }, []);
  if (!mems) return <p className="empty">Chargement…</p>;
  const f = filter.toLowerCase();
  const items = mems.flatMap((m) =>
    m.annotations.filter((a) => a.text && (!f || a.text.toLowerCase().includes(f) || m.name.toLowerCase().includes(f))).map((a) => ({ m, a })),
  );
  return (
    <div className="notebook">
      <p className="muted">Vos surlignages et notes de tous vos documents, conservés sur cet appareil.</p>
      <input type="search" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {items.length === 0 && <p className="empty">Rien pour l'instant.</p>}
      <ul className="ann-list">
        {items.map(({ m, a }) => (
          <li key={m.fingerprint + a.id}>
            <div>
              <span className="swatch" style={{ background: a.color }} />
              <small>
                {m.name} · p. {a.page + 1}
              </small>
              <q>{a.text}</q>
            </div>
          </li>
        ))}
      </ul>
      {mems.length > 0 && (
        <details>
          <summary>Documents mémorisés ({mems.length})</summary>
          <ul className="mem-docs">
            {mems.map((m) => (
              <li key={m.fingerprint}>
                {m.name} <small>({m.annotations.length})</small>
                <button
                  className="link"
                  onClick={async () => {
                    await forgetMemory(m.fingerprint);
                    setMems(await allMemories());
                  }}
                >
                  oublier
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
