import { useEffect, useState } from 'react';
import { baseName, download, extractPages, reorderPages } from '../pdf/tools';
import { Thumb } from './Thumb';
import type { DocCtx } from './ToolsPanel';

interface Item {
  key: string;
  src: number; // -1 = page blanche
  rotate: number;
}

const init = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ key: `p${i}`, src: i, rotate: 0 }));

export function OrganizePanel({ ctx }: { ctx: DocCtx }) {
  const [items, setItems] = useState<Item[]>(() => init(ctx.numPages));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setItems(init(ctx.numPages));
    setSel(new Set());
  }, [ctx.pdf, ctx.numPages]);

  const dirty = items.length !== ctx.numPages || items.some((it, i) => it.src !== i || it.rotate);
  const targets = sel.size ? items.filter((i) => sel.has(i.key)) : [];

  const toggle = (key: string, e: React.MouseEvent) => {
    const next = new Set(e.ctrlKey || e.metaKey || e.shiftKey ? sel : []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSel(next);
  };

  const rotate = (d: number) =>
    setItems(items.map((it) => (sel.has(it.key) ? { ...it, rotate: (it.rotate + d + 360) % 360 } : it)));
  const remove = () => {
    setItems(items.filter((it) => !sel.has(it.key)));
    setSel(new Set());
  };
  const duplicate = () =>
    setItems(items.flatMap((it) => (sel.has(it.key) ? [it, { ...it, key: `${it.key}-${Date.now()}` }] : [it])));
  const insertBlank = () => {
    const last = items.findLastIndex((it) => sel.has(it.key));
    const at = last >= 0 ? last + 1 : items.length;
    const copy = [...items];
    copy.splice(at, 0, { key: `blank-${Date.now()}`, src: -1, rotate: 0 });
    setItems(copy);
  };
  const reverse = () => setItems([...items].reverse());

  const onDrop = (target: string) => {
    if (!drag || drag === target) return;
    const from = items.findIndex((i) => i.key === drag);
    const to = items.findIndex((i) => i.key === target);
    const copy = [...items];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved);
    setItems(copy);
    setDrag(null);
  };

  const apply = async () => {
    setBusy(true);
    try {
      const out = await reorderPages(await ctx.getBytes(), items.map((i) => ({ src: i.src, rotate: i.rotate })));
      await ctx.replace(out, 'Pages réorganisées');
    } catch (e) {
      ctx.notify(`Erreur : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel organize-panel">
      <header className="panel-head">
        <h2>Organiser les pages</h2>
      </header>
      <p className="muted">Glissez pour réordonner. Ctrl/Maj + clic pour sélectionner plusieurs pages.</p>
      <div className="org-actions">
        <button disabled={!targets.length} onClick={() => rotate(-90)} title="Pivoter à gauche">⟲</button>
        <button disabled={!targets.length} onClick={() => rotate(90)} title="Pivoter à droite">⟳</button>
        <button disabled={!targets.length} onClick={duplicate}>Dupliquer</button>
        <button disabled={!targets.length} onClick={remove}>Supprimer</button>
        <button onClick={insertBlank}>+ Page blanche</button>
        <button onClick={reverse}>Inverser</button>
        <button
          disabled={!targets.length || targets.some((t) => t.src < 0)}
          onClick={async () => download(await extractPages(await ctx.getBytes(), targets.map((t) => t.src)), `${baseName(ctx.name)}-selection.pdf`)}
        >
          Extraire
        </button>
        <button onClick={() => setSel(sel.size === items.length ? new Set() : new Set(items.map((i) => i.key)))}>
          {sel.size === items.length ? 'Aucune' : 'Tout'}
        </button>
      </div>
      <div className="org-grid">
        {items.map((it, i) => (
          <div
            key={it.key}
            className={`org-item ${sel.has(it.key) ? 'selected' : ''} ${drag === it.key ? 'dragging' : ''}`}
            draggable
            onDragStart={() => setDrag(it.key)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(it.key)}
            onClick={(e) => toggle(it.key, e)}
          >
            {it.src >= 0 ? <Thumb doc={ctx.pdf} page={it.src} width={90} rotate={it.rotate} /> : <div className="blank">vierge</div>}
            <span>{i + 1}</span>
          </div>
        ))}
      </div>
      <div className="row sticky-bottom">
        <button className="primary" disabled={!dirty || busy} onClick={apply}>
          {busy ? 'Application…' : 'Appliquer les changements'}
        </button>
        <button disabled={!dirty} onClick={() => setItems(init(ctx.numPages))}>
          Annuler
        </button>
      </div>
    </div>
  );
}
