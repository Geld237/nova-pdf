import { useMemo, useRef, useState } from 'react';
import { chat, listOllamaModels, WEBLLM_MODELS, webGpuAvailable, type AiSettings, type ChatMessage } from '../ai/llm';
import { Bm25Index, chunkPages } from '../ai/retrieval';
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
}

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

  const ask = async () => {
    const q = input.trim();
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

      <div className="ai-actions">
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
            <Cited text={m.content || '…'} goTo={p.goTo} />
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
          placeholder={p.texts ? 'Votre question sur le document…' : 'Indexation…'}
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
          <button type="submit" disabled={!input.trim() || !p.texts}>
            Envoyer
          </button>
        )}
      </form>
    </div>
  );
}

/** Rend les citations [p. N] cliquables. */
function Cited({ text, goTo }: { text: string; goTo: (p: number) => void }) {
  const parts = text.split(/(\[p\.?\s*\d+(?:\s*[-–,]\s*\d+)*\])/gi);
  return (
    <div className="cited">
      {parts.map((part, i) => {
        const m = part.match(/\[p\.?\s*(\d+)/i);
        return m ? (
          <button key={i} className="cite" onClick={() => goTo(parseInt(m[1], 10) - 1)}>
            {part}
          </button>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </div>
  );
}
