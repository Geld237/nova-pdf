import { clickInput } from '../platform';
import { useEffect, useState } from 'react';
import { ui } from '../dialogs';
import { Section } from './ToolSection';
import { extractAllText } from '../pdf/engine';
import {
  PAGE_SIZES, attachFile, blankPdf, compressRaster, cropPages, extractImages, nUp, repairPdf, resizePages,
  setBookmarks, setViewerPrefs, textToPdf, toDocx, toHtml, type ViewerPrefs,
} from '../pdf/advanced';
import { protectPdf, unlockPdf, type Permissions } from '../pdf/security';
import { writeFields } from '../pdf/forms';
import { baseName, download, imagesToPdf, optimize } from '../pdf/tools';
import { pdfToDocxRich, pdfToPptx, pdfToXlsx } from '../pdf/convertPlus';
import type { OutlineItem } from '../types';
import type { DocCtx } from './ToolsPanel';

const pick = (accept: string, multiple = true, capture = false) =>
  new Promise<File[]>((res) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    if (capture) i.setAttribute('capture', 'environment');
    i.onchange = () => res(Array.from(i.files ?? []));
    clickInput(i);
  });

const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} Mo` : `${Math.round(n / 1024)} Ko`);

/** Outils complémentaires : création, conversion, sécurité, compression, mise en page, structure. */
export function MoreTools({ ctx, outline, run }: { ctx: DocCtx; outline: OutlineItem[]; run: (label: string, fn: () => Promise<void>) => () => void }) {
  const base = baseName(ctx.name);

  // création
  const [blank, setBlank] = useState({ count: 1, size: 'A4' });
  const [plain, setPlain] = useState('');
  // sécurité
  const [pw, setPw] = useState({ user: '', owner: '' });
  const [perms, setPerms] = useState<Permissions>({ printing: true, modifying: false, copying: false, annotating: true, fillingForms: true, documentAssembly: false });
  // compression
  const [comp, setComp] = useState({ dpi: 110, quality: 0.6 });
  const [compProgress, setCompProgress] = useState('');
  const [convProgress, setConvProgress] = useState('');
  const prog = (i: number, n: number) => setConvProgress(`page ${i + 1}/${n}`);
  // mise en page
  const [crop, setCrop] = useState({ top: 10, right: 10, bottom: 10, left: 10, scope: 'all' as 'all' | 'current' });
  const [nup, setNup] = useState<{ n: 2 | 4 | 6 | 9; size: string }>({ n: 2, size: 'A4' });
  const [resize, setResize] = useState('A4');
  // structure
  const flat = (items: OutlineItem[]): { title: string; page: number }[] =>
    items.flatMap((i) => [...(i.page !== null ? [{ title: i.title, page: i.page }] : []), ...flat(i.items)]);
  const [marks, setMarks] = useState(() => flat(outline));
  useEffect(() => setMarks(flat(outline)), [outline]);
  const [prefs, setPrefs] = useState<ViewerPrefs>({ pageLayout: 'OneColumn', pageMode: 'UseNone', displayDocTitle: true, hideToolbar: false, fitWindow: false });
  const [attDesc, setAttDesc] = useState('');

  return (
    <>
      <Section id="create" title="Créer un PDF">
        <div className="col">
          <button onClick={run('Conversion', async () => {
            const files = await pick('image/png,image/jpeg');
            if (files.length) ctx.openNew(await imagesToPdf(files), 'images.pdf');
          })}>À partir d'images…</button>
          <button onClick={() => ctx.startScan()}>📷 Scanner (détection des bords, redressement)</button>
        </div>
        <div className="row">
          <label>Pages <input type="number" min={1} max={500} value={blank.count} onChange={(e) => setBlank({ ...blank, count: +e.target.value })} /></label>
          <label>Format
            <select value={blank.size} onChange={(e) => setBlank({ ...blank, size: e.target.value })}>
              {Object.keys(PAGE_SIZES).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <button onClick={run('Création', async () => ctx.openNew(await blankPdf(blank.count, blank.size), 'nouveau.pdf'))}>PDF vierge</button>
        </div>
        <label>À partir d'un texte
          <textarea rows={4} value={plain} onChange={(e) => setPlain(e.target.value)} placeholder="Collez ou tapez un texte…" />
        </label>
        <button disabled={!plain.trim()} onClick={run('Création', async () => ctx.openNew(await textToPdf(plain, 'Texte'), 'texte.pdf'))}>Texte → PDF</button>
        <p className="muted">Word/Excel/PowerPoint → PDF : utilisez « Imprimer → Enregistrer en PDF » de votre suite bureautique (conversion locale prévue dans la feuille de route).</p>
      </Section>

      <Section id="convert" title="Convertir le PDF en…">
        <div className="col">
          <button className="primary" onClick={run('Export Word', async () => {
            const b = await pdfToDocxRich(ctx.pdf, base, prog);
            setConvProgress('');
            download(b, `${base}.docx`, b.type);
          })}>Word (.docx) — titres, gras, tableaux</button>
          <button onClick={run('Export Excel', async () => {
            const b = await pdfToXlsx(ctx.pdf, prog);
            setConvProgress('');
            download(new Blob([b as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${base}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          })}>Excel (.xlsx) — tableaux détectés</button>
          <button onClick={run('Export PowerPoint', async () => {
            const b = await pdfToPptx(ctx.pdf, base, prog);
            setConvProgress('');
            download(b, `${base}.pptx`, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
          })}>PowerPoint (.pptx) — une diapositive par page</button>
          <button onClick={run('Export Word', async () => {
            const t = ctx.texts ?? (await extractAllText(ctx.pdf));
            download(await toDocx(t, base), `${base}-texte.docx`);
          })}>Word simple (texte seul)</button>
          <button onClick={run('Export HTML', async () => {
            const t = ctx.texts ?? (await extractAllText(ctx.pdf));
            download(toHtml(t, base), `${base}.html`, 'text/html;charset=utf-8');
          })}>Page web (.html)</button>
          <button onClick={run('Extraction des images', async () => {
            const { jpegs, others } = await extractImages(await ctx.getBytes());
            jpegs.forEach((j, i) => download(new Blob([j as BlobPart], { type: 'image/jpeg' }), `${base}-image${i + 1}.jpg`));
            ctx.notify(`${jpegs.length} image(s) JPEG extraite(s)${others ? `, ${others} autre(s) non prise(s) en charge` : ''}.`);
          })}>Extraire les images intégrées</button>
        </div>
        {convProgress && <small className="muted">{convProgress}</small>}
        <p className="muted">Conversion locale : aucune donnée ne quitte l'appareil. PNG, JPG, texte et Markdown : outil « Exporter ».</p>
      </Section>
      <Section id="protect" title="Protéger par mot de passe (AES-256)">
        <label>Mot de passe d'ouverture <input type="password" value={pw.user} onChange={(e) => setPw({ ...pw, user: e.target.value })} /></label>
        <label>Mot de passe propriétaire (droits) <input type="password" value={pw.owner} onChange={(e) => setPw({ ...pw, owner: e.target.value })} placeholder="identique si vide" /></label>
        <div className="perm-grid">
          {(
            [
              ['printing', 'Impression'], ['copying', 'Copie du texte'], ['modifying', 'Modification'],
              ['annotating', 'Commentaires'], ['fillingForms', 'Remplir les formulaires'], ['documentAssembly', 'Organiser les pages'],
            ] as [keyof Permissions, string][]
          ).map(([k, l]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={perms[k]} onChange={(e) => setPerms({ ...perms, [k]: e.target.checked })} /> {l}
            </label>
          ))}
        </div>
        <button className="primary" disabled={!pw.user && !pw.owner} onClick={run('Chiffrement', async () => {
          download(await protectPdf(await ctx.getBytes(), pw.user, pw.owner, perms), `${base}-protege.pdf`);
          ctx.notify('PDF protégé téléchargé.');
        })}>Télécharger le PDF protégé</button>
      </Section>
      <Section id="unlock" title="Déverrouiller un PDF">
        <p className="muted">Les PDF ouverts avec leur mot de passe sont déjà déverrouillés : il suffit d'enregistrer. Pour un autre fichier :</p>
        <button onClick={run('Déverrouillage', async () => {
          const [f] = await pick('application/pdf', false);
          if (!f) return;
          const p = await ui.prompt(`Mot de passe de « ${f.name} » :`, '', { password: true });
          if (p === null) return;
          ctx.openNew(await unlockPdf(new Uint8Array(await f.arrayBuffer()), p), f.name.replace(/\.pdf$/i, '-deverrouille.pdf'));
        })}>Choisir un fichier protégé…</button>
      </Section>
      <Section id="compress" title="Compresser">
        <button onClick={run('Optimisation', async () => {
          const before = (await ctx.getBytes()).length;
          const out = await optimize(await ctx.getBytes());
          await ctx.replace(out, `Optimisé sans perte : ${kb(before)} → ${kb(out.length)}`);
        })}>Sans perte (structure)</button>
        <div className="row">
          <label>Résolution
            <select value={comp.dpi} onChange={(e) => setComp({ ...comp, dpi: +e.target.value })}>
              <option value={72}>72 dpi — écran, très léger</option>
              <option value={110}>110 dpi — équilibré</option>
              <option value={150}>150 dpi — impression</option>
            </select>
          </label>
          <label>Qualité <input type="range" min={0.3} max={0.95} step={0.05} value={comp.quality} onChange={(e) => setComp({ ...comp, quality: +e.target.value })} /></label>
        </div>
        <button onClick={run('Compression forte', async () => {
          const before = (await ctx.getBytes()).length;
          const out = await compressRaster(ctx.pdf, comp.dpi, comp.quality, (i, n) => setCompProgress(`page ${i + 1}/${n}`));
          setCompProgress('');
          if (out.length >= before) ctx.notify(`Pas de gain (${kb(before)} → ${kb(out.length)}) : document conservé.`);
          else await ctx.replace(out, `Compressé : ${kb(before)} → ${kb(out.length)} (−${Math.round((1 - out.length / before) * 100)} %)`);
        })}>Compression forte (pages en images)</button>
        {compProgress && <small className="muted">{compProgress}</small>}
        <p className="muted">La compression forte rend le texte non sélectionnable ; relancez l'OCR si besoin.</p>
      </Section>
      <Section id="repair" title="Réparer">
        <p className="muted">Reconstruit la structure du fichier (tables, références). En dernier recours, les pages sont reconstruites à partir de leur rendu.</p>
        <button onClick={run('Réparation', async () => {
          const { bytes, method } = await repairPdf(await ctx.getBytes(), ctx.pdf);
          await ctx.replace(bytes, `Réparé : ${method}`);
        })}>Réparer ce document</button>
      </Section>
      <Section id="crop" title="Recadrer">
        <div className="row">
          {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
            <label key={k}>{{ top: 'Haut', right: 'Droite', bottom: 'Bas', left: 'Gauche' }[k]} (mm)
              <input type="number" min={0} value={crop[k]} onChange={(e) => setCrop({ ...crop, [k]: +e.target.value })} style={{ width: 64 }} />
            </label>
          ))}
        </div>
        <label>Pages
          <select value={crop.scope} onChange={(e) => setCrop({ ...crop, scope: e.target.value as 'all' | 'current' })}>
            <option value="all">Toutes</option>
            <option value="current">Page courante</option>
          </select>
        </label>
        <button onClick={run('Recadrage', async () => ctx.replace(await cropPages(await ctx.getBytes(), crop, crop.scope === 'all' ? 'all' : [ctx.currentPage]), 'Pages recadrées'))}>Recadrer</button>
      </Section>
      <Section id="nup" title="Plusieurs pages par feuille">
        <div className="row">
          <label>Pages par feuille
            <select value={nup.n} onChange={(e) => setNup({ ...nup, n: +e.target.value as 2 | 4 | 6 | 9 })}>
              {[2, 4, 6, 9].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>Feuille
            <select value={nup.size} onChange={(e) => setNup({ ...nup, size: e.target.value })}>
              {Object.keys(PAGE_SIZES).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <button onClick={run('Imposition', async () => ctx.openNew(await nUp(await ctx.getBytes(), nup.n, nup.size), `${base}-${nup.n}par-feuille.pdf`))}>Créer</button>
      </Section>
      <Section id="resize" title="Changer le format des pages">
        <div className="row">
          <select value={resize} onChange={(e) => setResize(e.target.value)}>
            {Object.keys(PAGE_SIZES).map((s) => <option key={s}>{s}</option>)}
          </select>
          <button onClick={run('Redimensionnement', async () => ctx.replace(await resizePages(await ctx.getBytes(), resize), `Pages au format ${resize}`))}>Appliquer</button>
        </div>
        <p className="muted">Le contenu est mis à l'échelle et centré ; l'orientation de chaque page est conservée.</p>
      </Section>
      <Section id="bookmarks" title={`Signets (${marks.length})`}>
        <div className="marks">
          {marks.map((m, i) => (
            <div key={i} className="row">
              <input value={m.title} onChange={(e) => setMarks(marks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} style={{ flex: 1 }} />
              <input type="number" min={1} max={ctx.numPages} value={m.page + 1} onChange={(e) => setMarks(marks.map((x, j) => (j === i ? { ...x, page: +e.target.value - 1 } : x)))} style={{ width: 60 }} />
              <button className="icon" title="Monter" disabled={i === 0} onClick={() => { const c = [...marks]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; setMarks(c); }}>↑</button>
              <button className="icon" title="Supprimer" onClick={() => setMarks(marks.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <div className="row">
          <button onClick={() => setMarks([...marks, { title: `Page ${ctx.currentPage + 1}`, page: ctx.currentPage }])}>+ Page courante</button>
          <button onClick={() => setMarks([...marks].sort((a, b) => a.page - b.page))}>Trier</button>
          <button className="primary" onClick={run('Signets', async () => ctx.replace(await setBookmarks(await ctx.getBytes(), marks), 'Signets enregistrés'))}>Enregistrer</button>
        </div>
      </Section>
      <Section id="attach" title="Pièces jointes">
        <label>Description (facultative) <input value={attDesc} onChange={(e) => setAttDesc(e.target.value)} /></label>
        <button onClick={run('Pièce jointe', async () => {
          const files = await pick('*/*');
          let b = await ctx.getBytes();
          for (const f of files) b = await attachFile(b, f, attDesc);
          if (files.length) await ctx.replace(b, `${files.length} fichier(s) joint(s)`);
        })}>Joindre des fichiers…</button>
        <p className="muted">Les pièces jointes existantes sont listées dans Infos & paramètres → Document.</p>
      </Section>
      <Section id="viewer" title="Préférences d'affichage">
        <p className="muted">Comment le PDF s'ouvrira dans les autres lecteurs.</p>
        <label>Disposition
          <select value={prefs.pageLayout} onChange={(e) => setPrefs({ ...prefs, pageLayout: e.target.value as ViewerPrefs['pageLayout'] })}>
            <option value="SinglePage">Une page</option>
            <option value="OneColumn">Défilement continu</option>
            <option value="TwoColumnLeft">Deux pages continues</option>
            <option value="TwoPageLeft">Deux pages</option>
          </select>
        </label>
        <label>Panneau à l'ouverture
          <select value={prefs.pageMode} onChange={(e) => setPrefs({ ...prefs, pageMode: e.target.value as ViewerPrefs['pageMode'] })}>
            <option value="UseNone">Aucun</option>
            <option value="UseOutlines">Signets</option>
            <option value="UseThumbs">Miniatures</option>
            <option value="FullScreen">Plein écran</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={prefs.displayDocTitle} onChange={(e) => setPrefs({ ...prefs, displayDocTitle: e.target.checked })} /> Afficher le titre plutôt que le nom du fichier</label>
        <label className="check"><input type="checkbox" checked={prefs.fitWindow} onChange={(e) => setPrefs({ ...prefs, fitWindow: e.target.checked })} /> Ajuster la fenêtre à la page</label>
        <label className="check"><input type="checkbox" checked={prefs.hideToolbar} onChange={(e) => setPrefs({ ...prefs, hideToolbar: e.target.checked })} /> Masquer la barre d'outils</label>
        <button onClick={run('Préférences', async () => ctx.replace(await setViewerPrefs(await ctx.getBytes(), prefs), "Préférences d'affichage enregistrées"))}>Appliquer</button>
      </Section>
      <Section id="flatten" title="Aplatir">
        <p className="muted">Fige les champs de formulaire et les annotations dans le contenu des pages (plus modifiables).</p>
        <button onClick={run('Aplatissement', async () => ctx.replace(await writeFields(await ctx.getBytes(), {}, true), 'Document aplati'))}>Aplatir le document</button>
      </Section>
    </>
  );
}
