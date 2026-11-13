import { useEffect, useState } from 'react';
import type { PageText } from '../types';

/** Mode lecture : texte remis en forme (reflow) + lecture à voix haute. */
export function ReadingPanel({ texts, currentPage, goTo }: { texts: PageText[] | null; currentPage: number; goTo: (p: number) => void }) {
  const [size, setSize] = useState(17);
  const [serif, setSerif] = useState(true);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState('');
  const [rate, setRate] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const tts = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(() => {
    if (!tts) return;
    const load = () => {
      const v = speechSynthesis.getVoices();
      setVoices(v);
      if (!voice) setVoice(v.find((x) => x.lang.startsWith('fr'))?.name ?? v[0]?.name ?? '');
    };
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', load);
      speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speak = (fromPage: number) => {
    if (!texts) return;
    speechSynthesis.cancel();
    const v = voices.find((x) => x.name === voice);
    const queue = texts.slice(fromPage);
    queue.forEach((t, i) => {
      // découpe en phrases : plus robuste sur les longs textes
      const sentences = t.text.match(/[^.!?\n]+[.!?]?/g) ?? [];
      sentences.forEach((s, j) => {
        const u = new SpeechSynthesisUtterance(s.trim());
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        }
        u.rate = rate;
        if (j === 0) u.onstart = () => goTo(t.page);
        if (i === queue.length - 1 && j === sentences.length - 1) u.onend = () => setSpeaking(false);
        speechSynthesis.speak(u);
      });
    });
    setSpeaking(true);
  };

  const page = texts?.[currentPage];
  const paragraphs = (page?.text ?? '')
    .split(/\n(?=[A-ZÀ-Ý0-9•\-–])/)
    .map((s) => s.replace(/-\n(\w)/g, '$1').replace(/\n/g, ' ').trim())
    .filter(Boolean);

  return (
    <div className="panel reading-panel">
      <header className="panel-head">
        <h2>Mode lecture</h2>
      </header>
      {tts ? (
        <div className="tts">
          <div className="row">
            {speaking ? (
              <>
                <button onClick={() => (speechSynthesis.paused ? speechSynthesis.resume() : speechSynthesis.pause())}>⏯ Pause</button>
                <button
                  onClick={() => {
                    speechSynthesis.cancel();
                    setSpeaking(false);
                  }}
                >
                  ⏹ Stop
                </button>
              </>
            ) : (
              <button className="primary" disabled={!texts} onClick={() => speak(currentPage)}>
                ▶ Lire à voix haute depuis la page {currentPage + 1}
              </button>
            )}
          </div>
          <div className="row">
            <select value={voice} onChange={(e) => setVoice(e.target.value)}>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            <label>
              Vitesse <input type="range" min={0.6} max={2} step={0.1} value={rate} onChange={(e) => setRate(+e.target.value)} /> {rate.toFixed(1)}×
            </label>
          </div>
        </div>
      ) : (
        <p className="muted">La synthèse vocale n'est pas disponible dans ce navigateur.</p>
      )}
      <div className="row">
        <label>
          Taille <input type="range" min={13} max={28} value={size} onChange={(e) => setSize(+e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={serif} onChange={(e) => setSerif(e.target.checked)} /> Police à empattements
        </label>
      </div>
      <article className="reflow" style={{ fontSize: size, fontFamily: serif ? 'Georgia, "Times New Roman", serif' : undefined }}>
        <h3>Page {currentPage + 1}</h3>
        {!texts && <p>Extraction du texte…</p>}
        {texts && !paragraphs.length && <p className="muted">Pas de texte sur cette page (scan ? lancez l'OCR).</p>}
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </article>
    </div>
  );
}
