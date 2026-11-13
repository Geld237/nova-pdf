import { useEffect, useRef, useState } from 'react';
import { allNotes, loadNotes, saveNotes, type DocNotes } from '../memory';
import { baseName, download } from '../pdf/tools';
import type { Annotation } from '../types';

interface Props {
  fingerprint: string;
  docName: string;
  currentPage: number;
  annotations: Annotation[];
  goTo: (p: number) => void;
}

/** Prise de notes liée au document : citations, renvois de page, export Markdown. */
export function NotesPanel(p: Props) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<'edit' | 'preview' | 'all'>('edit');
  const [saved, setSaved] = useState(true);
  const [others, setOthers] = useState<DocNotes[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);

  // chargement + rechargement quand l'IA ajoute un bloc
  useEffect(() => {
    let alive = true;
    const load = () =>
      loadNotes(p.fingerprint).then((n) => {
        if (!alive) return;
        setText(n?.text ?? '');
        setLoaded(true);
      });
    load();
    const onChange = (e: Event) => (e as CustomEvent).detail === p.fingerprint && load();
    window.addEventListener('nova:notes-changed', onChange);
    return () => {
      alive = false;
      window.removeEventListener('nova:notes-changed', onChange);
    };
  }, [p.fingerprint]);

  // sauvegarde automatique
  useEffect(() => {
    if (!loaded) return;
    setSaved(false);
    const t = setTimeout(async () => {
      await saveNotes({ fingerprint: p.fingerprint, name: p.docName, text, updatedAt: Date.now() });
      setSaved(true);
    }, 500);
    return () => clearTimeout(t);
  }, [text, loaded, p.fingerprint, p.docName]);

  useEffect(() => {
    if (mode === 'all') allNotes().then(setOthers);
  }, [mode]);

  const insert = (snippet: string) => {
    const el = ta.current;
    if (!el || mode !== 'edit') {
      setText((t) => `${t.trimEnd()}${t.trim() ? '\n\n' : ''}${snippet}`);
      return;
    }
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const before = text.slice(0, s);
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    const next = `${before}${sep}${snippet}\n${text.slice(e)}`;
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = (before + sep + snippet).length + 1;
      el.setSelectionRange(pos, pos);
    });
  };

  const quoteSelection = () => {
    const sel = window.getSelection()?.toString().replace(/\s+/g, ' ').trim();
    if (!sel) {
      alert("Sélectionnez d'abord un passage dans le document.");
      return;
    }
    insert(`> « ${sel} » [p. ${p.currentPage + 1}]\n`);
  };

  const importHighlights = () => {
    const hl = p.annotations
      .filter((a) => a.text && ['highlight', 'underline', 'note'].includes(a.kind))
      .sort((a, b) => a.page - b.page);
    if (!hl.length) {
      alert('Aucun surlignage ni note avec du texte dans ce document.');
      return;
    }
    insert(`## Mes surlignages\n\n${hl.map((a) => `- ${a.kind === 'note' ? '🗨 ' : ''}${a.text} [p. ${a.page + 1}]`).join('\n')}\n`);
  };

  const now = new Date().toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="panel notes-panel">
      <header className="panel-head">
        <h2>Notes</h2>
        <small className="muted">{saved ? '✓ enregistré' : '…'}</small>
      </header>
      <div className="seg">
        <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>Écrire</button>
        <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Aperçu</button>
        <button className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>Tous mes documents</button>
      </div>

      {mode !== 'all' && (
        <div className="notes-tools">
          <button onClick={quoteSelection} title="Insère le passage sélectionné avec sa page">❝ Citer la sélection</button>
          <button onClick={() => insert(`[p. ${p.currentPage + 1}] `)} title="Renvoi cliquable vers la page courante">↪ Page {p.currentPage + 1}</button>
          <button onClick={importHighlights}>Importer mes surlignages</button>
          <button onClick={() => insert(`### ${now}\n`)}>🕑 Date</button>
          <button onClick={() => insert('- [ ] ')}>☐ Tâche</button>
        </div>
      )}

      {mode === 'edit' && (
        <textarea
          ref={ta}
          className="notes-editor"
          placeholder={'Vos notes sur ce document…\n\nAstuces :\n• [p. 12] crée un lien vers la page 12\n• # Titre, - liste, **gras**, > citation\n• L’assistant IA peut ajouter ses réponses ici'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {mode === 'preview' && (
        <div className="notes-preview">
          {text.trim() ? <MiniMarkdown text={text} goTo={p.goTo} onToggle={setText} /> : <p className="empty">Rien à afficher.</p>}
        </div>
      )}
      {mode === 'all' && (
        <div className="notes-all">
          {others.length === 0 && <p className="empty">Aucune note pour l'instant.</p>}
          {others.map((n) => (
            <details key={n.fingerprint} open={n.fingerprint === p.fingerprint}>
              <summary>
                {n.name} <small className="muted">· {new Date(n.updatedAt).toLocaleDateString('fr-FR')}</small>
              </summary>
              <pre>{n.text}</pre>
            </details>
          ))}
        </div>
      )}

      {mode !== 'all' && (
        <footer className="row">
          <small className="muted">{words} mot(s)</small>
          <span className="spacer" />
          <button onClick={() => navigator.clipboard?.writeText(text)}>Copier</button>
          <button
            onClick={() =>
              download(`# Notes — ${p.docName}\n\n${text}\n`, `${baseName(p.docName)}-notes.md`, 'text/markdown;charset=utf-8')
            }
          >
            Exporter .md
          </button>
        </footer>
      )}
    </div>
  );
}

/** Rendu Markdown minimal et sûr (sans HTML injecté) avec renvois de page cliquables. */
function MiniMarkdown({ text, goTo, onToggle }: { text: string; goTo: (p: number) => void; onToggle: (t: string) => void }) {
  const lines = text.split('\n');
  const inline = (s: string, key: number) => {
    const parts = s.split(/(\[p\.?\s*\d+\]|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
    return (
      <span key={key}>
        {parts.map((part, i) => {
          const m = part.match(/^\[p\.?\s*(\d+)\]$/);
          if (m) return <button key={i} className="cite" onClick={() => goTo(+m[1] - 1)}>{part}</button>;
          if (/^\*\*.+\*\*$/.test(part)) return <b key={i}>{part.slice(2, -2)}</b>;
          if (/^\*.+\*$/.test(part)) return <i key={i}>{part.slice(1, -1)}</i>;
          if (/^`.+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
          return part;
        })}
      </span>
    );
  };
  return (
    <div className="md">
      {lines.map((l, i) => {
        if (/^###\s/.test(l)) return <h4 key={i}>{inline(l.slice(4), i)}</h4>;
        if (/^##\s/.test(l)) return <h3 key={i}>{inline(l.slice(3), i)}</h3>;
        if (/^#\s/.test(l)) return <h2 key={i}>{inline(l.slice(2), i)}</h2>;
        if (/^>\s?/.test(l)) return <blockquote key={i}>{inline(l.replace(/^>\s?/, ''), i)}</blockquote>;
        const task = l.match(/^- \[( |x)\] (.*)$/i);
        if (task)
          return (
            <label key={i} className="check">
              <input
                type="checkbox"
                checked={task[1].toLowerCase() === 'x'}
                onChange={(e) => {
                  const copy = [...lines];
                  copy[i] = `- [${e.target.checked ? 'x' : ' '}] ${task[2]}`;
                  onToggle(copy.join('\n'));
                }}
              />
              {inline(task[2], i)}
            </label>
          );
        if (/^[-*]\s/.test(l)) return <div key={i} className="li">• {inline(l.slice(2), i)}</div>;
        if (!l.trim()) return <div key={i} className="gap" />;
        return <p key={i}>{inline(l, i)}</p>;
      })}
    </div>
  );
}
