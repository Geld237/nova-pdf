import { useState } from 'react';
import { chat, type AiSettings } from '../ai/llm';
import { PII_LABELS, detectPii, type PiiHit, type PiiKind } from '../pii';
import type { Annotation } from '../types';
import type { DocCtx } from './ToolsPanel';

const DEFAULT: PiiKind[] = ['email', 'phone', 'iban', 'card', 'nir', 'siret', 'address', 'name'];

/** Anonymisation : repère les données personnelles et propose de les caviarder. */
export function PiiTool({ ctx, ai }: { ctx: DocCtx; ai: AiSettings }) {
  const [kinds, setKinds] = useState<Set<PiiKind>>(new Set(DEFAULT));
  const [extra, setExtra] = useState('');
  const [useAi, setUseAi] = useState(false);
  const [hits, setHits] = useState<PiiHit[] | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const scan = async () => {
    setBusy('Analyse…');
    try {
      let terms = extra.split(/[,\n;]/).map((t) => t.trim()).filter(Boolean);
      if (useAi && ctx.texts) {
        setBusy('Recherche des noms avec l’IA locale…');
        const sample = ctx.texts.map((t) => t.text).join('\n').slice(0, 6000);
        const out = await chat(
          ai,
          [
            { role: 'system', content: 'Tu extrais des entités. Réponds uniquement par une liste, un élément par ligne, sans commentaire.' },
            { role: 'user', content: `Liste les noms complets de personnes physiques et les noms d’organisations privées cités dans ce texte :\n${sample}` },
          ],
          () => {},
          () => {},
        ).catch(() => '');
        terms = [...terms, ...out.split('\n').map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter((l) => l.length > 2 && l.length < 60)];
      }
      const res = await detectPii(ctx.pdf, kinds, terms, (p) => setBusy(`Analyse de la page ${p + 1}/${ctx.numPages}…`));
      setHits(res);
      setKeep(new Set(res.map((h) => h.id)));
    } finally {
      setBusy(null);
    }
  };

  const apply = () => {
    const anns: Annotation[] = (hits ?? [])
      .filter((h) => keep.has(h.id))
      .flatMap((h) =>
        h.rects.map((r) => ({
          id: `${h.id}-${Math.random().toString(36).slice(2, 6)}`,
          page: h.page,
          kind: 'redact' as const,
          color: '#000000',
          opacity: 1,
          strokeWidth: 1,
          rect: r,
          text: `${PII_LABELS[h.kind]} : ${h.text}`,
          createdAt: Date.now(),
        })),
      );
    ctx.addAnnotations(anns);
    ctx.notify(`${anns.length} zone(s) à caviarder ajoutée(s). Vérifiez puis enregistrez : la suppression devient définitive.`);
    setHits(null);
  };

  const groups = (hits ?? []).reduce<Record<string, PiiHit[]>>((g, h) => ((g[h.kind] ??= []).push(h), g), {});

  return (
    <details>
      <summary>Anonymiser (données personnelles)</summary>
      <p className="muted">Repère automatiquement les données sensibles, sur l'appareil, puis les caviarde.</p>
      <div className="perm-grid">
        {(Object.keys(PII_LABELS) as PiiKind[]).map((k) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={kinds.has(k)}
              onChange={(e) => {
                const n = new Set(kinds);
                if (e.target.checked) n.add(k);
                else n.delete(k);
                setKinds(n);
              }}
            />
            {PII_LABELS[k]}
          </label>
        ))}
      </div>
      <label>
        Autres termes à masquer (séparés par des virgules)
        <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Dupont, ACME SARL, n° dossier 4521…" />
      </label>
      <label className="check">
        <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Trouver aussi les noms avec l'IA locale
      </label>
      <button className="primary" disabled={!!busy} onClick={scan}>{busy ?? 'Analyser le document'}</button>
      {hits && (
        <>
          <p className="muted">{hits.length} élément(s) trouvé(s). Décochez ceux à conserver.</p>
          <div className="pii-list">
            {Object.entries(groups).map(([k, list]) => (
              <div key={k}>
                <b>{PII_LABELS[k as PiiKind]} ({list.length})</b>
                {list.map((h) => (
                  <label key={h.id} className="check">
                    <input
                      type="checkbox"
                      checked={keep.has(h.id)}
                      onChange={(e) => {
                        const n = new Set(keep);
                        if (e.target.checked) n.add(h.id);
                        else n.delete(h.id);
                        setKeep(n);
                      }}
                    />
                    <span>{h.text}</span> <small className="muted">p. {h.page + 1}</small>
                  </label>
                ))}
              </div>
            ))}
          </div>
          {hits.length > 0 && <button className="primary" onClick={apply}>Caviarder {keep.size} élément(s)</button>}
        </>
      )}
    </details>
  );
}
