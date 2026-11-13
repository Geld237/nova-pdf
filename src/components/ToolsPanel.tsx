import { useEffect, useState } from 'react';
import { canvasToBlob, extractAllText, openPdf, renderPageToCanvas, type PDFDocumentProxy } from '../pdf/engine';
import {
  addPageNumbers, addWatermark, baseName, diffLines, download, extractPages, imagesToPdf, mergePdfs,
  optimize, parseRanges, readMeta, splitPdf, stripMeta, writeMeta, type Meta,
} from '../pdf/tools';
import { makeSearchable, ocrPages } from '../pdf/ocr';
import type { PageText } from '../types';

export interface DocCtx {
  name: string;
  pdf: PDFDocumentProxy;
  numPages: number;
  currentPage: number;
  texts: PageText[] | null;
  /** Octets du document avec les annotations appliquées. */
  getBytes: () => Promise<Uint8Array>;
  /** Remplace le document courant (les annotations sont alors intégrées). */
  replace: (bytes: Uint8Array, label: string) => Promise<void>;
  openNew: (bytes: Uint8Array, name: string) => void;
  notify: (msg: string) => void;
}

const pickFiles = (accept: string, multiple = true) =>
  new Promise<File[]>((res) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    i.onchange = () => res(Array.from(i.files ?? []));
    i.click();
  });

export function ToolsPanel({ ctx }: { ctx: DocCtx }) {
  const [busy, setBusy] = useState<string | null>(null);
  const wrap = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      ctx.notify(`Erreur : ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const [splitSpec, setSplitSpec] = useState('1-2, 3-');
  const [extractSpec, setExtractSpec] = useState('1');
  const [wm, setWm] = useState({ text: 'CONFIDENTIEL', color: '#d32f2f', opacity: 0.18, size: 64 });
  const [num, setNum] = useState({ format: '{n} / {total}', position: 'bottom-center' as const, size: 10, start: 1 });
  const [meta, setMeta] = useState<Meta | null>(null);
  const [ocrLang, setOcrLang] = useState('fra+eng');
  const [ocrScope, setOcrScope] = useState<'current' | 'all'>('current');
  const [ocrProgress, setOcrProgress] = useState<{ msg: string; r: number } | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [diff, setDiff] = useState<ReturnType<typeof diffLines> | null>(null);

  useEffect(() => {
    ctx.getBytes().then(readMeta).then(setMeta).catch(() => setMeta(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.pdf]);

  const base = baseName(ctx.name);

  return (
    <div className="panel tools-panel">
      <header className="panel-head">
        <h2>Outils</h2>
      </header>
      {busy && <p className="busy">⏳ {busy}…</p>}

      <details open>
        <summary>Fusionner</summary>
        <p className="muted">Ajoute d'autres PDF à la fin de ce document.</p>
        <button
          onClick={wrap('Fusion', async () => {
            const files = await pickFiles('application/pdf');
            if (!files.length) return;
            const all = [await ctx.getBytes(), ...(await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer()))))];
            await ctx.replace(await mergePdfs(all), `${files.length} fichier(s) ajouté(s)`);
          })}
        >
          Ajouter des PDF…
        </button>
      </details>

      <details>
        <summary>Découper</summary>
        <label>
          Plages (une par fichier)
          <input value={splitSpec} onChange={(e) => setSplitSpec(e.target.value)} placeholder="1-3, 4-6, 7-" />
        </label>
        <div className="row">
          <button
            onClick={wrap('Découpage', async () => {
              const groups = parseRanges(splitSpec.replace(/-(\s*)(,|$)/g, `-${ctx.numPages}$1$2`), ctx.numPages);
              const parts = await splitPdf(await ctx.getBytes(), groups);
              parts.forEach((b, i) => download(b, `${base}-partie${i + 1}.pdf`));
            })}
          >
            Découper
          </button>
          <button
            onClick={wrap('Découpage', async () => {
              const groups = Array.from({ length: ctx.numPages }, (_, i) => [i]);
              const parts = await splitPdf(await ctx.getBytes(), groups);
              parts.forEach((b, i) => download(b, `${base}-p${i + 1}.pdf`));
            })}
          >
            Une page par fichier
          </button>
        </div>
      </details>

      <details>
        <summary>Extraire des pages</summary>
        <label>
          Pages
          <input value={extractSpec} onChange={(e) => setExtractSpec(e.target.value)} placeholder="1, 3-5" />
        </label>
        <button
          onClick={wrap('Extraction', async () => {
            const idx = parseRanges(extractSpec, ctx.numPages).flat();
            download(await extractPages(await ctx.getBytes(), idx), `${base}-extrait.pdf`);
          })}
        >
          Extraire en PDF
        </button>
      </details>

      <details>
        <summary>Filigrane</summary>
        <label>
          Texte <input value={wm.text} onChange={(e) => setWm({ ...wm, text: e.target.value })} />
        </label>
        <div className="row">
          <label>
            Couleur <input type="color" value={wm.color} onChange={(e) => setWm({ ...wm, color: e.target.value })} />
          </label>
          <label>
            Opacité <input type="range" min={0.05} max={0.8} step={0.05} value={wm.opacity} onChange={(e) => setWm({ ...wm, opacity: +e.target.value })} />
          </label>
          <label>
            Taille <input type="number" min={12} max={200} value={wm.size} onChange={(e) => setWm({ ...wm, size: +e.target.value })} />
          </label>
        </div>
        <button onClick={wrap('Filigrane', async () => ctx.replace(await addWatermark(await ctx.getBytes(), wm.text, wm), 'Filigrane ajouté'))}>
          Appliquer à toutes les pages
        </button>
      </details>

      <details>
        <summary>Numéroter les pages</summary>
        <label>
          Format <input value={num.format} onChange={(e) => setNum({ ...num, format: e.target.value })} />
        </label>
        <div className="row">
          <label>
            Position
            <select value={num.position} onChange={(e) => setNum({ ...num, position: e.target.value as typeof num.position })}>
              <option value="bottom-center">Bas, centré</option>
              <option value="bottom-right">Bas, droite</option>
              <option value="top-right">Haut, droite</option>
            </select>
          </label>
          <label>
            Début <input type="number" value={num.start} onChange={(e) => setNum({ ...num, start: +e.target.value })} />
          </label>
        </div>
        <button onClick={wrap('Numérotation', async () => ctx.replace(await addPageNumbers(await ctx.getBytes(), num), 'Pages numérotées'))}>
          Numéroter
        </button>
      </details>

      <details>
        <summary>OCR — rendre un scan cherchable</summary>
        <p className="muted">Reconnaissance de texte locale (Tesseract). Les données de langue sont téléchargées une fois.</p>
        <div className="row">
          <label>
            Langue
            <select value={ocrLang} onChange={(e) => setOcrLang(e.target.value)}>
              <option value="fra+eng">Français + anglais</option>
              <option value="fra">Français</option>
              <option value="eng">Anglais</option>
              <option value="spa">Espagnol</option>
              <option value="deu">Allemand</option>
              <option value="ita">Italien</option>
              <option value="por">Portugais</option>
              <option value="ara">Arabe</option>
            </select>
          </label>
          <label>
            Pages
            <select value={ocrScope} onChange={(e) => setOcrScope(e.target.value as 'current' | 'all')}>
              <option value="current">Page courante</option>
              <option value="all">Tout le document</option>
            </select>
          </label>
        </div>
        <button
          onClick={wrap('OCR', async () => {
            const pages = ocrScope === 'all' ? Array.from({ length: ctx.numPages }, (_, i) => i) : [ctx.currentPage];
            const res = await ocrPages(ctx.pdf, pages, ocrLang, (msg, r) => setOcrProgress({ msg, r }));
            setOcrText(res.map((r) => `--- Page ${r.page + 1} ---\n${r.text}`).join('\n\n'));
            const bytes = await makeSearchable(await ctx.getBytes(), ctx.pdf, res);
            await ctx.replace(bytes, 'Couche de texte OCR ajoutée');
            setOcrProgress(null);
          })}
        >
          Lancer l'OCR
        </button>
        {ocrProgress && (
          <div className="progress">
            <div className="bar" style={{ width: `${Math.round(ocrProgress.r * 100)}%` }} />
            <small>{ocrProgress.msg}</small>
          </div>
        )}
        {ocrText && <textarea className="ocr-out" readOnly value={ocrText} rows={8} />}
      </details>

      <details>
        <summary>Exporter</summary>
        <div className="col">
          <button
            onClick={wrap('Export image', async () => {
              const c = await renderPageToCanvas(ctx.pdf, ctx.currentPage, 2);
              download(await canvasToBlob(c), `${base}-p${ctx.currentPage + 1}.png`);
            })}
          >
            Page courante en PNG
          </button>
          <button
            onClick={wrap('Export images', async () => {
              for (let i = 0; i < ctx.numPages; i++) {
                const c = await renderPageToCanvas(ctx.pdf, i, 2);
                download(await canvasToBlob(c, 'image/jpeg', 0.9), `${base}-p${i + 1}.jpg`);
              }
            })}
          >
            Toutes les pages en JPG
          </button>
          <button
            onClick={wrap('Export texte', async () => {
              const t = ctx.texts ?? (await extractAllText(ctx.pdf));
              download(t.map((p) => p.text).join('\n\n\f'), `${base}.txt`, 'text/plain;charset=utf-8');
            })}
          >
            Texte brut (.txt)
          </button>
          <button
            onClick={wrap('Export Markdown', async () => {
              const t = ctx.texts ?? (await extractAllText(ctx.pdf));
              const md = `# ${base}\n\n` + t.map((p) => `## Page ${p.page + 1}\n\n${p.text}`).join('\n\n');
              download(md, `${base}.md`, 'text/markdown;charset=utf-8');
            })}
          >
            Markdown (.md)
          </button>
        </div>
      </details>

      <details>
        <summary>Créer un PDF à partir d'images</summary>
        <button
          onClick={wrap('Conversion', async () => {
            const files = await pickFiles('image/png,image/jpeg');
            if (files.length) ctx.openNew(await imagesToPdf(files), 'images.pdf');
          })}
        >
          Choisir des images…
        </button>
      </details>

      <details>
        <summary>Propriétés et confidentialité</summary>
        {meta && (
          <>
            {(['title', 'author', 'subject', 'keywords'] as const).map((k) => (
              <label key={k}>
                {{ title: 'Titre', author: 'Auteur', subject: 'Sujet', keywords: 'Mots-clés' }[k]}
                <input value={meta[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} />
              </label>
            ))}
            <div className="row">
              <button onClick={wrap('Métadonnées', async () => ctx.replace(await writeMeta(await ctx.getBytes(), meta), 'Propriétés enregistrées'))}>
                Enregistrer
              </button>
              <button
                onClick={wrap('Nettoyage', async () => {
                  await ctx.replace(await stripMeta(await ctx.getBytes()), 'Métadonnées supprimées');
                  setMeta({ title: '', author: '', subject: '', keywords: '' });
                })}
              >
                Tout effacer
              </button>
            </div>
          </>
        )}
        <button onClick={wrap('Optimisation', async () => {
          const before = (await ctx.getBytes()).length;
          const out = await optimize(await ctx.getBytes());
          await ctx.replace(out, `Optimisé : ${(before / 1024).toFixed(0)} → ${(out.length / 1024).toFixed(0)} Ko`);
        })}>
          Optimiser la taille
        </button>
      </details>

      <details>
        <summary>Comparer avec une autre version</summary>
        <button
          onClick={wrap('Comparaison', async () => {
            const [f] = await pickFiles('application/pdf', false);
            if (!f) return;
            const other = await openPdf(new Uint8Array(await f.arrayBuffer()), () => prompt('Mot de passe ?'));
            const a = (ctx.texts ?? (await extractAllText(ctx.pdf))).map((t) => t.text).join('\n');
            const b = (await extractAllText(other)).map((t) => t.text).join('\n');
            setDiff(diffLines(a, b));
          })}
        >
          Choisir l'autre PDF…
        </button>
        {diff && (
          <>
            <p className="muted">
              {diff.filter((d) => d.type === 'del').length} ligne(s) supprimée(s), {diff.filter((d) => d.type === 'add').length} ajoutée(s)
            </p>
            <div className="diff">
              {diff
                .filter((d, i, arr) => d.type !== 'same' || arr[i - 1]?.type !== 'same' || arr[i + 1]?.type !== 'same')
                .map((d, i) => (
                  <div key={i} className={`d-${d.type}`}>
                    {d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  '}
                    {d.text}
                  </div>
                ))}
            </div>
          </>
        )}
      </details>
    </div>
  );
}
