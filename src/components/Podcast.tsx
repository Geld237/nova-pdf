import { useEffect, useRef, useState } from 'react';
import { chat, type AiSettings } from '../ai/llm';
import type { PageText } from '../types';

interface Line {
  who: 0 | 1;
  text: string;
}

/** Transforme le document en dialogue à deux voix, lu par la synthèse vocale du système. */
export function Podcast({ texts, ai, docName, onToNotes }: { texts: PageText[] | null; ai: AiSettings; docName: string; onToNotes: (t: string) => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cur, setCur] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [v, setV] = useState<[string, string]>(['', '']);
  const [rate, setRate] = useState(1.05);
  const [length, setLength] = useState<'court' | 'moyen' | 'long'>('moyen');
  const tts = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const stopped = useRef(false);

  useEffect(() => {
    if (!tts) return;
    const load = () => {
      const all = speechSynthesis.getVoices();
      setVoices(all);
      const fr = all.filter((x) => x.lang.startsWith('fr'));
      const pool = fr.length >= 2 ? fr : all;
      setV((prev) => (prev[0] ? prev : [pool[0]?.name ?? '', (pool[1] ?? pool[0])?.name ?? '']));
    };
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', load);
      speechSynthesis.cancel();
    };
  }, [tts]);

  const generate = async () => {
    if (!texts) return;
    setBusy('Écriture du script…');
    setError(null);
    const step = Math.max(1, Math.ceil(texts.length / 10));
    const src = texts.filter((_, i) => i % step === 0).map((t) => t.text.slice(0, 600)).join('\n').slice(0, 5500);
    const n = { court: '10 à 14', moyen: '18 à 24', long: '30 à 40' }[length];
    try {
      const out = await chat(
        ai,
        [
          { role: 'system', content: "Tu écris des podcasts de vulgarisation vivants et fidèles aux sources, en français." },
          {
            role: 'user',
            content: `Document « ${docName} » (extraits) :\n${src}\n\nÉcris un dialogue de podcast de ${n} répliques entre Léa (animatrice curieuse) et Max (expert). Introduis le sujet, explique les idées clés avec des exemples, termine par un résumé en 3 points. Format strict, une réplique par ligne :\nLéa : …\nMax : …`,
          },
        ],
        () => {},
        (t) => setBusy(`Chargement du modèle… ${t.slice(0, 40)}`),
      );
      const ls: Line[] = out
        .split('\n')
        .map((l) => l.trim().replace(/^\*\*|\*\*/g, ''))
        .map((l) => {
          const m = l.match(/^(Léa|Lea|Max)\s*[:：]\s*(.+)$/i);
          return m ? { who: (/^l/i.test(m[1]) ? 0 : 1) as 0 | 1, text: m[2].replace(/\*\*/g, '') } : null;
        })
        .filter(Boolean) as Line[];
      if (!ls.length) setError('Le modèle n’a pas produit de dialogue lisible. Réessayez.');
      setLines(ls);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const play = (from = 0) => {
    speechSynthesis.cancel();
    stopped.current = false;
    setPlaying(true);
    lines.slice(from).forEach((l, k) => {
      const u = new SpeechSynthesisUtterance(l.text);
      const voice = voices.find((x) => x.name === v[l.who]);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = rate;
      u.pitch = l.who === 0 ? 1.1 : 0.9; // différencie les voix si une seule est disponible
      u.onstart = () => setCur(from + k);
      if (from + k === lines.length - 1)
        u.onend = () => {
          setPlaying(false);
          setCur(-1);
        };
      speechSynthesis.speak(u);
    });
  };

  return (
    <details open={lines.length > 0}>
      <summary>🎧 Écouter en podcast</summary>
      {!tts && <p className="muted">Synthèse vocale indisponible dans ce navigateur.</p>}
      <div className="row">
        <select value={length} onChange={(e) => setLength(e.target.value as typeof length)}>
          <option value="court">Court (~3 min)</option>
          <option value="moyen">Moyen (~6 min)</option>
          <option value="long">Long (~10 min)</option>
        </select>
        <button className="primary" disabled={!!busy || !texts} onClick={generate}>{busy ?? (lines.length ? 'Régénérer' : 'Créer le podcast')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {lines.length > 0 && (
        <>
          <div className="row">
            {playing ? (
              <>
                <button onClick={() => (speechSynthesis.paused ? speechSynthesis.resume() : speechSynthesis.pause())}>⏯</button>
                <button onClick={() => { speechSynthesis.cancel(); setPlaying(false); setCur(-1); }}>⏹</button>
                <button onClick={() => play(Math.min(lines.length - 1, cur + 1))}>⏭</button>
              </>
            ) : (
              <button className="primary" onClick={() => play(Math.max(0, cur))}>▶ Écouter</button>
            )}
            <label className="inline">Vitesse <input type="range" min={0.7} max={1.6} step={0.05} value={rate} onChange={(e) => setRate(+e.target.value)} /></label>
          </div>
          <div className="row">
            {(['Léa', 'Max'] as const).map((who, k) => (
              <label key={who} className="inline">
                {who}
                <select value={v[k]} onChange={(e) => setV(k === 0 ? [e.target.value, v[1]] : [v[0], e.target.value])}>
                  {voices.map((x) => <option key={x.name} value={x.name}>{x.name} ({x.lang})</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="podcast-script">
            {lines.map((l, i) => (
              <p key={i} className={`${i === cur ? 'speaking' : ''} who${l.who}`} onClick={() => play(i)}>
                <b>{l.who === 0 ? 'Léa' : 'Max'} :</b> {l.text}
              </p>
            ))}
          </div>
          <button className="link" onClick={() => onToNotes(lines.map((l) => `**${l.who === 0 ? 'Léa' : 'Max'}** : ${l.text}`).join('\n'))}>
            → Enregistrer le script dans mes notes
          </button>
        </>
      )}
    </details>
  );
}
