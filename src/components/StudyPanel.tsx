import { useEffect, useRef, useState } from 'react';
import { AbortedError, chat, type AiSettings } from '../ai/llm';
import {
  allDecks, dueCards, loadDeck, newCard, nextIntervalLabel, parseCards, parseQuiz, quizFromCards, saveDeck, schedule,
  type Card, type Deck, type Grade, type QuizQuestion,
} from '../study';
import type { Annotation, PageText } from '../types';

interface Props {
  fingerprint: string;
  docName: string;
  texts: PageText[] | null;
  currentPage: number;
  annotations: Annotation[];
  ai: AiSettings;
  goTo: (p: number) => void;
}

const SYS = "Tu crées du matériel de révision fidèle au document, en français sauf si le document est dans une autre langue. Réponses courtes, sans inventer.";

/** Étude : fiches à répétition espacée et quiz. */
export function StudyPanel(p: Props) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [mode, setMode] = useState<'home' | 'review' | 'quiz'>('home');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [globalDue, setGlobalDue] = useState(0);
  const [quiz, setQuiz] = useState<QuizQuestion[]>([]);
  const [manual, setManual] = useState({ front: '', back: '' });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    loadDeck(p.fingerprint, p.docName).then(setDeck);
    allDecks().then((ds) => setGlobalDue(ds.reduce((n, d) => n + dueCards(d).length, 0)));
  }, [p.fingerprint, p.docName, mode]);

  const update = async (d: Deck) => {
    setDeck(d);
    await saveDeck(d);
  };

  const ask = async (label: string, prompt: string) => {
    setBusy(label);
    setError(null);
    abort.current = new AbortController();
    try {
      return await chat(p.ai, [{ role: 'system', content: SYS }, { role: 'user', content: prompt }], () => {}, (t) => setBusy(`${label} — ${t.slice(0, 60)}`), abort.current.signal, label);
    } catch (e) {
      if (!(e instanceof AbortedError)) setError((e as Error).message);
      return '';
    } finally {
      setBusy(null);
    }
  };

  const source = (from: 'highlights' | 'page' | 'doc') => {
    if (from === 'highlights') {
      const hl = p.annotations.filter((a) => a.text && ['highlight', 'underline', 'note'].includes(a.kind));
      return hl.map((a) => `[p. ${a.page + 1}] ${a.text}`).join('\n');
    }
    if (from === 'page') return `[p. ${p.currentPage + 1}] ${p.texts?.[p.currentPage]?.text ?? ''}`;
    // document : échantillon régulier de pages
    const t = p.texts ?? [];
    const step = Math.max(1, Math.ceil(t.length / 8));
    return t.filter((_, i) => i % step === 0).map((x) => `[p. ${x.page + 1}] ${x.text.slice(0, 700)}`).join('\n');
  };

  const generateCards = async (from: 'highlights' | 'page' | 'doc') => {
    const src = source(from).slice(0, 5500);
    if (!src.trim()) {
      setError(from === 'highlights' ? 'Aucun surlignage avec du texte dans ce document.' : 'Pas de texte (lancez l’OCR).');
      return;
    }
    const out = await ask('Création des fiches', `${src}\n\nCrée 8 à 12 fiches de révision. Format strict, une fiche par bloc :\nQ : question\nR : réponse courte [p. N]`);
    const parsed = parseCards(out);
    if (!parsed.length) {
      if (out) setError('Le modèle n’a pas produit de fiches lisibles. Réessayez ou choisissez un modèle plus grand.');
      return;
    }
    await update({ ...deck!, cards: [...deck!.cards, ...parsed.map((c) => newCard(c.front, c.back, c.page))] });
  };

  const generateQuiz = async () => {
    const src = source(p.annotations.some((a) => a.text) ? 'highlights' : 'doc').slice(0, 5500);
    const out = await ask(
      'Création du quiz',
      `${src}\n\nCrée 6 questions à choix multiples. Format strict pour chacune :\n1. Question\nA) …\nB) …\nC) …\nD) …\nRéponse : B\nExplication : … [p. N]`,
    );
    const q = parseQuiz(out);
    if (!q.length) {
      if (out) setError('Quiz illisible : réessayez, ou utilisez le quiz à partir des fiches (hors IA).');
      return;
    }
    setQuiz(q);
    setMode('quiz');
  };

  if (!deck) return <div className="panel"><p className="empty">Chargement…</p></div>;
  const due = dueCards(deck);

  if (mode === 'review') return <Review deck={deck} onSave={update} onExit={() => setMode('home')} goTo={p.goTo} />;
  if (mode === 'quiz') return <Quiz questions={quiz} onExit={() => setMode('home')} goTo={p.goTo} />;

  return (
    <div className="panel study-panel">
      <header className="panel-head">
        <h2>Étude</h2>
      </header>
      <div className="study-stats">
        <div><b>{deck.cards.length}</b><small>fiches</small></div>
        <div className={due.length ? 'due' : ''}><b>{due.length}</b><small>à réviser</small></div>
        <div><b>{deck.cards.filter((c) => c.interval >= 21).length}</b><small>maîtrisées</small></div>
      </div>
      <button className="primary" disabled={!due.length} onClick={() => setMode('review')}>
        {due.length ? `Réviser maintenant (${due.length})` : 'Rien à réviser pour le moment ✓'}
      </button>
      {globalDue > due.length && <p className="muted">{globalDue} fiche(s) à réviser au total dans votre bibliothèque.</p>}

      <h3 className="group">Créer des fiches avec l'IA</h3>
      <div className="row">
        <button disabled={!!busy} onClick={() => generateCards('highlights')}>De mes surlignages</button>
        <button disabled={!!busy || !p.texts} onClick={() => generateCards('page')}>De la page {p.currentPage + 1}</button>
        <button disabled={!!busy || !p.texts} onClick={() => generateCards('doc')}>Du document</button>
      </div>
      <h3 className="group">Quiz</h3>
      <div className="row">
        <button disabled={!!busy || !p.texts} onClick={generateQuiz}>QCM généré par l'IA</button>
        <button
          disabled={deck.cards.length < 4}
          onClick={() => {
            setQuiz(quizFromCards(deck.cards));
            setMode('quiz');
          }}
          title="Fonctionne sans IA, avec au moins 4 fiches"
        >
          QCM à partir des fiches
        </button>
      </div>
      {busy && (
        <p className="busy">
          ⏳ {busy} <button className="stop-btn" onClick={() => abort.current?.abort()}>⏹ Arrêter</button>
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <details>
        <summary>Ajouter une fiche à la main</summary>
        <label>Question<textarea rows={2} value={manual.front} onChange={(e) => setManual({ ...manual, front: e.target.value })} /></label>
        <label>Réponse<textarea rows={2} value={manual.back} onChange={(e) => setManual({ ...manual, back: e.target.value })} /></label>
        <button
          disabled={!manual.front.trim() || !manual.back.trim()}
          onClick={() => {
            const card = newCard(manual.front.trim(), manual.back.trim(), p.currentPage);
            setManual({ front: '', back: '' });
            void update({ ...deck, cards: [...deck.cards, card] });
          }}
        >
          Ajouter (page {p.currentPage + 1})
        </button>
      </details>

      {deck.cards.length > 0 && (
        <details>
          <summary>Toutes les fiches ({deck.cards.length})</summary>
          <ul className="card-list">
            {deck.cards.map((c) => (
              <li key={c.id}>
                <div>
                  <b>{c.front}</b>
                  <br />
                  {c.back} {c.page !== undefined && <button className="cite" onClick={() => p.goTo(c.page!)}>[p. {c.page + 1}]</button>}
                  <br />
                  <small className="muted">
                    prochaine révision : {new Date(c.due).toLocaleDateString('fr-FR')} · intervalle {c.interval} j
                  </small>
                </div>
                <button className="icon" title="Supprimer" onClick={() => update({ ...deck, cards: deck.cards.filter((x) => x.id !== c.id) })}>✕</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Review({ deck, onSave, onExit, goTo }: { deck: Deck; onSave: (d: Deck) => void; onExit: () => void; goTo: (p: number) => void }) {
  const [queue, setQueue] = useState<Card[]>(() => dueCards(deck).sort((a, b) => a.due - b.due));
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  const card = queue[0];

  const grade = (g: Grade) => {
    const next = schedule(card, g);
    const cards = deck.cards.map((c) => (c.id === card.id ? next : c));
    onSave({ ...deck, cards });
    setQueue((q) => (g === 0 ? [...q.slice(1), next] : q.slice(1)));
    setShown(false);
    setDone((n) => n + 1);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!card) return;
      if (e.key === ' ' && !shown) { e.preventDefault(); setShown(true); }
      else if (shown && ['1', '2', '3', '4'].includes(e.key)) grade((+e.key - 1) as Grade);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <div className="panel study-panel">
      <header className="panel-head">
        <h2>Révision</h2>
        <button className="link" onClick={onExit}>Terminer</button>
      </header>
      {!card ? (
        <div className="flash done">
          <p>🎉 Terminé : {done} fiche(s) révisée(s).</p>
          <button className="primary" onClick={onExit}>Retour</button>
        </div>
      ) : (
        <>
          <small className="muted">{queue.length} restante(s)</small>
          <div className="flash" onClick={() => setShown(true)}>
            <div className="flash-front">{card.front}</div>
            {shown ? (
              <div className="flash-back">
                {card.back}
                {card.page !== undefined && (
                  <button className="cite" onClick={(e) => { e.stopPropagation(); goTo(card.page!); }}>[p. {card.page + 1}]</button>
                )}
              </div>
            ) : (
              <button className="primary">Afficher la réponse (Espace)</button>
            )}
          </div>
          {shown && (
            <div className="grades">
              {(['À revoir', 'Difficile', 'Bien', 'Facile'] as const).map((l, g) => (
                <button key={l} className={`grade g${g}`} onClick={() => grade(g as Grade)}>
                  {l}
                  <small>{nextIntervalLabel(card, g as Grade)}</small>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Quiz({ questions, onExit, goTo }: { questions: QuizQuestion[]; onExit: () => void; goTo: (p: number) => void }) {
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const q = questions[i];
  if (!questions.length)
    return (
      <div className="panel"><p className="empty">Pas de questions.</p><button onClick={onExit}>Retour</button></div>
    );
  return (
    <div className="panel study-panel">
      <header className="panel-head">
        <h2>Quiz</h2>
        <button className="link" onClick={onExit}>Quitter</button>
      </header>
      {!q ? (
        <div className="flash done">
          <p>Score : <b>{score} / {questions.length}</b> {score === questions.length ? '🏆' : score >= questions.length / 2 ? '👍' : '📚'}</p>
          <button className="primary" onClick={onExit}>Retour</button>
        </div>
      ) : (
        <>
          <small className="muted">Question {i + 1} / {questions.length} · score {score}</small>
          <div className="quiz-q">{q.question}</div>
          <div className="quiz-choices">
            {q.choices.map((c, k) => (
              <button
                key={k}
                disabled={picked !== null}
                className={picked === null ? '' : k === q.answer ? 'right' : k === picked ? 'wrong' : ''}
                onClick={() => {
                  setPicked(k);
                  if (k === q.answer) setScore((s) => s + 1);
                }}
              >
                {String.fromCharCode(65 + k)}) {c}
              </button>
            ))}
          </div>
          {picked !== null && (
            <>
              {q.explanation && <p className="muted">{q.explanation}</p>}
              {q.page !== undefined && <button className="cite" onClick={() => goTo(q.page!)}>Voir la page {q.page + 1}</button>}
              <button className="primary" onClick={() => { setI(i + 1); setPicked(null); }}>Suivante</button>
            </>
          )}
        </>
      )}
    </div>
  );
}
