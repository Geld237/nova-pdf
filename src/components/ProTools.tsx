import { clickInput } from '../platform';
import { useEffect, useState } from 'react';
import { ui } from '../dialogs';
import { Section } from './ToolSection';
import { Thumb } from './Thumb';
import { DEFAULT_HF, HF_TOKENS, addHeaderFooter, type HeaderFooterOpts } from '../pdf/headerFooter';
import { certInfo, createSelfSigned, forgetCert, loadCert, saveCert, signPdf, type CertInfo } from '../pdf/pades';
import { toPdfAImages, toPdfAKeep } from '../pdf/pdfa';
import { baseName, download, parseRanges } from '../pdf/tools';
import type { DocCtx } from './ToolsPanel';

const pick = (accept: string) =>
  new Promise<File | undefined>((res) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => res(i.files?.[0]);
    clickInput(i);
  });

export const fmtHf = (s: string, o: HeaderFooterOpts, page: number, total: number) => {
  const d = new Date();
  const n = ((o.batesOffset ?? o.bates.start) + page).toString().padStart(o.bates.digits, '0');
  return s
    .replace(/\{page\}/g, String(page + o.startNumber))
    .replace(/\{total\}/g, String(total + o.startNumber - 1))
    .replace(/\{date\}/g, d.toLocaleDateString('fr-FR'))
    .replace(/\{heure\}/g, d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))
    .replace(/\{fichier\}/g, o.fileName)
    .replace(/\{bates\}/g, `${o.bates.prefix}${n}${o.bates.suffix}`);
};

/** Réglages d'en-tête / pied de page réutilisés par le traitement par lots. */
export function HeaderFooterForm({ o, set, preview }: { o: HeaderFooterOpts; set: (o: HeaderFooterOpts) => void; preview?: (s: string) => string }) {
  const [focus, setFocus] = useState<{ row: 'header' | 'footer'; i: number }>({ row: 'footer', i: 1 });
  const insert = (tok: string) => {
    const arr = [...o[focus.row]] as [string, string, string];
    arr[focus.i] = `${arr[focus.i]}${tok}`;
    set({ ...o, [focus.row]: arr });
  };
  return (
    <>
      {(['header', 'footer'] as const).map((row) => (
        <div key={row} className="hf-row">
          <small className="muted">{row === 'header' ? 'En-tête' : 'Pied de page'} — gauche · centre · droite</small>
          <div className="hf-cells">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                aria-label={`${row === 'header' ? 'En-tête' : 'Pied'} ${['gauche', 'centre', 'droite'][i]}`}
                value={o[row][i]}
                onFocus={() => setFocus({ row, i })}
                onChange={(e) => {
                  const arr = [...o[row]] as [string, string, string];
                  arr[i] = e.target.value;
                  set({ ...o, [row]: arr });
                }}
                placeholder={['gauche', 'centre', 'droite'][i]}
                title={preview ? preview(o[row][i]) : undefined}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="chips">
        {HF_TOKENS.map(([t, l]) => (
          <button key={t} className="chip" title={`Insérer : ${l}`} onClick={() => insert(t)}>{t}</button>
        ))}
      </div>
      <div className="row">
        <label>Taille <input type="number" min={6} max={36} value={o.size} onChange={(e) => set({ ...o, size: +e.target.value })} style={{ width: 56 }} /></label>
        <label>Couleur <input type="color" value={o.color} onChange={(e) => set({ ...o, color: e.target.value })} /></label>
        <label>Police
          <select value={o.font} onChange={(e) => set({ ...o, font: e.target.value as HeaderFooterOpts['font'] })}>
            <option value="sans">Sans empattement</option>
            <option value="serif">Avec empattement</option>
            <option value="mono">Machine à écrire</option>
          </select>
        </label>
        <label>Marge (pt) <input type="number" min={4} max={120} value={o.margin} onChange={(e) => set({ ...o, margin: +e.target.value })} style={{ width: 56 }} /></label>
      </div>
      <div className="row">
        <label>Pages
          <select value={Array.isArray(o.pages) ? 'list' : o.pages} onChange={(e) => set({ ...o, pages: e.target.value === 'list' ? [0] : (e.target.value as 'all') })}>
            <option value="all">Toutes</option>
            <option value="odd">Impaires</option>
            <option value="even">Paires</option>
            <option value="list">Liste…</option>
          </select>
        </label>
        {Array.isArray(o.pages) && (
          <input
            aria-label="Liste des pages"
            defaultValue={o.pages.map((p) => p + 1).join(', ')}
            onBlur={(e) => set({ ...o, pages: parseRanges(e.target.value, 9999).flat() })}
            placeholder="1, 3-5"
            style={{ width: 90 }}
          />
        )}
        <label>1er numéro <input type="number" value={o.startNumber} onChange={(e) => set({ ...o, startNumber: +e.target.value })} style={{ width: 56 }} /></label>
        <label className="check"><input type="checkbox" checked={o.skipFirst} onChange={(e) => set({ ...o, skipFirst: e.target.checked })} /> Pas sur la 1re page</label>
      </div>
      <details className="bates">
        <summary>Numérotation Bates (juridique) — variable {'{bates}'}</summary>
        <div className="row">
          <label>Préfixe <input value={o.bates.prefix} onChange={(e) => set({ ...o, bates: { ...o.bates, prefix: e.target.value } })} style={{ width: 80 }} /></label>
          <label>Début <input type="number" min={0} value={o.bates.start} onChange={(e) => set({ ...o, bates: { ...o.bates, start: +e.target.value } })} style={{ width: 80 }} /></label>
          <label>Chiffres <input type="number" min={1} max={12} value={o.bates.digits} onChange={(e) => set({ ...o, bates: { ...o.bates, digits: +e.target.value } })} style={{ width: 50 }} /></label>
          <label>Suffixe <input value={o.bates.suffix} onChange={(e) => set({ ...o, bates: { ...o.bates, suffix: e.target.value } })} style={{ width: 70 }} /></label>
        </div>
        <button onClick={() => set({ ...o, footer: [o.footer[0], o.footer[1], '{bates}'] })}>Mettre le numéro Bates en bas à droite</button>
      </details>
    </>
  );
}

/** Outils « pro » : en-têtes/pieds + Bates, signature numérique par certificat, PDF/A. */
export function ProTools({ ctx, run }: { ctx: DocCtx; run: (label: string, fn: () => Promise<void>) => () => void }) {
  const base = baseName(ctx.name);
  // en-tête / pied
  const [hf, setHf] = useState<HeaderFooterOpts>({ ...DEFAULT_HF, fileName: ctx.name });
  useEffect(() => setHf((o) => ({ ...o, fileName: ctx.name })), [ctx.name]);
  const prev = (s: string) => fmtHf(s, hf, ctx.currentPage, ctx.numPages);

  // certificat
  const [cert, setCert] = useState<{ p12: Uint8Array; label: string } | null>(null);
  const [pw, setPw] = useState('');
  const [info, setInfo] = useState<CertInfo | null>(null);
  const [remember, setRemember] = useState(true);
  const [sig, setSig] = useState({ reason: 'Approbation du document', location: '', contact: '', visible: true, page: 'last' as 'first' | 'last' | 'current', pos: 'br' as 'br' | 'bl' | 'tr' });
  const [create, setCreate] = useState<{ name: string; email: string; org: string; pw: string } | null>(null);
  useEffect(() => {
    loadCert().then((c) => c && setCert(c)).catch(() => {});
  }, []);
  const unlock = () => {
    if (!cert) return;
    try {
      setInfo(certInfo(cert.p12, pw));
    } catch (e) {
      setInfo(null);
      ctx.notify((e as Error).message);
    }
  };

  // PDF/A
  const [pdfaMode, setPdfaMode] = useState<'keep' | 'image'>('keep');
  const [pdfaProg, setPdfaProg] = useState('');

  return (
    <>
      <Section id="headerfooter" title="En-tête, pied de page et Bates">
        <div className="live-preview hf-preview">
          <Thumb doc={ctx.pdf} page={ctx.currentPage} width={220} />
          {(['header', 'footer'] as const).map((row) => (
            <div key={row} className={`hf-prev ${row}`} style={{ color: hf.color, fontSize: Math.max(5, hf.size * (220 / 595)) }}>
              {hf[row].map((s, i) => <span key={i}>{prev(s)}</span>)}
            </div>
          ))}
        </div>
        <HeaderFooterForm o={hf} set={setHf} preview={prev} />
        <button className="primary" onClick={run('En-tête et pied de page', async () => {
          const { bytes } = await addHeaderFooter(await ctx.getBytes(), hf);
          await ctx.replace(bytes, 'En-tête et pied de page ajoutés');
        })}>Appliquer</button>
      </Section>

      <Section id="certsign" title="Signature numérique (certificat)">
        <p className="muted">
          Signature électronique avancée au format PAdES : toute modification ultérieure du fichier est détectée par Adobe Acrobat et les autres lecteurs.
          La clé reste sur cet appareil.
        </p>
        {!cert ? (
          <div className="col">
            <button onClick={run('Certificat', async () => {
              const f = await pick('.p12,.pfx,application/x-pkcs12');
              if (!f) return;
              setCert({ p12: new Uint8Array(await f.arrayBuffer()), label: f.name });
              setInfo(null);
            })}>Importer un certificat (.p12 / .pfx)…</button>
            <button onClick={() => setCreate({ name: '', email: '', org: '', pw: '' })}>Créer mon certificat personnel…</button>
          </div>
        ) : (
          <div className="cert-card">
            <div className="row">
              <strong>🔐 {cert.label}</strong>
              <button className="link" onClick={() => { setCert(null); setInfo(null); setPw(''); forgetCert().catch(() => {}); }}>Changer</button>
            </div>
            {!info ? (
              <div className="row">
                <input type="password" aria-label="Mot de passe du certificat" placeholder="Mot de passe du certificat" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} />
                <button onClick={unlock}>Déverrouiller</button>
              </div>
            ) : (
              <div className="cert-info">
                <div>{info.name}{info.org ? ` — ${info.org}` : ''}{info.email ? ` <${info.email}>` : ''}</div>
                <small className="muted">Émis par {info.selfSigned ? 'vous-même (auto-signé)' : info.issuer} · valide jusqu'au {info.validTo.toLocaleDateString('fr-FR')}</small>
                {info.selfSigned && <small className="muted">Un certificat auto-signé prouve l'intégrité du document ; pour une identité reconnue, importez un certificat d'une autorité (eIDAS, carte professionnelle…).</small>}
              </div>
            )}
          </div>
        )}
        {create && (
          <div className="cert-create">
            <label>Nom complet <input value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></label>
            <label>E-mail <input type="email" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} /></label>
            <label>Organisation <input value={create.org} onChange={(e) => setCreate({ ...create, org: e.target.value })} /></label>
            <label>Mot de passe de protection <input type="password" value={create.pw} onChange={(e) => setCreate({ ...create, pw: e.target.value })} /></label>
            <div className="row">
              <button className="primary" disabled={!create.name.trim() || create.pw.length < 4} onClick={run('Création du certificat', async () => {
                const p12 = await createSelfSigned({ name: create.name.trim(), email: create.email.trim() || undefined, org: create.org.trim() || undefined, password: create.pw });
                const label = `${create.name.trim()}.p12`;
                setCert({ p12, label });
                setPw(create.pw);
                setInfo(certInfo(p12, create.pw));
                download(new Blob([p12 as BlobPart], { type: 'application/x-pkcs12' }), label, 'application/x-pkcs12');
                setCreate(null);
                ctx.notify('Certificat créé (copie de sauvegarde téléchargée).');
              })}>Créer (RSA 2048, 3 ans)</button>
              <button onClick={() => setCreate(null)}>Annuler</button>
            </div>
          </div>
        )}
        {cert && info && (
          <>
            <label>Motif <input value={sig.reason} onChange={(e) => setSig({ ...sig, reason: e.target.value })} /></label>
            <div className="row">
              <label>Lieu <input value={sig.location} onChange={(e) => setSig({ ...sig, location: e.target.value })} /></label>
              <label>Contact <input value={sig.contact} onChange={(e) => setSig({ ...sig, contact: e.target.value })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={sig.visible} onChange={(e) => setSig({ ...sig, visible: e.target.checked })} /> Cachet visible sur la page</label>
            {sig.visible && (
              <div className="row">
                <select aria-label="Page du cachet" value={sig.page} onChange={(e) => setSig({ ...sig, page: e.target.value as 'last' })}>
                  <option value="last">Dernière page</option>
                  <option value="first">Première page</option>
                  <option value="current">Page courante</option>
                </select>
                <select aria-label="Position du cachet" value={sig.pos} onChange={(e) => setSig({ ...sig, pos: e.target.value as 'br' })}>
                  <option value="br">En bas à droite</option>
                  <option value="bl">En bas à gauche</option>
                  <option value="tr">En haut à droite</option>
                </select>
              </div>
            )}
            <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Mémoriser le certificat sur cet appareil (chiffré par son mot de passe)</label>
            <button className="primary" onClick={run('Signature numérique', async () => {
              const page = sig.page === 'first' ? 0 : sig.page === 'current' ? ctx.currentPage : ctx.numPages - 1;
              const pg = await ctx.pdf.getPage(page + 1);
              const vp = pg.getViewport({ scale: 1 });
              const w = 200, h = 60, m = 36;
              const x = sig.pos === 'bl' ? m : vp.width - w - m;
              const y = sig.pos === 'tr' ? m : vp.height - h - m;
              const signed = await signPdf(await ctx.getBytes(), cert.p12, pw, {
                reason: sig.reason, location: sig.location, contact: sig.contact,
                visible: sig.visible ? { page, rect: { x, y, w, h } } : undefined,
              });
              if (remember) await saveCert(cert.p12, cert.label);
              download(signed, `${base}-signe.pdf`);
              ctx.notify('PDF signé téléchargé. Ne le modifiez plus : toute modification invaliderait la signature.');
            })}>Signer et télécharger</button>
            <p className="muted">
              Signez en dernier, une fois le document terminé. Une nouvelle signature dans Nova réécrit le fichier : les signatures déjà présentes ne restent pas valides.
            </p>
          </>
        )}
      </Section>

      <Section id="pdfa" title="Archiver en PDF/A">
        <p className="muted">PDF/A-2b : format normalisé d'archivage à long terme (administrations, tribunaux, bibliothèques). Profil couleur sRGB, métadonnées XMP, sans chiffrement ni script.</p>
        <label className="check"><input type="radio" name="pdfa" checked={pdfaMode === 'keep'} onChange={() => setPdfaMode('keep')} /> Garder le texte sélectionnable (les polices doivent être intégrées)</label>
        <label className="check"><input type="radio" name="pdfa" checked={pdfaMode === 'image'} onChange={() => setPdfaMode('image')} /> Pages en images (conformité la plus sûre, texte non sélectionnable)</label>
        <button className="primary" onClick={run('Conversion PDF/A', async () => {
          if (pdfaMode === 'keep') {
            const { bytes, missingFonts } = await toPdfAKeep(await ctx.getBytes(), base);
            download(bytes, `${base}-PDFA.pdf`);
            if (missingFonts.length)
              await ui.alert(`PDF/A créé, mais ${missingFonts.length} police(s) ne sont pas intégrées (${missingFonts.slice(0, 5).join(', ')}${missingFonts.length > 5 ? '…' : ''}) : un validateur strict refusera le fichier. Choisissez « Pages en images » pour une conformité garantie, puis l'OCR si vous voulez rechercher dans le texte.`);
            else ctx.notify('PDF/A-2b téléchargé.');
          } else {
            const bytes = await toPdfAImages(ctx.pdf, base, 200, (i, n) => setPdfaProg(`page ${i + 1}/${n}`));
            setPdfaProg('');
            download(bytes, `${base}-PDFA.pdf`);
            ctx.notify('PDF/A-2b (pages en images) téléchargé.');
          }
        })}>Créer la version PDF/A</button>
        {pdfaProg && <small className="muted">{pdfaProg}</small>}
      </Section>
    </>
  );
}
