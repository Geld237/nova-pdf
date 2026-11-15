import { useEffect, useState } from 'react';
import { zipSync } from 'fflate';
import { openPdf, type PDFDocumentProxy } from '../pdf/engine';
import { baseName, download } from '../pdf/tools';
import type { Rect } from '../types';

/* Export en images : pages entières (PNG/JPG/WebP, résolution, plage, ZIP) ou zone capturée. */

type Fmt = 'png' | 'jpeg' | 'webp';
const MIME: Record<Fmt, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT: Record<Fmt, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/** « 1-3, 5, 8- » → indices 0-based */
export function parseRange(s: string, n: number): number[] {
  const out = new Set<number>();
  for (const part of s.split(/[,;]\s*/)) {
    const m = part.trim().match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : n;
      for (let i = Math.max(1, a); i <= Math.min(n, b); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part.trim())) {
      const i = +part.trim();
      if (i >= 1 && i <= n) out.add(i - 1);
    }
  }
  return [...out].sort((x, y) => x - y);
}

async function renderTo(pdf: PDFDocumentProxy, i: number, dpi: number, clip?: Rect, white = true) {
  const page = await pdf.getPage(i + 1);
  const scale = dpi / 72;
  const vp = page.getViewport({ scale });
  const full = document.createElement('canvas');
  full.width = Math.ceil(vp.width);
  full.height = Math.ceil(vp.height);
  const g = full.getContext('2d')!;
  if (white) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, full.width, full.height);
  }
  await page.render({ canvas: full, viewport: vp }).promise;
  if (!clip) return full;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(clip.w * scale));
  c.height = Math.max(1, Math.round(clip.h * scale));
  c.getContext('2d')!.drawImage(full, clip.x * scale, clip.y * scale, clip.w * scale, clip.h * scale, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (c: HTMLCanvasElement, fmt: Fmt, q: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Conversion impossible'))), MIME[fmt], fmt === 'png' ? undefined : q));

interface Props {
  pdf: PDFDocumentProxy;
  name: string;
  currentPage: number;
  /** renvoie le PDF avec les annotations appliquées */
  getBytes: () => Promise<Uint8Array>;
  hasAnnotations: boolean;
  zone?: { page: number; rect: Rect } | null;
  notify: (m: string) => void;
  onClose: () => void;
}

export function ImageExport({ pdf, name, currentPage, getBytes, hasAnnotations, zone, notify, onClose }: Props) {
  const [fmt, setFmt] = useState<Fmt>('png');
  const [q, setQ] = useState(0.9);
  const [dpi, setDpi] = useState(zone ? 300 : 150);
  const [which, setWhich] = useState<'current' | 'all' | 'range'>('current');
  const [range, setRange] = useState(`1-${pdf.numPages}`);
  const [withAnn, setWithAnn] = useState(true);
  const [zip, setZip] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const n = pdf.numPages;
  const base = baseName(name);

  const source = async () => (withAnn && hasAnnotations ? openPdf(await getBytes(), () => null) : pdf);

  // aperçu de la zone
  useEffect(() => {
    if (!zone) return;
    let url = '';
    (async () => {
      const c = await renderTo(await source(), zone.page, 150, zone.rect);
      url = URL.createObjectURL(await toBlob(c, 'png', 1));
      setPreview(url);
    })().catch(() => {});
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, withAnn]);

  const pages = zone ? [zone.page] : which === 'current' ? [currentPage] : which === 'all' ? [...Array(n).keys()] : parseRange(range, n);

  const run = async () => {
    if (!pages.length) return notify('Aucune page dans cette plage.');
    setBusy('Préparation…');
    try {
      const src = await source();
      const files: Record<string, Uint8Array> = {};
      const blobs: { blob: Blob; name: string }[] = [];
      for (let k = 0; k < pages.length; k++) {
        const i = pages[k];
        setBusy(`Page ${i + 1} (${k + 1}/${pages.length})…`);
        const c = await renderTo(src, i, dpi, zone?.rect);
        const blob = await toBlob(c, fmt, q);
        const fname = zone ? `${base}-p${i + 1}-zone.${EXT[fmt]}` : `${base}-p${String(i + 1).padStart(String(n).length, '0')}.${EXT[fmt]}`;
        if (zip && pages.length > 1) files[fname] = new Uint8Array(await blob.arrayBuffer());
        else blobs.push({ blob, name: fname });
      }
      if (Object.keys(files).length) download(new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }), `${base}-images.zip`, 'application/zip');
      for (const b of blobs) download(b.blob, b.name, MIME[fmt]);
      notify(`${pages.length} image(s) exportée(s).`);
      onClose();
    } catch (e) {
      notify(`Export impossible : ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      const c = await renderTo(await source(), zone!.page, dpi, zone!.rect);
      const blob = await toBlob(c, 'png', 1);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notify('Image copiée dans le presse-papiers.');
      onClose();
    } catch {
      notify('Copie impossible ici : utilisez « Enregistrer ».');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal image-export" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Exporter en images">
        <h3>{zone ? `Capture de la page ${zone.page + 1}` : 'Exporter en images'}</h3>
        {zone && <div className="ie-preview">{preview ? <img src={preview} alt="Aperçu de la zone" /> : <small className="muted">Aperçu…</small>}</div>}
        {!zone && (
          <div className="ie-row">
            <span>Pages</span>
            <div className="seg ie-seg">
              <button className={which === 'current' ? 'active' : ''} onClick={() => setWhich('current')}>Page {currentPage + 1}</button>
              <button className={which === 'all' ? 'active' : ''} onClick={() => setWhich('all')}>Toutes ({n})</button>
              <button className={which === 'range' ? 'active' : ''} onClick={() => setWhich('range')}>Choisir</button>
            </div>
          </div>
        )}
        {!zone && which === 'range' && (
          <div className="ie-row">
            <span />
            <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="ex. 1-3, 5, 8-" aria-label="Plage de pages" />
            <small className="muted">{pages.length} page(s)</small>
          </div>
        )}
        <div className="ie-row">
          <span>Format</span>
          <div className="seg ie-seg">
            {(['png', 'jpeg', 'webp'] as Fmt[]).map((f) => (
              <button key={f} className={fmt === f ? 'active' : ''} onClick={() => setFmt(f)}>{EXT[f].toUpperCase()}</button>
            ))}
          </div>
        </div>
        {fmt !== 'png' && (
          <label className="ie-row">
            <span>Qualité</span>
            <input type="range" min={0.4} max={1} step={0.05} value={q} onChange={(e) => setQ(+e.target.value)} />
            <output>{Math.round(q * 100)} %</output>
          </label>
        )}
        <div className="ie-row">
          <span>Résolution</span>
          <div className="seg ie-seg">
            {[72, 150, 300, 600].map((d) => (
              <button key={d} className={dpi === d ? 'active' : ''} onClick={() => setDpi(d)} title={{ 72: 'Écran', 150: 'Standard', 300: 'Impression', 600: 'Très haute' }[d]}>{d} dpi</button>
            ))}
          </div>
        </div>
        {hasAnnotations && (
          <label className="check"><input type="checkbox" checked={withAnn} onChange={(e) => setWithAnn(e.target.checked)} /> Inclure mes annotations</label>
        )}
        {!zone && pages.length > 1 && (
          <label className="check"><input type="checkbox" checked={zip} onChange={(e) => setZip(e.target.checked)} /> Regrouper dans un fichier ZIP</label>
        )}
        <div className="ie-actions">
          {busy && <small className="muted">⏳ {busy}</small>}
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Annuler</button>
          {zone && <button onClick={copy} disabled={!!busy}>Copier</button>}
          <button className="primary" onClick={run} disabled={!!busy}>{zone ? 'Enregistrer' : 'Exporter'}</button>
        </div>
      </div>
    </div>
  );
}
