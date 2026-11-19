import { useEffect, useState } from 'react';
import { readFields, writeFields, type FieldInfo } from '../pdf/forms';
import type { DocCtx } from './ToolsPanel';
import type { Annotation } from '../types';
import { detectFields } from '../pdf/formDetect';
import { applyAnnotations } from '../pdf/writer';
import { toCsv, toXlsx } from '../pdf/xlsx';
import { baseName, download } from '../pdf/tools';
import { clickInput } from '../platform';
import { loadProfile, matchField } from '../profile';

export function FormPanel({ ctx }: { ctx: DocCtx }) {
  const [fields, setFields] = useState<FieldInfo[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [flatten, setFlatten] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ctx
      .getBytes()
      .then(readFields)
      .then((f) => {
        setFields(f);
        setValues(Object.fromEntries(f.map((x) => [x.name, x.value])));
      })
      .catch(() => setFields([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.pdf]);

  /** reconnaissance automatique → vrais champs PDF (les autres annotations restent modifiables) */
  const recognize = async () => {
    setBusy(true);
    try {
      const found = await detectFields(ctx.pdf);
      if (!found.length) return ctx.notify('Aucune zone à remplir reconnue sur ce document.');
      const anns: Annotation[] = found.map((f, i) => ({
        id: `auto${Date.now().toString(36)}${i}`,
        page: f.page,
        kind: 'field',
        color: '#3d52d5',
        strokeWidth: 1,
        opacity: 1,
        createdAt: Date.now(),
        rect: f.rect,
        fieldType: f.type === 'multiline' ? 'multiline' : f.type,
        fieldName: f.name,
      }));
      const bytes = await applyAnnotations(await ctx.getBytesRaw(), anns, ctx.pdf);
      await ctx.replaceKeep(bytes, `${found.length} champ(s) reconnu(s) et créé(s)`, ctx.annotations);
    } catch (e) {
      ctx.notify(`Reconnaissance impossible : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const exportValues = (fmt: 'xlsx' | 'csv') => {
    const rows = [['Champ', 'Valeur'], ...(fields ?? []).map((f) => [f.name, typeof values[f.name] === 'boolean' ? (values[f.name] ? 'Oui' : 'Non') : String(values[f.name] ?? '')])];
    const base = baseName(ctx.name);
    if (fmt === 'csv') download(toCsv(rows), `${base}-reponses.csv`, 'text/csv;charset=utf-8');
    else download(toXlsx([{ name: 'Réponses', rows, header: true }]), `${base}-reponses.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  const importCsv = () => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = '.csv,text/csv';
    i.onchange = async () => {
      const f = i.files?.[0];
      if (!f) return;
      const text = (await f.text()).replace(/^\ufeff/, '');
      const next = { ...values };
      let n = 0;
      for (const line of text.split(/\r?\n/)) {
        const [k, ...v] = line.split(/;|\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
        const key = k?.replace(/^"|"$/g, '').trim();
        const val = v.join(';').replace(/^"|"$/g, '').trim();
        const fd = fields?.find((x) => x.name === key);
        if (!fd) continue;
        next[key] = fd.type === 'checkbox' ? /^(oui|yes|x|1|vrai|true)$/i.test(val) : val;
        n++;
      }
      setValues(next);
      ctx.notify(`${n} champ(s) rempli(s) depuis « ${f.name} ». Vérifiez puis appliquez.`);
    };
    clickInput(i);
  };

  useEffect(() => {
    const on = (e: Event) => {
      const act = (e as CustomEvent).detail as string;
      if (act === 'recognize') recognize();
      else if (act === 'export') exportValues('xlsx');
    };
    window.addEventListener('nova:form-action', on);
    return () => window.removeEventListener('nova:form-action', on);
  });

  if (!fields) return <div className="panel"><p className="empty">Lecture des champs…</p></div>;

  return (
    <div className="panel form-panel">
      <header className="panel-head">
        <h2>Formulaire</h2>
      </header>
      <div className="form-tools">
        <button className="primary-soft" disabled={busy} onClick={() => recognize()} title="Repère les lignes de saisie, cases et cadres vides et crée de vrais champs à remplir">
          ✦ Reconnaître les champs automatiquement
        </button>
        <button onClick={() => ctx.selectTool('field')} title="Dessiner un champ : texte, date, case, boutons radio, liste déroulante">
          ＋ Ajouter un champ à la main
        </button>
        {fields.length > 0 && (
          <div className="row">
            <button onClick={() => exportValues('xlsx')}>Exporter les réponses (Excel)</button>
            <button onClick={() => exportValues('csv')}>CSV</button>
            <button onClick={() => importCsv()} title="Remplir le formulaire à partir d'un fichier CSV (nom du champ ; valeur)">Importer…</button>
          </div>
        )}
        <small className="muted">Pour extraire les réponses de nombreux formulaires d'un coup : Outils → Traitement par lots.</small>
      </div>
      {fields.length === 0 ? (
        <p className="empty">
          Aucun champ interactif pour l'instant. Utilisez <b>✦ Reconnaître les champs</b> pour transformer ce formulaire « papier » en formulaire à remplir,
          ou l'outil <b>Texte</b> (T) pour écrire n'importe où.
        </p>
      ) : (
        <>
          <p className="muted">{fields.length} champ(s) détecté(s).</p>
          <button
            onClick={() => {
              const prof = loadProfile();
              const next = { ...values };
              let n = 0;
              for (const f of fields) {
                if (f.type !== 'text' || String(values[f.name] ?? '').trim()) continue;
                const v = matchField(f.name, prof);
                if (v) {
                  next[f.name] = v;
                  n++;
                }
              }
              setValues(next);
              ctx.notify(n ? `${n} champ(s) rempli(s) avec votre profil. Vérifiez puis appliquez.` : 'Aucun champ reconnu, ou profil vide (Infos → Profil).');
            }}
          >
            ✨ Remplir avec mon profil
          </button>
          <div className="fields">
            {fields.map((f) => (
              <label key={f.name} className={f.type === 'checkbox' ? 'check' : ''}>
                {f.type === 'checkbox' ? (
                  <>
                    <input type="checkbox" checked={!!values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
                    {f.name}
                  </>
                ) : (
                  <>
                    <span>{f.name}</span>
                    {f.type === 'text' ? (
                      f.multiline ? (
                        <textarea value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                      ) : (
                        <input value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                      )
                    ) : (
                      <select value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                        <option value="">—</option>
                        {f.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    )}
                  </>
                )}
              </label>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> Figer le formulaire (non modifiable ensuite)
          </label>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await ctx.replace(await writeFields(await ctx.getBytes(), values, flatten), 'Formulaire rempli');
              } catch (e) {
                ctx.notify(`Erreur : ${(e as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            Appliquer au document
          </button>
        </>
      )}
    </div>
  );
}
