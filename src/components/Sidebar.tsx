import { useEffect, useMemo, useRef, useState } from 'react';
import { useSortable } from './useSortable';
import type { PDFDocumentProxy } from '../pdf/engine';
import type { Annotation, OutlineItem, PageText, SearchHit } from '../types';
import { allMemories, forgetMemory, type DocMemory } from '../memory';
import { Thumb } from './Thumb';
import { Icon } from '../icons';

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
  onThumbMenu: (e: React.MouseEvent, page: number, selected?: number[]) => void;
  /** actions de pages directement depuis la colonne Pages */
  pageActions?: {
    reorder: (from: number[], to: number) => void;
    remove: (pages: number[]) => void;
    rotate: (pages: number[], deg: number) => void;
    duplicate: (pages: number[]) => void;
    insert: (at: number, kind: 'pdf' | 'images' | 'scan' | 'blank') => void;
    organize: () => void;
  };
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
            ['pages', 'Pages'],
            ['outline', 'Sommaire'],
            ['search', 'Recherche'],
            ['annotations', 'Annotations'],
            ['notebook', 'Carnet'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={p.tab === id} className={p.tab === id ? 'active' : ''} onClick={() => p.setTab(id)} title={label}>
            <Icon name={id} size={19} />
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

function Pages({ doc, numPages, current, goTo, onThumbMenu, pageActions: act }: Props) {
  const [sel, setSel] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setSel([]), [doc]);
  const { st, handle } = useSortable({
    axis: 'y',
    container: box,
    pick: (i) => (sel.includes(i) ? [...sel].sort((a, b) => a - b) : [i]),
    onDrop: (from, to) => {
      act?.reorder(from, to);
      setSel([]);
    },
  });
  const click = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor != null) {
      const [lo, hi] = anchor < i ? [anchor, i] : [i, anchor];
      setSel(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSel((l) => (l.includes(i) ? l.filter((x) => x !== i) : [...l, i]));
      setAnchor(i);
      return;
    }
    setSel([]);
    setAnchor(i);
    goTo(i);
  };
  const target = sel.length ? sel : [current];
  return (
    <div
      className="thumbs-wrap"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!act) return;
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
          e.preventDefault();
          act.remove(sel);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          setSel(Array.from({ length: numPages }, (_, i) => i));
        } else if (e.key === 'Escape') setSel([]);
      }}
    >
      {act && (
        <div className="thumbs-bar">
          <button title="Insérer des pages après la page affichée ou la sélection" onClick={(e) => onThumbMenu(e, Math.max(...target), target)}>＋</button>
          <button title="Pivoter à gauche" onClick={() => act.rotate(target, -90)}>↺</button>
          <button title="Pivoter à droite" onClick={() => act.rotate(target, 90)}>↻</button>
          <button title="Dupliquer" onClick={() => act.duplicate(target)}>⧉</button>
          <button title="Supprimer" className="danger" onClick={() => act.remove(target)}>🗑</button>
          <button title="Organiser toutes les pages en grand" onClick={act.organize}>▦</button>
          <small className="muted">{sel.length > 1 ? `${sel.length} sélectionnées` : 'Glissez pour classer'}</small>
        </div>
      )}
      <div className="thumbs" ref={box}>
        {Array.from({ length: numPages }, (_, i) => (
          <div key={i} className="thumb-slot">
            {st.dragging && st.insertAt === i && <div className="insert-line" />}
            <button
              {...(act ? handle(i) : {})}
              className={`thumb ${i === current ? 'current' : ''} ${sel.includes(i) ? 'selected' : ''} ${st.dragging?.includes(i) ? 'lifting' : ''}`}
              onClick={(e) => click(i, e)}
              onContextMenu={(e) => {
                const l = sel.includes(i) ? sel : [i];
                if (!sel.includes(i)) setSel([]);
                onThumbMenu(e, i, l);
              }}
            >
              <Thumb doc={doc} page={i} width={110} />
              <span>{i + 1}</span>
            </button>
          </div>
        ))}
        {st.dragging && st.insertAt === numPages && <div className="insert-line" />}
      </div>
      {st.dragging && st.pos && (
        <div className="drag-badge" style={{ left: st.pos.x + 12, top: st.pos.y + 12 }}>
          {st.dragging.length > 1 ? `${st.dragging.length} pages` : `Page ${st.dragging[0] + 1}`}
        </div>
      )}
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
