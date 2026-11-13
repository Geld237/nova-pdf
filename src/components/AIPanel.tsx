import { useEffect, useMemo, useRef, useState } from 'react';
import { chat, listOllamaModels, WEBLLM_MODELS, webGpuAvailable, type AiSettings, type ChatMessage } from '../ai/llm';
import { Bm25Index, chunkPages, type Chunk } from '../ai/retrieval';
import { saveSetting } from '../memory';
import type { Annotation, PageText } from '../types';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  texts: PageText[] | null;
  currentPage: number;
  annotations: Annotation[];
  settings: AiSettings;
  setSettings: (s: AiSettings) => void;
  goTo: (p: number) => void;
  onToNotes: (text: string) => void;
  /** Documents pour les questions multi-documents (onglets ouverts ou bibliothèque). */
  corpus: (scope: 'tabs' | 'library') => Promise<CorpusDoc[]>;
  openAt: (docId: string, page: number) => void;
}

export interface CorpusDoc {
  id: string;
  name: string;
  texts: PageText[];
}

type Scope = 'doc' | 'tabs' | 'library';

const SYSTEM =
  "Tu es l'assistant de lecture de Nova PDF. Tu réponds dans la langue de l'utilisateur, de façon précise et concise. " +
  "Tu t'appuies uniquement sur les extraits du document fournis. Après chaque affirmation, cite la page entre crochets, " +
  "par exemple [p. 3]. Si l'information n'est pas dans les extraits, dis-le.";

const BUDGET = 5500; // caractères de contexte par appel (petits modèles locaux)

export function AIPanel(p: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ text: string; ratio: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [lang, setLang] = useState('anglais');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const [scope, setScope] = useState<Scope>('doc');
  const [docs, setDocs] = useState<CorpusDoc[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (scope === 'doc') return;
    p.corpus(scope).then((d) => {
      setDocs(d);
      setSelected(new Set(d.slice(0, 8).map((x) => x.id)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const active = docs.filter((d) => selected.has(d.id));
  const multiIndex = useMemo(() => {
    if (scope === 'doc' || !active.length) return null;
    const chunks: (Chunk & { doc: number })[] = [];
    active.forEach((d, k) => chunkPages(d.texts).forEach((c) => chunks.push({ ...c, id: chunks.length, doc: k })));
    return new Bm25Index(chunks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, docs, selected]);
  const legend = active.map((d, k) => `D${k + 1} = « ${d.name} »`).join('\n');

  const index = useMemo(() => (p.texts ? new Bm25Index(chunkPages(p.texts)) : null), [p.texts]);
  const totalChars = p.texts?.reduce((n, t) => n + t.text.length, 0) ?? 0;

  const update = (s: Partial<AiSettings>) => {
    const next = { ...p.settings, ...s };
    p.setSettings(next);
    saveSetting('ai', next);
  };

  /** Lance un appel au modèle et affiche la réponse en streaming. */
  const run = async (userLabel: string, messages: ChatMessage[], silentUser = false): Promise<string> => {
    setError(null);
    setBusy(true);
    abort.current = new AbortController();
    if (!silentUser) setMsgs((m) => [...m, { role: 'user', content: userLabel }]);
    setMsgs((m) => [...m, { role: 'assistant', content: '' }]);
    try {
      const out = await chat(
        p.settings,
        messages,
        (t) =>
          setMsgs((m) => {
            const c = [...m];
            c[c.length - 1] = { role: 'assistant', content: c[c.length - 1].content + t };
            return c;
          }),
        (text, ratio) => setProgress(ratio >= 1 ? null : { text, ratio }),
        abort.current.signal,
      );
      setProgress(null);
      return out;
    } catch (e) {
      setMsgs((m) => (m[m.length - 1]?.content === '' ? m.slice(0, -1) : m));
      setError((e as Error).message);
      setProgress(null);
      return '';
    } finally {
      setBusy(false);
    }
  };

  const pagesText = (pages: PageText[]) => pages.map((t) => `[p. ${t.page + 1}]\n${t.text}`).join('\n\n');

  const summarizeDoc = async () => {
    if (!p.texts) return;
    if (totalChars <= BUDGET) {
      await run('Résume ce document', [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Document :\n${pagesText(p.texts)}\n\nFais un résumé structuré (titre, 5 à 8 points clés, conclusion), avec les pages citées.` },
      ]);
      return;
    }
    // Map-reduce : on résume des groupes de pages, puis on combine.
    const groups: PageText[][] = [];
    let cur: PageText[] = [];
    let n = 0;
    for (const t of p.texts) {
      if (n + t.text.length > BUDGET && cur.length) {
        groups.push(cur);
        cur = [];
        n = 0;
      }
      cur.push({ ...t, text: t.text.slice(0, BUDGET) });
      n += Math.min(t.text.length, BUDGET);
    }
    if (cur.length) groups.push(cur);
    const MAX = 10;
    const picked = groups.length > MAX ? Array.from({ length: MAX }, (_, i) => groups[Math.floor((i * groups.length) / MAX)]) : groups;
    setMsgs((m) => [...m, { role: 'user', content: `Résume ce document (${p.texts!.length} pages, en ${picked.length} parties)` }]);
    const partials: string[] = [];
    for (let i = 0; i < picked.length; i++) {
      const g = picked[i];
      const label = `Partie ${i + 1}/${picked.length} (p. ${g[0].page + 1}–${g[g.length - 1].page + 1})`;
      const out = await run(label, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Extrait :\n${pagesText(g)}\n\nRésume cet extrait en 3 à 5 puces, en citant les pages.` },
      ], true);
      if (!out) return;
      partials.push(`${label}\n${out}`);
    }
    await run('Synthèse finale', [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Voici les résumés partiels d'un document :\n\n${partials.join('\n\n').slice(0, BUDGET * 1.2)}\n\nRédige la synthèse globale : une phrase d'ensemble, puis 6 à 8 points clés avec pages citées.` },
    ], true);
  };

  const pageAction = (instruction: string, label: string) => {
    const t = p.texts?.[p.currentPage];
    if (!t?.text) {
      setError("Cette page n'a pas de texte extractible (scan ?). Lancez l'OCR dans Outils.");
      return;
    }
    return run(label, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Page ${p.currentPage + 1} :\n${t.text.slice(0, BUDGET)}\n\n${instruction}` },
    ]);
  };

  const explainSelection = () => {
    const sel = window.getSelection()?.toString().trim();
    if (!sel) {
      setError('Sélectionnez d’abord un passage dans le document.');
      return;
    }
    const ctx = p.texts?.[p.currentPage]?.text.slice(0, 3000) ?? '';
    run(`Explique : « ${sel.slice(0, 120)}${sel.length > 120 ? '…' : ''} »`, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Contexte (page ${p.currentPage + 1}) :\n${ctx}\n\nExplique simplement ce passage, définis les termes techniques et donne un exemple :\n« ${sel} »` },
    ]);
  };

  // Commandes reçues du menu contextuel (« Expliquer », « Traduire », « Résumer »)
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { action: 'explain' | 'translate' | 'ask'; text: string };
      setScope('doc');
      if (d.action === 'explain') {
        const ctx = p.texts?.[p.currentPage]?.text.slice(0, 3000) ?? '';
        run(`Explique : « ${d.text.slice(0, 120)}${d.text.length > 120 ? '…' : ''} »`, [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Contexte (page ${p.currentPage + 1}) :\n${ctx}\n\nExplique simplement ce passage, définis les termes techniques et donne un exemple :\n« ${d.text} »` },
        ]);
      } else if (d.action === 'translate') {
        run(`Traduire : « ${d.text.slice(0, 80)}… »`, [
          { role: 'system', content: 'Tu es un traducteur. Traduis fidèlement en français si le texte est dans une autre langue, sinon en anglais. Réponds uniquement par la traduction.' },
          { role: 'user', content: d.text },
        ]);
      } else setInput(d.text);
    };
    window.addEventListener('nova:ai', h);
    return () => window.removeEventListener('nova:ai', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.texts, p.currentPage, p.settings]);

  const flashcards = () => {
    const hl = p.annotations.filter((a) => a.text && (a.kind === 'highlight' || a.kind === 'note'));
    const source = hl.length
      ? hl.map((a) => `[p. ${a.page + 1}] ${a.text}`).join('\n')
      : p.texts?.[p.currentPage]?.text ?? '';
    run(hl.length ? `Fiches de révision à partir de mes ${hl.length} surlignages` : `Fiches de révision (page ${p.currentPage + 1})`, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${source.slice(0, BUDGET)}\n\nCrée 6 à 10 fiches de révision au format :\nQ : question\nR : réponse courte [p. N]` },
    ]);
  };

  const MULTI_SYSTEM =
    "Tu es l'assistant de recherche de Nova PDF. Tu compares et croises plusieurs documents. Réponds dans la langue de l'utilisateur. " +
    "Appuie-toi uniquement sur les extraits fournis et cite chaque affirmation sous la forme [D2, p. 4] (document, page). " +
    "Signale clairement les contradictions et les différences entre documents.";

  const askMulti = async (q: string) => {
    if (!multiIndex) return;
    const ctx = multiIndex.search(q, 10) as (Chunk & { doc: number })[];
    // au moins un extrait par document si possible
    for (let k = 0; k < active.length; k++)
      if (!ctx.some((c) => c.doc === k)) {
        const first = (multiIndex.chunks as (Chunk & { doc: number })[]).find((c) => c.doc === k);
        if (first) ctx.push(first);
      }
    let used = 0;
    const extracts = ctx
      .filter((c) => (used += Math.min(c.text.length, 700)) <= BUDGET + 600)
      .map((c) => `[D${c.doc + 1}, p. ${c.page + 1}]\n${c.text.slice(0, 700)}`)
      .join('\n---\n');
    await run(q, [
      { role: 'system', content: MULTI_SYSTEM },
      { role: 'user', content: `Documents :\n${legend}\n\nExtraits :\n${extracts}\n\nQuestion : ${q}` },
    ]);
  };

  /** Analyse document par document puis synthèse (comparaison de contrats, revue de littérature). */
  const crossAnalysis = async (kind: 'contracts' | 'review') => {
    if (active.length < 2) {
      setError('Sélectionnez au moins deux documents.');
      return;
    }
    const grid =
      kind === 'contracts'
        ? 'parties, objet, durée et date d’effet, prix et modalités de paiement, résiliation et préavis, responsabilité et garanties, confidentialité, pénalités, clauses inhabituelles'
        : 'question / objectif, méthode, échantillon ou données, principaux résultats, limites, apport';
    setMsgs((m) => [...m, { role: 'user', content: kind === 'contracts' ? `Comparer ${active.length} contrats` : `Revue de littérature (${active.length} documents)` }]);
    const parts: string[] = [];
    for (let k = 0; k < active.length; k++) {
      const d = active[k];
      let text = '';
      for (const t of d.texts) {
        if (text.length > BUDGET) break;
        text += `[p. ${t.page + 1}] ${t.text}\n`;
      }
      const out = await run(`D${k + 1} — ${d.name}`, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Document « ${d.name} » :\n${text.slice(0, BUDGET)}\n\nExtrais en puces courtes : ${grid}. Cite les pages. Écris « non précisé » si absent.` },
      ], true);
      if (!out) return;
      parts.push(`D${k + 1} « ${d.name} » :\n${out}`);
    }
    await run('Synthèse comparative', [
      { role: 'system', content: MULTI_SYSTEM },
      {
        role: 'user',
        content: `${parts.join('\n\n').slice(0, BUDGET * 1.4)}\n\n${
          kind === 'contracts'
            ? 'Fais un tableau Markdown comparant les contrats ligne par ligne (une colonne par document), puis liste les différences importantes et les points de vigilance.'
            : 'Fais un tableau Markdown de synthèse (une ligne par document), puis rédige une synthèse : convergences, divergences, lacunes de la littérature.'
        }`,
      },
    ], true);
  };

  const ask = async () => {
    const q = input.trim();
    if (scope !== 'doc') {
      if (!q) return;
      setInput('');
      await askMulti(q);
      return;
    }
    if (!q || !index) return;
    setInput('');
    let ctx = index.search(q, 6);
    if (!ctx.length) ctx = index.chunks.filter((c) => c.page === p.currentPage).slice(0, 4);
    let used = 0;
    const extracts = ctx
      .filter((c) => (used += c.text.length) <= BUDGET)
      .map((c) => `[p. ${c.page + 1}]\n${c.text}`)
      .join('\n---\n');
    const history = msgs.slice(-4).map((m) => ({ role: m.role, content: m.content.slice(0, 800) }) as ChatMessage);
    await run(q, [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: `Extraits du document :\n${extracts}\n\nQuestion : ${q}` },
    ]);
  };

  return (
    <div className="panel ai-panel">
      <header className="panel-head">
        <h2>Assistant IA local</h2>
        <button className="icon" title="Réglages" onClick={() => setShowSettings((s) => !s)}>
          ⚙
        </button>
      </header>
      <p className="privacy">🔒 Tout reste sur votre appareil : aucun texte n'est envoyé sur Internet.</p>

      <div className="seg">
        <button className={scope === 'doc' ? 'active' : ''} onClick={() => setScope('doc')}>Ce document</button>
        <button className={scope === 'tabs' ? 'active' : ''} onClick={() => setScope('tabs')}>Onglets ouverts</button>
        <button className={scope === 'library' ? 'active' : ''} onClick={() => setScope('library')}>Bibliothèque</button>
      </div>
      {scope !== 'doc' && (
        <div className="corpus">
          {docs.length === 0 && <p className="muted">Aucun document {scope === 'tabs' ? 'ouvert' : 'dans la bibliothèque'}.</p>}
          {docs.map((d) => (
            <label key={d.id} className="check">
              <input
                type="checkbox"
                checked={selected.has(d.id)}
                onChange={(e) => {
                  const n = new Set(selected);
                  if (e.target.checked) n.add(d.id);
                  else n.delete(d.id);
                  setSelected(n);
                }}
              />
              <b>D{active.findIndex((a) => a.id === d.id) + 1 || '–'}</b> {d.name} <small className="muted">({d.texts.length} p.)</small>
            </label>
          ))}
          <div className="row">
            <button disabled={busy || active.length < 2} onClick={() => crossAnalysis('contracts')}>Comparer (contrats)</button>
            <button disabled={busy || active.length < 2} onClick={() => crossAnalysis('review')}>Revue de littérature</button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="ai-settings">
          <label>
            Moteur
            <select value={p.settings.provider} onChange={(e) => update({ provider: e.target.value as AiSettings['provider'] })}>
              <option value="webllm">Dans le navigateur (WebLLM / WebGPU)</option>
              <option value="ollama">Ollama sur cet ordinateur</option>
            </select>
          </label>
          {p.settings.provider === 'webllm' ? (
            <>
              <label>
                Modèle
                <select value={p.settings.webllmModel} onChange={(e) => update({ webllmModel: e.target.value })}>
                  {WEBLLM_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              {!webGpuAvailable() && <p className="warn">WebGPU indisponible ici : utilisez Chrome/Edge récents ou Ollama.</p>}
              <p className="muted">Le modèle est téléchargé une seule fois puis mis en cache.</p>
            </>
          ) : (
            <>
              <label>
                Adresse
                <input value={p.settings.ollamaUrl} onChange={(e) => update({ ollamaUrl: e.target.value })} />
              </label>
              <label>
                Modèle
                <input list="ollama-models" value={p.settings.ollamaModel} onChange={(e) => update({ ollamaModel: e.target.value })} />
                <datalist id="ollama-models">
                  {ollamaModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <button
                onClick={() =>
                  listOllamaModels(p.settings.ollamaUrl)
                    .then(setOllamaModels)
                    .catch(() => setError('Ollama injoignable (voir README pour OLLAMA_ORIGINS).'))
                }
              >
                Détecter les modèles
              </button>
            </>
          )}
        </div>
      )}

      <div className="ai-actions" style={{ display: scope === 'doc' ? undefined : 'none' }}>
        <button disabled={busy || !p.texts} onClick={summarizeDoc}>Résumer le document</button>
        <button disabled={busy || !p.texts} onClick={() => pageAction('Résume cette page en 3 à 5 puces.', `Résume la page ${p.currentPage + 1}`)}>
          Résumer la page
        </button>
        <button disabled={busy} onClick={explainSelection}>Expliquer la sélection</button>
        <button disabled={busy || !p.texts} onClick={flashcards}>Fiches de révision</button>
        <button
          disabled={busy || !p.texts}
          onClick={() => pageAction('Liste les chiffres, dates, noms et définitions importants de cette page, sous forme de tableau Markdown.', `Données clés de la page ${p.currentPage + 1}`)}
        >
          Extraire les données
        </button>
        <span className="translate">
          <button disabled={busy || !p.texts} onClick={() => pageAction(`Traduis fidèlement cette page en ${lang}, en conservant la structure des paragraphes.`, `Traduire la page ${p.currentPage + 1} en ${lang}`)}>
            Traduire la page en
          </button>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {['anglais', 'français', 'espagnol', 'allemand', 'italien', 'portugais', 'arabe', 'chinois'].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </span>
      </div>

      {progress && (
        <div className="progress">
          <div className="bar" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
          <small>{progress.text}</small>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <div className="messages">
        {msgs.length === 0 && (
          <p className="empty">
            Posez une question sur le document. Les réponses citent les pages, cliquez sur <b>[p. N]</b> pour y aller.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <Cited text={m.content || '…'} goTo={p.goTo} openDoc={(k, page) => active[k] && p.openAt(active[k].id, page)} />
            {m.role === 'assistant' && m.content && !(busy && i === msgs.length - 1) && (
              <div className="msg-actions">
                <button className="link" onClick={() => p.onToNotes(m.content)}>→ Ajouter aux notes</button>
                <button className="link" onClick={() => navigator.clipboard?.writeText(m.content)}>Copier</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <textarea
          rows={2}
          placeholder={scope !== 'doc' ? 'Votre question sur ces documents…' : p.texts ? 'Votre question sur le document…' : 'Indexation…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || (scope === 'doc' ? !p.texts : !active.length)}>
            Envoyer
          </button>
        )}
      </form>
    </div>
  );
}

/** Rend les citations [p. N] cliquables. */
function Cited({ text, goTo, openDoc }: { text: string; goTo: (p: number) => void; openDoc: (doc: number, page: number) => void }) {
  const parts = text.split(/(\[(?:D\d+\s*,\s*)?p\.?\s*\d+(?:\s*[-–,]\s*\d+)*\])/gi);
  return (
    <div className="cited">
      {parts.map((part, i) => {
        const m = part.match(/\[(?:D(\d+)\s*,\s*)?p\.?\s*(\d+)/i);
        return m ? (
          <button key={i} className="cite" onClick={() => (m[1] ? openDoc(+m[1] - 1, +m[2] - 1) : goTo(parseInt(m[2], 10) - 1))}>
            {part}
          </button>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </div>
  );
}
