import { useEffect, useState } from 'react';
import { readFields, writeFields, type FieldInfo } from '../pdf/forms';
import type { DocCtx } from './ToolsPanel';

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

  if (!fields) return <div className="panel"><p className="empty">Lecture des champs…</p></div>;

  return (
    <div className="panel form-panel">
      <header className="panel-head">
        <h2>Formulaire</h2>
      </header>
      {fields.length === 0 ? (
        <p className="empty">
          Aucun champ interactif. Pour un formulaire « papier », utilisez l'outil <b>Texte</b> (T) pour écrire n'importe où, et
          <b> Signature</b> pour signer.
        </p>
      ) : (
        <>
          <p className="muted">{fields.length} champ(s) détecté(s).</p>
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
