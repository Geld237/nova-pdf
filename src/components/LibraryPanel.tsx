import { useEffect, useMemo, useState } from 'react';
import { ui } from '../dialogs';
import { semanticSearch } from '../semantic';
import { listLibrary, removeFromLibrary, searchLibrary, updateLibItem, type LibHit, type LibItem } from '../library';

interface Props {
  onOpen: (id: string, page?: number) => void;
  onImport: () => void;
  activeId?: string;
  onItemMenu?: (e: React.MouseEvent, item: LibItem) => void;
  ollamaUrl?: string;
}

/** Bibliothèque : dossiers, étiquettes, favoris, recherche dans tous les PDF. */
export function LibraryPanel({ onOpen, onImport, activeId, onItemMenu, ollamaUrl = 'http://localhost:11434' }: Props) {
  const [items, setItems] = useState<LibItem[]>([]);
  const [folder, setFolder] = useState<string | null>(null); // null = tous
  const [tag, setTag] = useState<string | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<(LibHit & { score?: number })[] | null>(null);
  const [mode, setMode] = useState<'words' | 'meaning'>('words');
  const [engine, setEngine] = useState('');
  const [searching, setSearching] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = () => listLibrary().then(setItems);
  useEffect(() => {
    refresh();
    window.addEventListener('nova:library-changed', refresh);
    return () => window.removeEventListener('nova:library-changed', refresh);
  }, []);

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const i of items)
      if (i.folder) {
        const parts = i.folder.split('/');
        parts.forEach((_, k) => set.add(parts.slice(0, k + 1).join('/')));
      }
    return [...set].sort();
  }, [items]);
  const tags = useMemo(() => [...new Set(items.flatMap((i) => i.tags))].sort(), [items]);

  const shown = items.filter(
    (i) =>
      (folder === null || i.folder === folder || i.folder.startsWith(folder + '/')) &&
      (!tag || i.tags.includes(tag)) &&
      (!favOnly || i.favorite),
  );

  const runSearch = async () => {
    if (q.trim().length < 2) return setHits(null);
    if (mode === 'words') {
      setEngine('');
      return setHits(await searchLibrary(q));
    }
    setSearching('Recherche…');
    try {
      const r = await semanticSearch(q, ollamaUrl, setSearching);
      setEngine(r.engine);
      setHits(r.hits);
    } finally {
      setSearching(null);
    }
  };
  const totalMb = items.reduce((s, i) => s + i.size, 0) / 1048576;

  return (
    <div className="panel library-panel">
      <header className="panel-head">
        <h2>Bibliothèque</h2>
        <button onClick={onImport}>+ Importer</button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <input
          type="search"
          placeholder={mode === 'words' ? 'Rechercher dans tous vos PDF…' : 'Décrivez ce que vous cherchez (ex. « le contrat qui parle de résiliation »)'}
          value={q}
          onChange={(e) => { setQ(e.target.value); if (!e.target.value) setHits(null); }}
        />
        <div className="seg search-mode">
          <button type="button" className={mode === 'words' ? 'active' : ''} onClick={() => setMode('words')}>Mots exacts</button>
          <button type="button" className={mode === 'meaning' ? 'active' : ''} onClick={() => setMode('meaning')} title="Trouve aussi les passages qui parlent du même sujet avec d'autres mots">Par le sens</button>
        </div>
        {searching && <small className="muted">⏳ {searching}</small>}
      </form>

      {hits ? (
        <>
          <p className="muted">
            {hits.length} résultat(s) dans {new Set(hits.map((h) => h.item.id)).size} document(s){' '}
            <button className="link" onClick={() => setHits(null)}>fermer</button>
          </p>
          {engine && (
            <p className="muted small">
              Recherche {engine}.{' '}
              {engine.startsWith('locale') && <>Pour une vraie recherche par le sens, installez un modèle d’embeddings dans Ollama : <code>ollama pull nomic-embed-text</code></>}
            </p>
          )}
          <ul className="hits">
            {hits.map((h, i) => (
              <li key={i}>
                <button onClick={() => onOpen(h.item.id, h.page)}>
                  <b>{h.item.name}</b> <small>p. {h.page + 1}</small>
                  <br />
                  {h.snippet}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="lib-filters">
            <button className={folder === null && !tag && !favOnly ? 'active' : ''} onClick={() => { setFolder(null); setTag(null); setFavOnly(false); }}>
              Tous ({items.length})
            </button>
            <button className={favOnly ? 'active' : ''} onClick={() => setFavOnly(!favOnly)}>★ Favoris</button>
            {folders.map((f) => (
              <button key={f} className={folder === f ? 'active' : ''} onClick={() => setFolder(folder === f ? null : f)} style={{ paddingLeft: 8 + (f.split('/').length - 1) * 10 }}>
                📁 {f.split('/').pop()}
              </button>
            ))}
            {tags.map((t) => (
              <button key={t} className={`tag ${tag === t ? 'active' : ''}`} onClick={() => setTag(tag === t ? null : t)}>
                #{t}
              </button>
            ))}
          </div>

          {shown.length === 0 && (
            <p className="empty">
              {items.length ? 'Aucun document ici.' : 'Les PDF que vous ouvrez sont rangés ici automatiquement. Vous pouvez aussi en importer.'}
            </p>
          )}
          <ul className="lib-list">
            {shown.map((i) => (
              <li key={i.id} className={i.id === activeId ? 'current' : ''} onContextMenu={(e) => onItemMenu?.(e, i)}>
                <button className="lib-open" onClick={() => onOpen(i.id)} title="Ouvrir">
                  <span className="lib-icon">📄</span>
                  <span className="lib-name">
                    {i.name}
                    <small>
                      {i.pages} p. · {(i.size / 1048576).toFixed(1)} Mo · {new Date(i.openedAt).toLocaleDateString('fr-FR')}
                      {i.folder && ` · 📁 ${i.folder}`}
                    </small>
                    {i.tags.length > 0 && <small className="tags">{i.tags.map((t) => `#${t}`).join(' ')}</small>}
                  </span>
                </button>
                <button className="icon" title="Favori" onClick={() => updateLibItem(i.id, { favorite: !i.favorite })}>
                  {i.favorite ? '★' : '☆'}
                </button>
                <button className="icon" title="Ranger / étiqueter" onClick={() => setEditing(editing === i.id ? null : i.id)}>
                  ⋯
                </button>
                {editing === i.id && <Editor item={i} folders={folders} onDone={() => setEditing(null)} />}
              </li>
            ))}
          </ul>
          <p className="muted small">{items.length} document(s) · {totalMb.toFixed(1)} Mo sur cet appareil</p>
        </>
      )}
    </div>
  );
}

function Editor({ item, folders, onDone }: { item: LibItem; folders: string[]; onDone: () => void }) {
  const [folder, setFolder] = useState(item.folder);
  const [tags, setTags] = useState(item.tags.join(', '));
  return (
    <div className="lib-editor">
      <label>
        Dossier (ex. Cours/Chimie)
        <input list="lib-folders" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <datalist id="lib-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
      </label>
      <label>
        Étiquettes (séparées par des virgules)
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <div className="row">
        <button
          className="primary"
          onClick={async () => {
            await updateLibItem(item.id, {
              folder: folder.trim().replace(/^\/+|\/+$/g, ''),
              tags: tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
            });
            onDone();
          }}
        >
          Enregistrer
        </button>
        <button
          className="danger"
          onClick={async () => {
            if (await ui.confirm(`Retirer « ${item.name} » de la bibliothèque ?`, { ok: 'Retirer', danger: true })) await removeFromLibrary(item.id);
            onDone();
          }}
        >
          Retirer
        </button>
      </div>
    </div>
  );
}
