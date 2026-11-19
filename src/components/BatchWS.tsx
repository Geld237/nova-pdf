import { useEffect, useRef, useState } from 'react';
import { zipSync } from 'fflate';
import { clickInput } from '../platform';
import { ui } from '../dialogs';
import { openPdf, renderPageToCanvas, extractAllText, type PDFDocumentProxy } from '../pdf/engine';
import { addWatermark, baseName, download, optimize, stripMeta } from '../pdf/tools';
import { compressRaster, cropPages } from '../pdf/advanced';
import { makeSearchable, ocrPages } from '../pdf/ocr';
import { readFields, writeFields } from '../pdf/forms';
import { protectPdf } from '../pdf/security';
import { DEFAULT_HF, addHeaderFooter, type HeaderFooterOpts } from '../pdf/headerFooter';
import { pdfToDocxRich, pdfToPptx, pdfToXlsx } from '../pdf/convertPlus';
import { toPdfAImages, toPdfAKeep } from '../pdf/pdfa';
import { certInfo, loadCert, signPdf } from '../pdf/pades';
import { toXlsx } from '../pdf/xlsx';
import { HeaderFooterForm } from './ProTools';
import type { DocCtx } from './ToolsPanel';

interface Item {
  id: number;
  name: string;
  bytes: Uint8Array;
  status: 'attente' | 'en cours' | 'terminé' | 'erreur';
  msg?: string;
}

type Output = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'png' | 'txt';

interface Steps {
  ocr: boolean;
  hf: boolean;
  watermark: boolean;
  crop: boolean;
  compress: 'non' | 'sans-perte' | 'forte';
  flatten: boolean;
  strip: boolean;
  pdfa: 'non' | 'keep' | 'image';
  protect: boolean;
  sign: boolean;
  forms: boolean;
}

const STEP_LABELS: [keyof Steps, string][] = [
  ['ocr', 'OCR (rendre cherchable)'],
  ['hf', 'En-tête / pied de page / Bates'],
  ['watermark', 'Filigrane'],
  ['crop', 'Recadrer'],
  ['flatten', 'Aplatir formulaires et annotations'],
  ['strip', 'Supprimer les métadonnées'],
  ['protect', 'Protéger par mot de passe'],
  ['sign', 'Signer avec mon certificat'],
  ['forms', 'Extraire les données de formulaire (un tableau Excel)'],
];

let nextId = 1;

/** Traitement par lots : plusieurs PDF × une suite d'actions, résultat en ZIP. */
export function BatchWS({ ctx }: { ctx: DocCtx }) {
  const [items, setItems] = useState<Item[]>([]);
  const [steps, setSteps] = useState<Steps>({ ocr: false, hf: false, watermark: false, crop: false, compress: 'non', flatten: false, strip: false, pdfa: 'non', protect: false, sign: false, forms: false });
  const [output, setOutput] = useState<Output>('pdf');
  const [ocrLang, setOcrLang] = useState(ctx.ocrLang);
  const [hf, setHf] = useState<HeaderFooterOpts>({ ...DEFAULT_HF, footer: ['{fichier}', '', '{bates}'] });
  const [wm, setWm] = useState({ text: 'CONFIDENTIEL', color: '#d32f2f', opacity: 0.18, size: 64 });
  const [crop, setCrop] = useState(10);
  const [pw, setPw] = useState('');
  const [certPw, setCertPw] = useState('');
  const [suffix, setSuffix] = useState('-traite');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [hasCert, setHasCert] = useState(false);
  const stop = useRef(false);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    loadCert().then((c) => setHasCert(!!c)).catch(() => {});
  }, []);

  const addFiles = async (files: File[]) => {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    const add = await Promise.all(pdfs.map(async (f) => ({ id: nextId++, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), status: 'attente' as const })));
    setItems((it) => [...it, ...add]);
  };
  const pick = () => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'application/pdf';
    i.multiple = true;
    i.onchange = () => addFiles(Array.from(i.files ?? []));
    clickInput(i);
  };
  const addCurrent = async () => {
    const bytes = await ctx.getBytes();
    setItems((it) => [...it, { id: nextId++, name: ctx.name, bytes, status: 'attente' }]);
  };
  const upd = (id: number, p: Partial<Item>) => setItems((it) => it.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const needsPdfOutput = output === 'pdf';
  const anyStep = Object.entries(steps).some(([k, v]) => (k === 'compress' || k === 'pdfa' ? v !== 'non' : v));

  const run = async () => {
    if (!items.length) return;
    if (steps.protect && !pw) return ui.alert('Indiquez le mot de passe de protection.');
    let p12: Uint8Array | null = null;
    if (steps.sign) {
      const c = await loadCert();
      if (!c) return ui.alert('Aucun certificat mémorisé : ouvrez d\'abord Outils → Signature numérique pour importer ou créer le vôtre.');
      try {
        certInfo(c.p12, certPw);
      } catch (e) {
        return ui.alert((e as Error).message);
      }
      p12 = c.p12;
    }
    stop.current = false;
    setRunning(true);
    const files: Record<string, Uint8Array<ArrayBufferLike>> = {};
    const used = new Set<string>();
    const uniq = (n: string) => {
      let s = n;
      for (let k = 2; used.has(s); k++) s = n.replace(/(\.[^.]+)$/, `-${k}$1`);
      used.add(s);
      return s;
    };
    const formRows: Record<string, string>[] = [];
    let bates = hf.bates.start;
    for (const it of items) {
      if (stop.current) break;
      upd(it.id, { status: 'en cours', msg: '' });
      let doc: PDFDocumentProxy | null = null;
      const base = baseName(it.name);
      const say = (m: string) => {
        upd(it.id, { msg: m });
        setProgress(`${it.name} — ${m}`);
      };
      try {
        let b: Uint8Array<ArrayBufferLike> = it.bytes.slice();
        const view = async () => {
          if (doc) await doc.loadingTask.destroy();
          doc = await openPdf(b.slice(), (retry) => ui.prompt(`${retry ? 'Mot de passe incorrect. ' : ''}Mot de passe de « ${it.name} » :`, '', { password: true }));
          return doc;
        };
        if (steps.forms) {
          const fields = await readFields(b);
          const row: Record<string, string> = { Fichier: it.name };
          for (const f of fields) row[f.name] = typeof f.value === 'boolean' ? (f.value ? 'Oui' : 'Non') : f.value;
          formRows.push(row);
        }
        if (steps.ocr) {
          say('OCR');
          const d = await view();
          const res = await ocrPages(d, Array.from({ length: d.numPages }, (_, i) => i), ocrLang, (m, r) => say(`OCR ${Math.round(r * 100)} % ${m}`));
          b = await makeSearchable(b, d, res);
        }
        if (steps.hf) {
          say('en-tête / pied');
          const r = await addHeaderFooter(b, { ...hf, fileName: it.name, batesOffset: bates });
          b = r.bytes;
          bates = r.nextBates;
        }
        if (steps.watermark) b = await addWatermark(b, wm.text, wm);
        if (steps.crop) b = await cropPages(b, { top: crop, right: crop, bottom: crop, left: crop }, 'all');
        if (steps.flatten) b = await writeFields(b, {}, true);
        if (steps.compress === 'sans-perte') b = await optimize(b);
        if (steps.compress === 'forte') {
          say('compression');
          const d = await view();
          const c = await compressRaster(d, 110, 0.6);
          if (c.length < b.length) b = c;
        }
        if (steps.strip) b = await stripMeta(b);
        if (steps.pdfa !== 'non') {
          say('PDF/A');
          b = steps.pdfa === 'keep' ? (await toPdfAKeep(b, base)).bytes : await toPdfAImages(await view(), base);
        }
        if (needsPdfOutput) {
          if (steps.protect) b = await protectPdf(b, pw, pw, { printing: true, modifying: false, copying: false, annotating: true, fillingForms: true, documentAssembly: false });
          if (p12) {
            say('signature');
            b = await signPdf(b, p12, certPw, { reason: 'Signature par lot' });
          }
          files[uniq(`${base}${suffix}.pdf`)] = b;
        } else {
          say(`conversion ${output}`);
          const d = await view();
          if (output === 'docx') files[uniq(`${base}.docx`)] = new Uint8Array(await (await pdfToDocxRich(d, base)).arrayBuffer());
          if (output === 'xlsx') files[uniq(`${base}.xlsx`)] = await pdfToXlsx(d);
          if (output === 'pptx') files[uniq(`${base}.pptx`)] = new Uint8Array(await (await pdfToPptx(d, base)).arrayBuffer());
          if (output === 'txt') files[uniq(`${base}.txt`)] = new TextEncoder().encode((await extractAllText(d)).map((t) => t.text).join('\n\n\f'));
          if (output === 'png')
            for (let i = 0; i < d.numPages; i++) {
              const c = await renderPageToCanvas(d, i, 150 / 72);
              const blob = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), 'image/png'));
              files[uniq(`${base}/page-${String(i + 1).padStart(3, '0')}.png`)] = new Uint8Array(await blob.arrayBuffer());
            }
        }
        upd(it.id, { status: 'terminé', msg: '' });
      } catch (e) {
        upd(it.id, { status: 'erreur', msg: (e as Error).message });
      } finally {
        if (doc) await (doc as PDFDocumentProxy).loadingTask.destroy().catch(() => {});
      }
    }
    if (steps.forms && formRows.length) {
      const cols = ['Fichier', ...new Set(formRows.flatMap((r) => Object.keys(r)).filter((k) => k !== 'Fichier'))];
      files['donnees-formulaires.xlsx'] = toXlsx([{ name: 'Réponses', header: true, rows: [cols, ...formRows.map((r) => cols.map((c) => r[c] ?? ''))] }]);
    }
    setRunning(false);
    setProgress('');
    const names = Object.keys(files);
    if (!names.length) return;
    if (names.length === 1 && !names[0].includes('/')) {
      const n = names[0];
      download(new Blob([files[n] as BlobPart]), n, n.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    } else download(new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }), `nova-lot-${items.length}-fichiers.zip`, 'application/zip');
    ctx.notify(`Lot terminé : ${names.length} fichier(s) produit(s).`);
  };

  return (
    <div className="ws-body batch">
      <div className="batch-files">
        <div
          className={`batch-drop ${drag ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDrag(false); addFiles(Array.from(e.dataTransfer.files)); }}
        >
          <p>Déposez des PDF ici</p>
          <div className="row">
            <button className="primary" onClick={pick}>Ajouter des PDF…</button>
            <button onClick={addCurrent}>Ajouter le document ouvert</button>
          </div>
        </div>
        <ul className="batch-list">
          {items.map((it) => (
            <li key={it.id} className={`st-${it.status.replace(' ', '-')}`}>
              <span className="b-name" title={it.name}>{it.name}</span>
              <small className="muted">{Math.round(it.bytes.length / 1024)} Ko</small>
              <span className="b-status">{it.status === 'terminé' ? '✓' : it.status === 'erreur' ? '⚠︎' : it.status === 'en cours' ? '…' : ''} {it.msg}</span>
              {!running && <button className="icon" title="Retirer" onClick={() => setItems(items.filter((x) => x.id !== it.id))}>✕</button>}
            </li>
          ))}
        </ul>
        {items.length > 0 && <small className="muted">{items.length} fichier(s)</small>}
      </div>

      <div className="batch-steps">
        <h3>Actions, dans l'ordre</h3>
        {STEP_LABELS.map(([k, l]) => (
          <div key={k} className="b-step">
            <label className="check"><input type="checkbox" checked={steps[k] as boolean} onChange={(e) => setSteps({ ...steps, [k]: e.target.checked })} /> {l}</label>
            {k === 'ocr' && steps.ocr && (
              <select aria-label="Langue OCR" value={ocrLang} onChange={(e) => setOcrLang(e.target.value)}>
                <option value="fra+eng">Français + anglais</option>
                <option value="fra">Français</option>
                <option value="eng">Anglais</option>
                <option value="spa">Espagnol</option>
                <option value="deu">Allemand</option>
              </select>
            )}
            {k === 'hf' && steps.hf && <div className="b-sub"><HeaderFooterForm o={hf} set={setHf} /><small className="muted">La numérotation Bates continue d'un fichier à l'autre.</small></div>}
            {k === 'watermark' && steps.watermark && (
              <div className="row b-sub">
                <input aria-label="Texte du filigrane" value={wm.text} onChange={(e) => setWm({ ...wm, text: e.target.value })} />
                <input type="color" aria-label="Couleur" value={wm.color} onChange={(e) => setWm({ ...wm, color: e.target.value })} />
              </div>
            )}
            {k === 'crop' && steps.crop && <label className="b-sub">Marge à retirer (mm) <input type="number" min={0} value={crop} onChange={(e) => setCrop(+e.target.value)} style={{ width: 60 }} /></label>}
            {k === 'protect' && steps.protect && <input className="b-sub" type="password" aria-label="Mot de passe de protection" placeholder="Mot de passe" value={pw} onChange={(e) => setPw(e.target.value)} />}
            {k === 'sign' && steps.sign && (
              hasCert
                ? <input className="b-sub" type="password" aria-label="Mot de passe du certificat" placeholder="Mot de passe du certificat" value={certPw} onChange={(e) => setCertPw(e.target.value)} />
                : <small className="muted b-sub">Mémorisez d'abord un certificat dans Outils → Signature numérique.</small>
            )}
          </div>
        ))}
        <div className="b-step">
          <label>Compression
            <select value={steps.compress} onChange={(e) => setSteps({ ...steps, compress: e.target.value as Steps['compress'] })}>
              <option value="non">Aucune</option>
              <option value="sans-perte">Sans perte</option>
              <option value="forte">Forte (pages en images)</option>
            </select>
          </label>
        </div>
        <div className="b-step">
          <label>PDF/A
            <select value={steps.pdfa} onChange={(e) => setSteps({ ...steps, pdfa: e.target.value as Steps['pdfa'] })}>
              <option value="non">Non</option>
              <option value="keep">PDF/A-2b (texte conservé)</option>
              <option value="image">PDF/A-2b (pages en images)</option>
            </select>
          </label>
        </div>
        <h3>Résultat</h3>
        <div className="row">
          <select aria-label="Format de sortie" value={output} onChange={(e) => setOutput(e.target.value as Output)}>
            <option value="pdf">PDF</option>
            <option value="docx">Word (.docx)</option>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="pptx">PowerPoint (.pptx)</option>
            <option value="png">Images PNG</option>
            <option value="txt">Texte (.txt)</option>
          </select>
          {needsPdfOutput && <label>Suffixe <input value={suffix} onChange={(e) => setSuffix(e.target.value)} style={{ width: 90 }} /></label>}
        </div>
        {!needsPdfOutput && (steps.protect || steps.sign) && <small className="muted">Protection et signature ne s'appliquent qu'aux sorties PDF.</small>}
        <div className="row">
          {!running
            ? <button className="primary" disabled={!items.length || (!anyStep && needsPdfOutput)} onClick={run}>Lancer le traitement ({items.length})</button>
            : <button onClick={() => { stop.current = true; }}>Arrêter après ce fichier</button>}
        </div>
        {progress && <small className="muted">{progress}</small>}
        <p className="muted">Tout est fait sur cet appareil. Plusieurs fichiers → un ZIP.</p>
      </div>
    </div>
  );
}
