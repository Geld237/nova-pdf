import { clickInput } from '../platform';
import { useEffect, useState } from 'react';
import { ui } from '../dialogs';
import { Section, ToolNav } from './ToolSection';
import { Icon, type IconName } from '../icons';
import { extractAllText, openPdf, type PDFDocumentProxy } from '../pdf/engine';
import {
  addPageNumbers, addWatermark, baseName, diffLines, download, extractPages, mergePdfs,
  parseRanges, readMeta, splitPdf, stripMeta, writeMeta, type Meta,
} from '../pdf/tools';
import { makeSearchable, ocrPages } from '../pdf/ocr';
import type { Annotation, OutlineItem, PageText } from '../types';
import type { AiSettings } from '../ai/llm';
import { PiiTool } from './PiiTool';
import { RefsTool } from './RefsTool';
import { MoreTools } from './MoreTools';
import { Thumb } from './Thumb';

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
  outline: OutlineItem[];
  ocrLang: string;
  ai: AiSettings;
  addAnnotations: (a: Annotation[]) => void;
  /** Octets du document sans les annotations en cours. */
  getBytesRaw: () => Promise<Uint8Array>;
  markReview: () => void;
  /** Ouvre le scanner ; avec `onPdf`, le PDF scanné est rendu à l'appelant (ex. insertion dans Organiser). */
  startScan: (onPdf?: (bytes: Uint8Array) => void) => void;
  openPanel: (p: 'organize') => void;
  openWorkspace: (k: 'organize' | 'split' | 'extract' | 'crop' | 'merge' | 'nup') => void;
  /** aller à une page du document ouvert */
  goTo?: (page: number) => void;
  selectTool: (t: 'edittext' | 'image' | 'move' | 'whiteout' | 'snapshot') => void;
  docId: string;
  annotations: Annotation[];
  replaceKeep: (bytes: Uint8Array, label: string, annotations: Annotation[]) => Promise<void>;
  /** Nouvelle disposition des pages ; les annotations suivent leurs pages et restent modifiables. */
  applyLayout: (items: { doc: number; src: number; rotate: number }[], label: string, sources?: Uint8Array[]) => Promise<void>;
}

/** Catalogue des outils : icône, couleur de tuile (dégradé façon iOS) et groupe. */
const CATALOG: { group: string; items: { id: string; label: string; icon: IconName; color: [string, string]; keywords?: string }[] }[] = [
  {
    group: 'Modifier',
    items: [
      { id: '!edittext', label: 'Modifier le texte', icon: 'edittext', color: ['#409cff', '#3d52d5'], keywords: 'éditer corriger changer texte' },
      { id: '!image', label: 'Insérer une image', icon: 'image', color: ['#5fe07a', '#20a14a'], keywords: 'photo logo' },
      { id: '!move', label: 'Déplacer / redimensionner', icon: 'move', color: ['#ffb340', '#f08c00'], keywords: 'bouger taille' },
      { id: '!whiteout', label: 'Effacer une zone', icon: 'whiteout', color: ['#c7c7cc', '#8e8e93'], keywords: 'blanc correcteur' },
      { id: 'watermark', label: 'Filigrane', icon: 'watermark', color: ['#70d7ff', '#30b0c7'] },
      { id: 'pagenum', label: 'Numéroter', icon: 'pagenum', color: ['#98989d', '#6e6e73'], keywords: 'numéros de page' },
      { id: 'bookmarks', label: 'Signets', icon: 'bookmarks', color: ['#ff7b72', '#ff453a'], keywords: 'sommaire' },
      { id: 'attach', label: 'Pièces jointes', icon: 'attach', color: ['#aeaeb2', '#8e8e93'], keywords: 'joindre fichier' },
      { id: 'viewer', label: "Préférences d'affichage", icon: 'viewer', color: ['#409cff', '#0a84ff'] },
      { id: 'flatten', label: 'Aplatir', icon: 'flatten', color: ['#c69c6d', '#a2845e'], keywords: 'figer' },
    ],
  },
  {
    group: 'Organiser',
    items: [
      { id: '#merge', label: 'Fusionner', icon: 'merge', color: ['#5ac8fa', '#007aff'], keywords: 'combiner joindre' },
      { id: '#split', label: 'Découper', icon: 'split', color: ['#ffb340', '#ff9500'], keywords: 'diviser séparer' },
      { id: '#extract', label: 'Extraire des pages', icon: 'extract', color: ['#4cd9c0', '#00c7be'] },
      { id: '#organize', label: 'Insérer des pages', icon: 'create', color: ['#30d158', '#248a3d'], keywords: 'ajouter insérer page blanche image scan pdf' },
      { id: '#organize', label: 'Organiser les pages', icon: 'organize', color: ['#7d7aff', '#5856d6'], keywords: 'trier pivoter supprimer réordonner insérer ajouter' },
      { id: '#nup', label: 'Pages par feuille', icon: 'grid', color: ['#a28bff', '#7a5af8'], keywords: 'imposition' },
      { id: 'resize', label: 'Format des pages', icon: 'resize', color: ['#da8fff', '#af52de'], keywords: 'a4 letter taille' },
      { id: '#crop', label: 'Recadrer', icon: 'crop', color: ['#ff6b9a', '#ff2d55'], keywords: 'rogner marges' },
    ],
  },
  {
    group: 'Créer et convertir',
    items: [
      { id: 'create', label: 'Créer un PDF', icon: 'create', color: ['#5fe07a', '#34c759'], keywords: 'images vierge texte' },
      { id: '@scan', label: 'Scanner', icon: 'scan', color: ['#8e8e93', '#636366'], keywords: 'caméra photo' },
      { id: 'convert', label: 'Convertir', icon: 'convert', color: ['#ff6961', '#ff3b30'], keywords: 'word docx html images' },
      { id: 'export', label: 'Exporter', icon: 'export', color: ['#64d2ff', '#32ade6'], keywords: 'png jpg texte markdown' },
      { id: '!snapshot', label: 'Capture', icon: 'snapshot', color: ['#5ac8fa', '#007aff'], keywords: 'capture zone image png copier screenshot' },
      { id: 'ocr', label: 'OCR', icon: 'ocr', color: ['#ffd60a', '#ffcc00'], keywords: 'reconnaissance texte scan cherchable' },
    ],
  },
  {
    group: 'Protéger',
    items: [
      { id: 'protect', label: 'Protéger', icon: 'protect', color: ['#409cff', '#0060df'], keywords: 'mot de passe chiffrer' },
      { id: 'unlock', label: 'Déverrouiller', icon: 'unlock', color: ['#5fe07a', '#28a745'], keywords: 'mot de passe' },
      { id: 'pii', label: 'Anonymiser', icon: 'pii', color: ['#48484a', '#1c1c1e'], keywords: 'données personnelles caviarder rgpd' },
      { id: 'meta', label: 'Propriétés', icon: 'meta', color: ['#aeaeb2', '#636366'], keywords: 'métadonnées auteur titre' },
    ],
  },
  {
    group: 'Optimiser et analyser',
    items: [
      { id: 'compress', label: 'Compresser', icon: 'compress', color: ['#66d47e', '#30b94d'], keywords: 'réduire taille' },
      { id: 'repair', label: 'Réparer', icon: 'repair', color: ['#ffb340', '#ff8a00'], keywords: 'corrompu' },
      { id: 'compare', label: 'Comparer', icon: 'compare', color: ['#bf8bff', '#8e44ec'], keywords: 'différences versions' },
      { id: 'refs', label: 'Références', icon: 'refs', color: ['#7d7aff', '#4b48d6'], keywords: 'bibliographie bibtex zotero doi' },
    ],
  },
];
const ALL_TOOLS = CATALOG.flatMap((g) => g.items);

function ToolTile({ t, onClick }: { t: (typeof ALL_TOOLS)[number]; onClick: () => void }) {
  return (
    <button className="tool-tile" onClick={onClick} title={t.label}>
      <span className="tile-ico" style={{ background: `linear-gradient(160deg, ${t.color[0]}, ${t.color[1]})` }}>
        <Icon name={t.icon} size={24} />
      </span>
      <span className="tile-label">{t.label}</span>
    </button>
  );
}

const pickFiles = (accept: string, multiple = true) =>
  new Promise<File[]>((res) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    i.onchange = () => res(Array.from(i.files ?? []));
    clickInput(i);
  });

export function ToolsPanel({ ctx }: { ctx: DocCtx }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const open = (id: string) => {
    if (id.startsWith('#')) ctx.openWorkspace(id.slice(1) as 'organize');
    else if (id.startsWith('!')) ctx.selectTool(id.slice(1) as 'edittext');
    else if (id === '@scan') ctx.startScan();
    else setActive(id);
  };
  const current = ALL_TOOLS.find((t) => t.id === active);
  const f = filter.trim().toLowerCase();
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
  const [ocrLang, setOcrLang] = useState(ctx.ocrLang);
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
    <ToolNav.Provider value={{ active }}>
    <div className="panel tools-panel">
      {current ? (
        <header className="panel-head tool-head">
          <button className="icon back" onClick={() => setActive(null)} title="Tous les outils"><Icon name="back" /></button>
          <span className="tile-ico small" style={{ background: `linear-gradient(160deg, ${current.color[0]}, ${current.color[1]})` }}>
            <Icon name={current.icon} size={16} />
          </span>
          <h2>{current.label}</h2>
        </header>
      ) : (
        <>
          <header className="panel-head">
            <h2>Outils</h2>
          </header>
          <input type="search" className="tool-search" placeholder="Rechercher un outil…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {CATALOG.map((g) => {
            const items = g.items.filter((t) => !f || `${t.label} ${t.keywords ?? ''} ${g.group}`.toLowerCase().includes(f));
            if (!items.length) return null;
            return (
              <div key={g.group} className="tool-group">
                <h3 className="group">{g.group}</h3>
                <div className="tool-grid">
                  {items.map((t) => <ToolTile key={t.id + t.label} t={t} onClick={() => open(t.id)} />)}
                </div>
              </div>
            );
          })}
        </>
      )}
      {busy && <p className="busy">⏳ {busy}…</p>}

      <Section id="merge" title="Fusionner">
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
      </Section>

      <Section id="split" title="Découper">
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
      </Section>

      <Section id="extract" title="Extraire des pages">
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
      </Section>

      <Section id="watermark" title="Filigrane">
        <div className="live-preview">
          <Thumb doc={ctx.pdf} page={ctx.currentPage} width={220} />
          <span className="wm-preview" style={{ color: wm.color, opacity: wm.opacity, fontSize: wm.size * (220 / 595) }}>{wm.text}</span>
        </div>
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
      </Section>

      <Section id="pagenum" title="Numéroter les pages">
        <div className="live-preview">
          <Thumb doc={ctx.pdf} page={ctx.currentPage} width={220} />
          <span className={`pn-preview ${num.position}`}>
            {num.format.replace('{n}', String(ctx.currentPage + num.start)).replace('{total}', String(ctx.numPages + num.start - 1))}
          </span>
        </div>
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
      </Section>

      <Section id="ocr" title="OCR — rendre un scan cherchable">
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
      </Section>

      <Section id="export" title="Exporter">
        <div className="col">
          <button className="primary" onClick={() => window.dispatchEvent(new Event('nova:export-images'))}>
            Pages en images (PNG, JPG, WebP)…
          </button>
          <button onClick={() => ctx.selectTool('snapshot')} title="Dessinez un cadre sur la page pour en faire une image">
            Capturer une zone…
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
      </Section>

      <Section id="meta" title="Propriétés et confidentialité">
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
      </Section>

      <Section id="compare" title="Comparer avec une autre version">
        <p className="muted">La comparaison visuelle affiche les deux versions côte à côte : en rouge ce qui a disparu, en vert ce qui est nouveau.</p>
        <button
          className="primary"
          onClick={wrap('Comparaison', async () => {
            const [f] = await pickFiles('application/pdf', false);
            if (!f) return;
            const other = await openPdf(new Uint8Array(await f.arrayBuffer()), () => ui.prompt('Mot de passe du document à comparer :', '', { password: true }));
            window.dispatchEvent(new CustomEvent('nova:compare', { detail: { pdf: other, name: f.name } }));
          })}
        >
          Comparaison visuelle (nouvelle version)…
        </button>
        <button
          onClick={wrap('Comparaison', async () => {
            const [f] = await pickFiles('application/pdf', false);
            if (!f) return;
            const other = await openPdf(new Uint8Array(await f.arrayBuffer()), () => ui.prompt('Mot de passe du document à comparer :', '', { password: true }));
            const a = (ctx.texts ?? (await extractAllText(ctx.pdf))).map((t) => t.text).join('\n');
            const b = (await extractAllText(other)).map((t) => t.text).join('\n');
            setDiff(diffLines(a, b));
          })}
        >
          Liste des lignes modifiées…
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
      </Section>
      <PiiTool ctx={ctx} ai={ctx.ai} />
      <RefsTool ctx={ctx} />

      <MoreTools ctx={ctx} outline={ctx.outline} run={wrap} />
    </div>
    </ToolNav.Provider>
  );
}
