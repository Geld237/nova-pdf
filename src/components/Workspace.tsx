import { moveItem } from './OrganizePanel';
import { clickInput } from '../platform';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ui } from '../dialogs';
import { Icon, type IconName } from '../icons';
import { openPdf, renderPageToCanvas, type PDFDocumentProxy } from '../pdf/engine';
import { baseName, download, extractPages, mergePdfs, reorderPages, splitPdf } from '../pdf/tools';
import { PAGE_SIZES, cropPages, nUp } from '../pdf/advanced';
import { Thumb } from './Thumb';
import { OrganizePanel } from './OrganizePanel';
import type { DocCtx } from './ToolsPanel';

export type WorkspaceKind = 'organize' | 'split' | 'extract' | 'crop' | 'merge' | 'nup';

const TITLES: Record<WorkspaceKind, [string, IconName]> = {
  organize: ['Organiser les pages', 'organize'],
  split: ['Découper le document', 'split'],
  extract: ['Extraire des pages', 'extract'],
  crop: ['Recadrer les pages', 'crop'],
  merge: ['Fusionner des PDF', 'merge'],
  nup: ['Plusieurs pages par feuille', 'grid'],
};

const GROUP_COLORS = ['#007aff', '#ff9500', '#34c759', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00', '#5856d6'];

/** Espace de travail plein écran : les pages sont affichées en grand pour choisir visuellement. */
export function Workspace({ kind, ctx, onClose }: { kind: WorkspaceKind; ctx: DocCtx; onClose: () => void }) {
  const [title, icon] = TITLES[kind];
  return (
    <div className="workspace">
      <header className="ws-head">
        <button className="icon" onClick={onClose} title="Revenir au document"><Icon name="back" /></button>
        <Icon name={icon} size={20} />
        <h2>{title}</h2>
        <span className="muted">{ctx.name} · {ctx.numPages} page(s)</span>
        <span className="spacer" />
        <button onClick={onClose}>Fermer</button>
      </header>
      {kind === 'organize' && <div className="ws-body"><OrganizePanel ctx={ctx} big /></div>}
      {kind === 'split' && <SplitWS ctx={ctx} />}
      {kind === 'extract' && <ExtractWS ctx={ctx} onDone={onClose} />}
      {kind === 'crop' && <CropWS ctx={ctx} onDone={onClose} />}
      {kind === 'merge' && <MergeWS ctx={ctx} onDone={onClose} />}
      {kind === 'nup' && <NupWS ctx={ctx} />}
    </div>
  );
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/* ----- Découper ------------------------------------------------------------- */

function SplitWS({ ctx }: { ctx: DocCtx }) {
  const n = ctx.numPages;
  const [cuts, setCuts] = useState<Set<number>>(new Set()); // coupure après la page i
  const [every, setEvery] = useState(2);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const g: number[][] = [[]];
    for (let i = 0; i < n; i++) {
      g[g.length - 1].push(i);
      if (cuts.has(i) && i < n - 1) g.push([]);
    }
    return g;
  }, [cuts, n]);
  const groupOf = (i: number) => groups.findIndex((g) => g.includes(i));
  const toggle = (i: number) => {
    const c = new Set(cuts);
    if (c.has(i)) c.delete(i);
    else c.add(i);
    setCuts(c);
  };
  const run = async (open: boolean) => {
    setBusy(true);
    try {
      const parts = await splitPdf(await ctx.getBytes(), groups);
      parts.forEach((b, i) => {
        const name = `${baseName(ctx.name)}-partie${i + 1}.pdf`;
        if (open) ctx.openNew(b, name);
        else download(b, name);
      });
      ctx.notify(`${parts.length} fichier(s) créé(s).`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="ws-bar">
        <span className="muted">Cliquez sur ✂ entre deux pages pour couper à cet endroit.</span>
        <span className="spacer" />
        <label className="inline">Toutes les <input type="number" min={1} max={n} value={every} onChange={(e) => setEvery(Math.max(1, +e.target.value))} /> pages</label>
        <button onClick={() => setCuts(new Set(range(n).filter((i) => (i + 1) % every === 0)))}>Appliquer</button>
        <button onClick={() => setCuts(new Set(range(n)))}>Une page par fichier</button>
        <button onClick={() => setCuts(new Set())}>Effacer</button>
      </div>
      <div className="ws-body">
        <div className="ws-flow">
          {range(n).map((i) => (
            <div key={i} className="split-cell">
              <div className="ws-page" style={{ borderColor: GROUP_COLORS[groupOf(i) % GROUP_COLORS.length] }}>
                <Thumb doc={ctx.pdf} page={i} width={150} />
                <span className="ws-num" style={{ background: GROUP_COLORS[groupOf(i) % GROUP_COLORS.length] }}>
                  {i + 1} · fichier {groupOf(i) + 1}
                </span>
              </div>
              {i < n - 1 && (
                <button className={`cut ${cuts.has(i) ? 'on' : ''}`} onClick={() => toggle(i)} title={cuts.has(i) ? 'Retirer la coupure' : `Couper après la page ${i + 1}`}>
                  <Icon name="split" size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ws-foot">
        <span>{groups.length} fichier(s) : {groups.map((g) => (g.length > 1 ? `${g[0] + 1}–${g[g.length - 1] + 1}` : `${g[0] + 1}`)).join(' · ')}</span>
        <span className="spacer" />
        <button disabled={busy || groups.length < 2} onClick={() => run(true)}>Ouvrir dans des onglets</button>
        <button className="primary" disabled={busy || groups.length < 2} onClick={() => run(false)}>Découper et enregistrer</button>
      </div>
    </>
  );
}

/* ----- Extraire / sélectionner -------------------------------------------- */

function ExtractWS({ ctx, onDone }: { ctx: DocCtx; onDone: () => void }) {
  const n = ctx.numPages;
  const [sel, setSel] = useState<Set<number>>(new Set([ctx.currentPage]));
  const last = useRef<number | null>(null);
  const click = (i: number, e: React.MouseEvent) => {
    const s = new Set(sel);
    if (e.shiftKey && last.current !== null) {
      const [a, b] = [Math.min(last.current, i), Math.max(last.current, i)];
      for (let k = a; k <= b; k++) s.add(k);
    } else if (s.has(i)) s.delete(i);
    else s.add(i);
    last.current = i;
    setSel(s);
  };
  const list = [...sel].sort((a, b) => a - b);
  return (
    <>
      <div className="ws-bar">
        <span className="muted">Cliquez sur les pages à garder (Maj + clic pour une plage).</span>
        <span className="spacer" />
        <button onClick={() => setSel(new Set(range(n)))}>Tout</button>
        <button onClick={() => setSel(new Set())}>Aucune</button>
        <button onClick={() => setSel(new Set(range(n).filter((i) => i % 2 === 0)))}>Impaires</button>
        <button onClick={() => setSel(new Set(range(n).filter((i) => i % 2 === 1)))}>Paires</button>
        <button onClick={() => setSel(new Set(range(n).filter((i) => !sel.has(i))))}>Inverser</button>
      </div>
      <div className="ws-body">
        <div className="ws-grid">
          {range(n).map((i) => (
            <button key={i} className={`ws-page pick ${sel.has(i) ? 'selected' : ''}`} onClick={(e) => click(i, e)}>
              <Thumb doc={ctx.pdf} page={i} width={160} />
              <span className="ws-num">{i + 1}</span>
              {sel.has(i) && <span className="check-badge">✓</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="ws-foot">
        <span>{list.length} page(s) sélectionnée(s)</span>
        <span className="spacer" />
        <button
          className="danger"
          disabled={!list.length || list.length === n}
          onClick={async () => {
            if (!(await ui.confirm(`Supprimer ${list.length} page(s) du document ?`, { ok: 'Supprimer', danger: true }))) return;
            await ctx.replace(await reorderPages(await ctx.getBytes(), range(n).filter((i) => !sel.has(i)).map((i) => ({ src: i, rotate: 0 }))), `${list.length} page(s) supprimée(s)`);
            onDone();
          }}
        >
          Supprimer ces pages
        </button>
        <button disabled={!list.length} onClick={async () => ctx.openNew(await extractPages(await ctx.getBytes(), list), `${baseName(ctx.name)}-extrait.pdf`)}>
          Ouvrir dans un onglet
        </button>
        <button className="primary" disabled={!list.length} onClick={async () => download(await extractPages(await ctx.getBytes(), list), `${baseName(ctx.name)}-extrait.pdf`)}>
          Extraire en PDF
        </button>
      </div>
    </>
  );
}

/* ----- Recadrer ----------------------------------------------------------------- */

type Box = { x: number; y: number; w: number; h: number };

function CropWS({ ctx, onDone }: { ctx: DocCtx; onDone: () => void }) {
  const n = ctx.numPages;
  const [cur, setCur] = useState(ctx.currentPage);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [scope, setScope] = useState<'current' | 'all' | 'checked'>('all');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [img, setImg] = useState<string>('');
  const stage = useRef<HTMLDivElement>(null);
  const center = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: string; sx: number; sy: number; b: Box } | null>(null);
  // la page est dimensionnée pour tenir entièrement dans la zone (téléphone en portrait compris)
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = center.current;
    if (!el || !size) return;
    const compute = () => {
      const cs = getComputedStyle(el);
      const aw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ah = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const k = Math.max(0.05, Math.min(aw / size.w, ah / size.h));
      setFit({ w: Math.floor(size.w * k), h: Math.floor(size.h * k) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);

  useEffect(() => {
    let dead = false;
    (async () => {
      const pg = await ctx.pdf.getPage(cur + 1);
      const vp = pg.getViewport({ scale: 1 });
      const c = await renderPageToCanvas(ctx.pdf, cur, 1.6);
      if (dead) return;
      setImg(c.toDataURL('image/jpeg', 0.85));
      setSize({ w: vp.width, h: vp.height });
      setBox((b) => b ?? { x: vp.width * 0.06, y: vp.height * 0.06, w: vp.width * 0.88, h: vp.height * 0.88 });
    })();
    return () => {
      dead = true;
    };
  }, [cur, ctx.pdf]);

  const auto = async () => {
    const c = await renderPageToCanvas(ctx.pdf, cur, 1);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    if (x1 <= x0) return;
    const pad = 10;
    setBox({ x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: Math.min(c.width, x1 - x0 + pad * 2), h: Math.min(c.height, y1 - y0 + pad * 2) });
  };

  const onDown = (e: React.PointerEvent, mode: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, b: box! };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !size || !stage.current) return;
    const dx = (e.clientX - d.sx) * (size.w / stage.current.clientWidth);
    const dy = (e.clientY - d.sy) * (size.h / stage.current.clientHeight);
    let { x, y, w, h } = d.b;
    if (d.mode === 'move') {
      x = Math.min(Math.max(0, x + dx), size.w - w);
      y = Math.min(Math.max(0, y + dy), size.h - h);
    } else {
      if (d.mode.includes('l')) { x = Math.min(Math.max(0, x + dx), x + w - 20); w = d.b.x + d.b.w - x; }
      if (d.mode.includes('r')) w = Math.min(Math.max(20, w + dx), size.w - x);
      if (d.mode.includes('t')) { y = Math.min(Math.max(0, y + dy), y + h - 20); h = d.b.y + d.b.h - y; }
      if (d.mode.includes('b')) h = Math.min(Math.max(20, h + dy), size.h - y);
    }
    setBox({ x, y, w, h });
  };

  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  const margins = box && size ? { top: mm(box.y), left: mm(box.x), right: mm(size.w - box.x - box.w), bottom: mm(size.h - box.y - box.h) } : null;
  const pct = (v: number, t: number) => `${(v / t) * 100}%`;

  const apply = async () => {
    if (!margins || !box || !size) return;
    const toMm = (pt: number) => (pt / 72) * 25.4;
    const m = { top: toMm(box.y), left: toMm(box.x), right: toMm(size.w - box.x - box.w), bottom: toMm(size.h - box.y - box.h) };
    const pages = scope === 'all' ? 'all' : scope === 'current' ? [cur] : [...checked];
    if (Array.isArray(pages) && !pages.length) return ctx.notify('Cochez au moins une page.');
    await ctx.replace(await cropPages(await ctx.getBytes(), m, pages), 'Pages recadrées');
    onDone();
  };

  return (
    <>
      <div className="ws-bar">
        <span className="muted">Faites glisser les bords du cadre. Ce qui est en dehors sera masqué.</span>
        <span className="spacer" />
        <button onClick={auto}>✨ Ajuster au contenu</button>
        <button onClick={() => size && setBox({ x: 0, y: 0, w: size.w, h: size.h })}>Page entière</button>
      </div>
      <div className="ws-split">
        <div className="ws-strip">
          {range(n).map((i) => (
            <div key={i} className={`strip-item ${i === cur ? 'current' : ''}`}>
              <button onClick={() => setCur(i)}><Thumb doc={ctx.pdf} page={i} width={86} /></button>
              <label className="check"><input type="checkbox" checked={checked.has(i)} onChange={(e) => { const s = new Set(checked); if (e.target.checked) s.add(i); else s.delete(i); setChecked(s); setScope('checked'); }} /> {i + 1}</label>
            </div>
          ))}
        </div>
        <div ref={center} className="crop-center" onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)}>
          {size && box && (
            <div ref={stage} className="crop-stage" style={fit ? { width: fit.w, height: fit.h } : { aspectRatio: `${size.w} / ${size.h}` }}>
              {img && <img src={img} alt={`Page ${cur + 1}`} draggable={false} />}
              <div className="crop-shade" style={{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${pct(box.x, size.w)} ${pct(box.y, size.h)},${pct(box.x, size.w)} ${pct(box.y + box.h, size.h)},${pct(box.x + box.w, size.w)} ${pct(box.y + box.h, size.h)},${pct(box.x + box.w, size.w)} ${pct(box.y, size.h)},${pct(box.x, size.w)} ${pct(box.y, size.h)})` }} />
              <div className="crop-box" style={{ left: pct(box.x, size.w), top: pct(box.y, size.h), width: pct(box.w, size.w), height: pct(box.h, size.h) }} onPointerDown={(e) => onDown(e, 'move')}>
                {['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'].map((h) => (
                  <span key={h} className={`crop-h h-${h}`} onPointerDown={(e) => onDown(e, h)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="ws-foot">
        {margins && <span>Marges retirées : haut {margins.top} mm · bas {margins.bottom} mm · gauche {margins.left} mm · droite {margins.right} mm</span>}
        <span className="spacer" />
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="all">Toutes les pages</option>
          <option value="current">Page {cur + 1} uniquement</option>
          <option value="checked">Pages cochées ({checked.size})</option>
        </select>
        <button className="primary" onClick={apply}>Recadrer</button>
      </div>
    </>
  );
}

/* ----- Fusionner ---------------------------------------------------------------- */

interface MergeItem {
  key: string;
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
}

function MergeWS({ ctx, onDone }: { ctx: DocCtx; onDone: () => void }) {
  const [items, setItems] = useState<MergeItem[]>([]);
  const [drag, setDrag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const bytes = await ctx.getBytes();
      setItems([{ key: 'current', name: ctx.name, bytes, pdf: ctx.pdf }]);
    })();
  }, [ctx]);

  const add = () => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'application/pdf';
    i.multiple = true;
    i.onchange = async () => {
      const added: MergeItem[] = [];
      for (const f of Array.from(i.files ?? [])) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        try {
          added.push({ key: `${f.name}-${Math.random()}`, name: f.name, bytes, pdf: await openPdf(bytes, () => ui.prompt(`Mot de passe de « ${f.name} » :`, '', { password: true })) });
        } catch {
          ctx.notify(`« ${f.name} » ne peut pas être ouvert.`);
        }
      }
      setItems((x) => [...x, ...added]);
    };
    clickInput(i);
  };

  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const from = items.findIndex((x) => x.key === drag);
    const to = items.findIndex((x) => x.key === target);
    const c = [...items];
    const [m] = c.splice(from, 1);
    c.splice(to, 0, m);
    setItems(c);
    setDrag(null);
  };

  const total = items.reduce((s, x) => s + x.pdf.numPages, 0);
  const run = async (replace: boolean) => {
    setBusy(true);
    try {
      const out = await mergePdfs(items.map((x) => x.bytes));
      if (replace) await ctx.replace(out, `${items.length} documents fusionnés`);
      else ctx.openNew(out, `${baseName(ctx.name)}-fusion.pdf`);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ws-bar">
        <span className="muted">Ajoutez des PDF, puis faites-les glisser pour choisir l'ordre.</span>
        <span className="spacer" />
        <button className="primary" onClick={add}>+ Ajouter des PDF</button>
      </div>
      <div className="ws-body">
        <div className="ws-grid merge">
          {items.map((it, k) => (
            <div
              key={it.key}
              className={`ws-page merge-item ${drag === it.key ? 'dragging' : ''}`}
              draggable
              onDragStart={() => setDrag(it.key)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(it.key)}
            >
              <div className="stack">
                <Thumb doc={it.pdf} page={0} width={150} />
              </div>
              <span className="ws-num">{k + 1}</span>
              <b className="merge-name">{it.name}</b>
              <div className="merge-move">
                <button aria-label="Avancer" disabled={k === 0} onClick={() => setItems(moveItem(items, k, -1))}>‹</button>
                <button aria-label="Reculer" disabled={k === items.length - 1} onClick={() => setItems(moveItem(items, k, 1))}>›</button>
              </div>
              <small className="muted">{it.pdf.numPages} page(s)</small>
              {it.key !== 'current' && (
                <button className="icon remove" title="Retirer" onClick={() => setItems(items.filter((x) => x.key !== it.key))}><Icon name="close" size={14} /></button>
              )}
            </div>
          ))}
          <button className="ws-page add-tile" onClick={add}>
            <Icon name="create" size={28} />
            <span>Ajouter</span>
          </button>
        </div>
      </div>
      <div className="ws-foot">
        <span>{items.length} document(s) · {total} page(s) au total</span>
        <span className="spacer" />
        <button disabled={busy || items.length < 2} onClick={() => run(false)}>Ouvrir dans un nouvel onglet</button>
        <button className="primary" disabled={busy || items.length < 2} onClick={() => run(true)}>Fusionner</button>
      </div>
    </>
  );
}

/* ----- Plusieurs pages par feuille ------------------------------------------------ */

function NupWS({ ctx }: { ctx: DocCtx }) {
  const [per, setPer] = useState<2 | 4 | 6 | 9>(4);
  const [size, setSize] = useState('A4');
  const [cols, rows] = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3] }[per];
  let [W, H] = PAGE_SIZES[size];
  if (cols > rows) [W, H] = [H, W];
  const sheets = Math.ceil(ctx.numPages / per);
  const preview = range(Math.min(sheets, 6));
  return (
    <>
      <div className="ws-bar">
        <label className="inline">Pages par feuille
          <select value={per} onChange={(e) => setPer(+e.target.value as typeof per)}>
            {[2, 4, 6, 9].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="inline">Feuille
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.keys(PAGE_SIZES).map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <span className="spacer" />
        <span className="muted">{ctx.numPages} pages → {sheets} feuille(s)</span>
      </div>
      <div className="ws-body">
        <div className="ws-grid sheets">
          {preview.map((s) => (
            <div key={s} className="sheet" style={{ aspectRatio: `${W} / ${H}`, gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
              {range(per).map((k) => {
                const p = s * per + k;
                return <div key={k} className="sheet-cell">{p < ctx.numPages && <Thumb doc={ctx.pdf} page={p} width={W > H ? 110 : 90} />}</div>;
              })}
            </div>
          ))}
          {sheets > preview.length && <div className="muted more">+ {sheets - preview.length} feuille(s)</div>}
        </div>
      </div>
      <div className="ws-foot">
        <span className="spacer" />
        <button className="primary" onClick={async () => ctx.openNew(await nUp(await ctx.getBytes(), per, size), `${baseName(ctx.name)}-${per}par-feuille.pdf`)}>
          Créer le PDF
        </button>
      </div>
    </>
  );
}
