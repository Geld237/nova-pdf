import { useState } from 'react';
import { crossrefBibTeX, extractDois, extractReferences, toBibTeX, toRIS, type RefEntry } from '../refs';
import { baseName, download } from '../pdf/tools';
import type { DocCtx } from './ToolsPanel';

/** Recherche universitaire : bibliographie, DOI, export BibTeX / RIS (Zotero). */
export function RefsTool({ ctx }: { ctx: DocCtx }) {
  const [refs, setRefs] = useState<RefEntry[] | null>(null);
  const [dois, setDois] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const base = baseName(ctx.name);

  const analyze = () => {
    if (!ctx.texts) return;
    setRefs(extractReferences(ctx.texts));
    setDois(extractDois(ctx.texts));
  };

  const crossref = async () => {
    const list = dois.slice(0, 80);
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      setBusy(`Crossref ${i + 1}/${list.length}…`);
      const b = await crossrefBibTeX(list[i]);
      if (b) out.push(b);
    }
    setBusy(null);
    if (out.length) download(out.join('\n\n'), `${base}-crossref.bib`, 'application/x-bibtex;charset=utf-8');
    ctx.notify(`${out.length} notice(s) officielle(s) récupérée(s) sur ${list.length} DOI.`);
  };

  return (
    <details>
      <summary>Références bibliographiques</summary>
      <p className="muted">Extrait la bibliographie et les DOI. Les appels [12] du texte affichent la référence au survol.</p>
      <button disabled={!ctx.texts} onClick={analyze}>Analyser la bibliographie</button>
      {refs && (
        <>
          <p className="muted">{refs.length} référence(s), {dois.length} DOI trouvé(s).</p>
          <div className="row">
            <button disabled={!refs.length} onClick={() => download(toBibTeX(refs), `${base}.bib`, 'application/x-bibtex;charset=utf-8')}>BibTeX (.bib)</button>
            <button disabled={!refs.length} onClick={() => download(toRIS(refs), `${base}.ris`, 'application/x-research-info-systems;charset=utf-8')}>RIS (Zotero, Mendeley, EndNote)</button>
            <button disabled={!refs.length} onClick={() => navigator.clipboard?.writeText(refs.map((r) => (r.n ? `[${r.n}] ` : '') + r.raw).join('\n'))}>Copier</button>
          </div>
          {dois.length > 0 && (
            <button disabled={!!busy} onClick={crossref} title="Envoie uniquement les DOI à api.crossref.org">
              {busy ?? '🌐 Notices officielles via Crossref (en ligne, DOI seulement)'}
            </button>
          )}
          <ol className="ref-list">
            {refs.slice(0, 300).map((r, i) => (
              <li key={i} value={r.n}>
                {r.raw}
                {r.doi && (
                  <>
                    {' '}
                    <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">doi</a>
                  </>
                )}
              </li>
            ))}
          </ol>
          {!refs.length && <p className="empty">Aucune section « Références / Bibliographie » détectée.</p>}
        </>
      )}
    </details>
  );
}
