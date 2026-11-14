import { useEffect, useRef, useState } from 'react';
import { get, set } from 'idb-keyval';
import { AbortedError, chat, type AiSettings } from '../ai/llm';
import type { PDFDocumentProxy } from '../pdf/engine';
import { textToPdf, toDocx } from '../pdf/advanced';
import { baseName, download } from '../pdf/tools';
import type { PageText } from '../types';
import { Thumb } from './Thumb';

const LANGS = ['anglais', 'français', 'espagnol', 'allemand', 'italien', 'portugais', 'néerlandais', 'arabe', 'chinois', 'japonais', 'russe'];

/** Traduction de tout le document, page originale et traduction côte à côte. */
export function TranslateView({
  pdf, texts, ai, fingerprint, name, startPage, onClose,
}: {
  pdf: PDFDocumentProxy;
  texts: PageText[];
  ai: AiSettings;
  fingerprint: string;
  name: string;
  startPage: number;
  onClose: () => void;
}) {
  const [lang, setLang] = useState('anglais');
  const [tr, setTr] = useState<Record<number, string>>({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const ctrl = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const key = `tr:${fingerprint}:${lang}`;

  useEffect(() => {
    get(key).then((v) => setTr((v as Record<number, string>) ?? {})).catch(() => setTr({}));
  }, [key]);

  useEffect(() => {
    const el = scroller.current?.querySelector(`[data-tp="${startPage}"]`);
    el?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translatePage = async (i: number, acc: Record<number, string>) => {
    const src = texts[i]?.text ?? '';
    if (!src.trim()) return { ...acc, [i]: '' };
    let out = '';
    setTr((t) => ({ ...t, [i]: '…' }));
    await chat(
      ai,
      [
        { role: 'system', content: `Tu es un traducteur professionnel. Traduis fidèlement en ${lang}. Conserve les paragraphes, listes, chiffres et noms propres. Réponds uniquement par la traduction.` },
        { role: 'user', content: src.slice(0, 6000) },
      ],
      (t) => {
        out += t;
        setTr((x) => ({ ...x, [i]: out }));
      },
      (txt) => setStatus(txt),
      ctrl.current?.signal,
      'Traduction',
    );
    const next = { ...acc, [i]: out.trim() };
    await set(key, next).catch(() => {});
    return next;
  };

  const runAll = async (from: number) => {
    setRunning(true);
    setError(null);
    stop.current = false;
    ctrl.current = new AbortController();
    let acc = { ...tr };
    try {
      for (let i = from; i < texts.length; i++) {
        if (stop.current) break;
        if (acc[i] && acc[i] !== '…') continue;
        setStatus(`Page ${i + 1} / ${texts.length}`);
        scroller.current?.querySelector(`[data-tp="${i}"]`)?.scrollIntoView({ block: 'nearest' });
        acc = await translatePage(i, acc);
      }
    } catch (e) {
      if (e instanceof AbortedError) setTr((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== '…')));
      else setError((e as Error).message);
    } finally {
      setRunning(false);
      setStatus('');
    }
  };

  const done = texts.filter((t) => tr[t.page] && tr[t.page] !== '…').length;
  const asTexts = (): PageText[] => texts.map((t) => ({ page: t.page, text: tr[t.page] ?? '' }));

  return (
    <div className="overlay translate-view">
      <header className="overlay-bar">
        <b>Traduction côte à côte</b>
        <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={running}>
          {LANGS.map((l) => <option key={l}>{l}</option>)}
        </select>
        {running ? (
          <button className="stop-btn" onClick={() => { stop.current = true; ctrl.current?.abort(); }}>⏹ Arrêter</button>
        ) : (
          <button className="primary" onClick={() => runAll(0)}>{done ? 'Continuer la traduction' : 'Traduire tout le document'}</button>
        )}
        <small className="muted">{done}/{texts.length} pages {status && `· ${status.slice(0, 50)}`}</small>
        <span className="spacer" />
        <button disabled={!done} onClick={async () => download(await toDocx(asTexts(), `${baseName(name)} (${lang})`), `${baseName(name)}-${lang}.docx`)}>Word</button>
        <button disabled={!done} onClick={async () => download(await textToPdf(asTexts().map((t) => t.text).join('\n\n'), `${baseName(name)} (${lang})`), `${baseName(name)}-${lang}.pdf`)}>PDF</button>
        <button className="icon" onClick={onClose} title="Fermer">✕</button>
      </header>
      {error && <p className="error" style={{ padding: '0 16px' }}>{error}</p>}
      <div className="tv-body" ref={scroller}>
        {texts.map((t) => (
          <div key={t.page} className="tv-row" data-tp={t.page}>
            <div className="tv-orig">
              <Thumb doc={pdf} page={t.page} width={480} />
              <small>Page {t.page + 1}</small>
            </div>
            <div className="tv-trans">
              {tr[t.page] ? (
                tr[t.page].split(/\n{1,}/).map((para, i) => <p key={i}>{para}</p>)
              ) : (
                <button disabled={running} onClick={async () => { setRunning(true); try { await translatePage(t.page, tr); } catch (e) { setError((e as Error).message); } setRunning(false); }}>
                  Traduire cette page
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
