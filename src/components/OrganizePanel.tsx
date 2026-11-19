import { useEffect, useRef, useState } from 'react';
import { openPdf, type PDFDocumentProxy } from '../pdf/engine';
import { assemblePages, baseName, download, imagesToPdf } from '../pdf/tools';
import { clickInput } from '../platform';
import { ui } from '../dialogs';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import { parseRange } from './ImageExport';
import { Thumb } from './Thumb';
import { useSortable } from './useSortable';
import type { DocCtx } from './ToolsPanel';

/* Organiser les pages : réordonner, pivoter, dupliquer, supprimer, extraire — et INSÉRER des pages
   (autre PDF, images, scan, page blanche) n'importe où, avec un vrai menu au clic droit. */

interface Item {
  key: string;
  doc: number; // 0 = document ouvert, 1… = PDF inséré
  src: number; // index de page, -1 = page blanche
  rotate: number;
}
interface Source {
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
}

let seq = 0;
const k = () => `i${Date.now().toString(36)}${seq++}`;
const init = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ key: `p${i}`, doc: 0, src: i, rotate: 0 }));

export function OrganizePanel({ ctx, big }: { ctx: DocCtx; big?: boolean }) {
  const [items, setItems] = useState<Item[]>(() => init(ctx.numPages));
  const [sources, setSources] = useState<Source[]>([]); // index 0 ↔ doc 1
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null); // position d'insertion survolée (fichiers ou pages)
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const history = useRef<Item[][]>([]);

  useEffect(() => {
    setItems(init(ctx.numPages));
    setSources([]);
    setSel(new Set());
    history.current = [];
  }, [ctx.pdf, ctx.numPages]);

  /** toute modification passe par ici (pour pouvoir annuler) */
  const change = (next: Item[]) => {
    history.current.push(items);
    if (history.current.length > 50) history.current.shift();
    setItems(next);
  };
  const undo = () => {
    const prev = history.current.pop();
    if (prev) setItems(prev);
  };

  const dirty = sources.length > 0 || items.length !== ctx.numPages || items.some((it, i) => it.doc !== 0 || it.src !== i || it.rotate);
  const selected = items.filter((i) => sel.has(i.key));
  const pdfOf = (it: Item) => (it.doc === 0 ? ctx.pdf : sources[it.doc - 1]?.pdf);

  // ---------- sélection
  const click = (key: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => i.key === anchor);
      const b = items.findIndex((i) => i.key === key);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSel(new Set(items.slice(lo, hi + 1).map((i) => i.key)));
      return;
    }
    const next = new Set(e.ctrlKey || e.metaKey ? sel : []);
    if (next.has(key) && (e.ctrlKey || e.metaKey)) next.delete(key);
    else next.add(key);
    setSel(next);
    setAnchor(key);
  };

  // ---------- opérations
  const rotate = (keys: Item[], d: number) => {
    const s = new Set(keys.map((x) => x.key));
    change(items.map((it) => (s.has(it.key) ? { ...it, rotate: (it.rotate + d + 360) % 360 } : it)));
  };
  const remove = (keys: Item[]) => {
    const s = new Set(keys.map((x) => x.key));
    if (s.size === items.length) return ctx.notify('Un document doit garder au moins une page.');
    change(items.filter((it) => !s.has(it.key)));
    setSel(new Set());
  };
  const duplicate = (keys: Item[]) => {
    const s = new Set(keys.map((x) => x.key));
    change(items.flatMap((it) => (s.has(it.key) ? [it, { ...it, key: k() }] : [it])));
  };
  const moveTo = (keys: Item[], where: 'start' | 'end') => {
    const s = new Set(keys.map((x) => x.key));
    const moving = items.filter((i) => s.has(i.key));
    const rest = items.filter((i) => !s.has(i.key));
    change(where === 'start' ? [...moving, ...rest] : [...rest, ...moving]);
  };
  const insertItems = (at: number, add: Item[]) => {
    const copy = [...items];
    copy.splice(at, 0, ...add);
    change(copy);
    setSel(new Set(add.map((a) => a.key)));
    setAnchor(add[0]?.key ?? null);
  };

  /** Ajoute un PDF comme source et renvoie les éléments de ses pages choisies. */
  const addSource = async (bytes: Uint8Array, name: string, ask: boolean): Promise<Item[]> => {
    const pdf = await openPdf(bytes, () => ui.prompt(`Mot de passe de « ${name} » :`, '', { password: true }));
    let pages = Array.from({ length: pdf.numPages }, (_, i) => i);
    if (ask && pdf.numPages > 1) {
      const r = await ui.prompt(`« ${name} » a ${pdf.numPages} pages. Lesquelles insérer ? (ex. 1-3, 5 — vide = toutes)`, '');
      if (r === null) return [];
      if (r.trim()) pages = parseRange(r, pdf.numPages);
      if (!pages.length) {
        ctx.notify('Aucune page valide dans cette plage.');
        return [];
      }
    }
    const docIndex = sources.length + 1 + pendingSources.current.length;
    pendingSources.current.push({ name, bytes, pdf });
    return pages.map((p) => ({ key: k(), doc: docIndex, src: p, rotate: 0 }));
  };
  // sources ajoutées dans le même tour (plusieurs fichiers d'un coup)
  const pendingSources = useRef<Source[]>([]);
  const flushSources = () => {
    if (!pendingSources.current.length) return;
    const add = pendingSources.current;
    pendingSources.current = [];
    setSources((s) => [...s, ...add]);
  };

  const insertFiles = async (at: number, files: File[], ask = true) => {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!pdfs.length && !imgs.length) return ctx.notify('Glissez des PDF ou des images.');
    setBusy('Insertion…');
    try {
      const add: Item[] = [];
      for (const f of pdfs) add.push(...(await addSource(new Uint8Array(await f.arrayBuffer()), f.name, ask && pdfs.length === 1)));
      if (imgs.length) add.push(...(await addSource(await imagesToPdf(imgs), imgs.length > 1 ? `${imgs.length} images` : imgs[0].name, false)));
      flushSources();
      if (add.length) {
        insertItems(at, add);
        ctx.notify(`${add.length} page(s) insérée(s) — pensez à « Appliquer ».`);
      }
    } catch (e) {
      ctx.notify(`Insertion impossible : ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const pick = (accept: string, multiple: boolean, at: number) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = multiple;
    i.onchange = () => i.files?.length && insertFiles(at, [...i.files]);
    clickInput(i);
  };
  const insertPdf = (at: number) => pick('application/pdf,.pdf', true, at);
  const insertImages = (at: number) => pick('image/*', true, at);
  const insertScan = (at: number) =>
    ctx.startScan(async (bytes) => {
      const add = await addSource(bytes, 'Scan', false);
      flushSources();
      insertItems(at, add);
      ctx.notify(`${add.length} page(s) scannée(s) insérée(s).`);
    });
  const insertBlank = (at: number) => insertItems(at, [{ key: k(), doc: 0, src: -1, rotate: 0 }]);
  const replaceWith = async (it: Item) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'application/pdf,.pdf,image/*';
    i.onchange = async () => {
      const f = i.files?.[0];
      if (!f) return;
      const isImg = f.type.startsWith('image/');
      const bytes = isImg ? await imagesToPdf([f]) : new Uint8Array(await f.arrayBuffer());
      const pdf = await openPdf(bytes, () => ui.prompt(`Mot de passe de « ${f.name} » :`, '', { password: true }));
      let p = 0;
      if (pdf.numPages > 1) {
        const r = await ui.prompt(`Quelle page de « ${f.name} » (1 à ${pdf.numPages}) ?`, '1');
        if (r === null) return;
        p = Math.max(0, Math.min(pdf.numPages - 1, (parseInt(r, 10) || 1) - 1));
      }
      const doc = sources.length + 1;
      setSources((s) => [...s, { name: f.name, bytes, pdf }]);
      change(items.map((x) => (x.key === it.key ? { key: k(), doc, src: p, rotate: 0 } : x)));
    };
    clickInput(i);
  };

  const buildBytes = async (list: Item[]) =>
    assemblePages(
      await ctx.getBytes(),
      sources.map((s) => s.bytes),
      list.map((i) => ({ doc: i.doc, src: i.src, rotate: i.rotate })),
    );
  const extract = async (list: Item[]) => {
    if (!list.length) return;
    setBusy('Extraction…');
    try {
      download(await buildBytes(list), `${baseName(ctx.name)}-pages.pdf`);
    } finally {
      setBusy(null);
    }
  };
  const extractToTab = async (list: Item[]) => ctx.openNew(await buildBytes(list), `${baseName(ctx.name)}-pages.pdf`);

  const apply = async () => {
    setBusy('Application…');
    try {
      // les annotations suivent leurs pages et restent modifiables
      await ctx.applyLayout(
        items.map((i) => ({ doc: i.doc, src: i.src, rotate: i.rotate })),
        'Pages réorganisées',
        sources.map((s) => s.bytes),
      );
    } catch (e) {
      ctx.notify(`Erreur : ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  // ---------- menus
  const insertEntries = (at: number, where: string): MenuItem[] => [
    { header: `Insérer ${where}` },
    { label: 'Pages d’un autre PDF…', icon: 'merge', action: () => insertPdf(at) },
    { label: 'Image(s) / photo(s)…', icon: 'image', action: () => insertImages(at) },
    { label: 'Scanner un document…', icon: 'scan', action: () => insertScan(at) },
    { label: 'Page blanche', icon: 'create', action: () => insertBlank(at) },
  ];
  const tileMenu = (e: React.MouseEvent, it: Item) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sel.has(it.key)) {
      setSel(new Set([it.key]));
      setAnchor(it.key);
    }
    const list = sel.has(it.key) ? selected : [it];
    const idx = items.findIndex((x) => x.key === it.key);
    const n = list.length;
    const lbl = n > 1 ? `${n} pages` : `page ${idx + 1}`;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { header: n > 1 ? `${n} pages sélectionnées` : `Page ${idx + 1}${it.doc ? ` (de « ${sources[it.doc - 1]?.name} »)` : it.src < 0 ? ' (blanche)' : ''}` },
        ...insertEntries(idx + 1, `après la ${lbl}`),
        { label: `Insérer avant la ${lbl}…`, icon: 'create', action: () => setTimeout(() => setMenu({ x: e.clientX, y: e.clientY, items: insertEntries(idx, `avant la ${lbl}`) }), 0) },
        'sep',
        { label: 'Pivoter à gauche', icon: 'rotateCcw', action: () => rotate(list, -90) },
        { label: 'Pivoter à droite', icon: 'rotateCw', action: () => rotate(list, 90) },
        { label: 'Dupliquer', icon: 'copy', action: () => duplicate(list) },
        ...(n === 1 ? [{ label: 'Remplacer par une autre page…', icon: 'swap' as const, action: () => replaceWith(it) }] : []),
        { label: 'Déplacer au début', icon: 'back', action: () => moveTo(list, 'start') },
        { label: 'Déplacer à la fin', icon: 'next', action: () => moveTo(list, 'end') },
        'sep',
        { label: n > 1 ? 'Extraire ces pages (PDF)…' : 'Extraire cette page (PDF)…', icon: 'extract', action: () => extract(list) },
        { label: 'Ouvrir dans un nouvel onglet', icon: 'open', action: () => extractToTab(list) },
        ...(it.doc === 0 && it.src >= 0 && n === 1 ? [{ label: 'Aller à cette page', icon: 'pages' as const, action: () => ctx.goTo?.(it.src) }] : []),
        'sep',
        { label: n > 1 ? `Supprimer ces ${n} pages` : 'Supprimer la page', icon: 'trash', danger: true, action: () => remove(list) },
      ],
    });
  };
  const gridMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...insertEntries(items.length, 'à la fin'),
        ...insertEntries(0, 'au début').slice(0, 1),
        { label: 'Page blanche au début', icon: 'create', action: () => insertBlank(0) },
        'sep',
        { label: sel.size === items.length ? 'Tout désélectionner' : 'Tout sélectionner', icon: 'select', action: () => setSel(sel.size === items.length ? new Set() : new Set(items.map((i) => i.key))) },
        { label: 'Inverser l’ordre', icon: 'swap', action: () => change([...items].reverse()) },
        { label: 'Annuler la dernière modification', icon: 'undo', disabled: !history.current.length, action: undo },
        { label: 'Tout rétablir comme avant', icon: 'close', disabled: !dirty, action: () => { change(init(ctx.numPages)); setSources([]); } },
      ],
    });
  };
  const insertMenuAt = (e: React.MouseEvent, at: number) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items: insertEntries(at, at === items.length ? 'à la fin' : `à la position ${at + 1}`) });
  };

  // raccourcis clavier
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSel(new Set(items.map((i) => i.key)));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
        e.preventDefault();
        remove(selected);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  // glisser-déposer : pages (réordonner) ou fichiers du disque (insérer à cet endroit)
  const posFromEvent = (e: React.DragEvent, i: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? i : i + 1;
  };
  const onTileDragOver = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    setDropAt(posFromEvent(e, i));
  };
  const onTileDrop = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const at = posFromEvent(e, i);
    setDropAt(null);
    if (e.dataTransfer.files?.length) insertFiles(at, [...e.dataTransfer.files]);
  };
  // classer les pages : glisser au pointeur (souris, doigt avec appui long), plusieurs pages à la fois
  const grid = useRef<HTMLDivElement>(null);
  const { st: sort, handle } = useSortable({
    axis: 'grid',
    container: grid,
    pick: (i) => {
      const it = items[i];
      return sel.has(it.key) ? items.map((x, k) => (sel.has(x.key) ? k : -1)).filter((k) => k >= 0) : [i];
    },
    onDrop: (from, to) => {
      const s = new Set(from.map((f) => items[f].key));
      const moving = items.filter((x) => s.has(x.key));
      const before = items.slice(0, to).filter((x) => !s.has(x.key));
      const after = items.slice(to).filter((x) => !s.has(x.key));
      change([...before, ...moving, ...after]);
    },
  });
  void drag;
  void setDrag;

  const W = big ? 150 : 90;
  return (
    <div className={`panel organize-panel ${big ? 'big' : ''}`}>
      {!big && (
        <header className="panel-head">
          <h2>Organiser les pages</h2>
        </header>
      )}
      <p className="muted">
        Attrapez une page et glissez-la à sa place (au doigt : appui long). Ctrl/Maj + clic pour en déplacer plusieurs. Clic droit : insérer, pivoter, remplacer, extraire… Déposez aussi des PDF ou des images depuis l’ordinateur.
      </p>
      <div className="org-actions">
        <button className="primary-soft" onClick={(e) => insertMenuAt(e, selected.length ? items.findIndex((x) => x.key === selected[selected.length - 1].key) + 1 : items.length)}>
          ＋ Insérer ▾
        </button>
        <button disabled={!selected.length} onClick={() => rotate(selected, -90)} title="Pivoter à gauche">⟲</button>
        <button disabled={!selected.length} onClick={() => rotate(selected, 90)} title="Pivoter à droite">⟳</button>
        <button disabled={!selected.length} onClick={() => duplicate(selected)}>Dupliquer</button>
        <button disabled={!selected.length} onClick={() => remove(selected)}>Supprimer</button>
        <button disabled={!selected.length} onClick={() => extract(selected)}>Extraire</button>
        <button onClick={() => change([...items].reverse())}>Inverser</button>
        <button disabled={!history.current.length} onClick={undo} title="Annuler (Ctrl+Z)">↶</button>
        <button onClick={() => setSel(sel.size === items.length ? new Set() : new Set(items.map((i) => i.key)))}>{sel.size === items.length ? 'Aucune' : 'Tout'}</button>
        {busy && <small className="muted">⏳ {busy}</small>}
      </div>
      <div
        ref={grid}
        className="org-grid"
        onContextMenu={gridMenu}
        onClick={(e) => e.target === e.currentTarget && setSel(new Set())}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.target === e.currentTarget) setDropAt(items.length);
        }}
        onDragLeave={(e) => e.target === e.currentTarget && setDropAt(null)}
        onDrop={(e) => {
          e.preventDefault();
          setDropAt(null);
          if (e.dataTransfer.files?.length) insertFiles(items.length, [...e.dataTransfer.files]);
        }}
      >
        {items.map((it, i) => (
          <div key={it.key} className="org-cell">
            {i === 0 && (
              <button className={`org-slot ${dropAt === 0 ? 'on' : ''}`} title="Insérer ici" onClick={(e) => insertMenuAt(e, 0)}>
                +
              </button>
            )}
            {sort.dragging && sort.insertAt === i && <div className="org-insert" />}
            <div
              {...handle(i)}
              className={`org-item ${sel.has(it.key) ? 'selected' : ''} ${sort.dragging?.includes(i) ? 'dragging' : ''} ${it.doc ? 'inserted' : ''}`}
              onDragOver={(e) => onTileDragOver(e, i)}
              onDrop={(e) => onTileDrop(e, i)}
              onClick={(e) => click(it.key, e)}
              onDoubleClick={() => it.doc === 0 && it.src >= 0 && ctx.goTo?.(it.src)}
              onContextMenu={(e) => tileMenu(e, it)}
              title={it.doc ? `Inséré depuis « ${sources[it.doc - 1]?.name} »` : undefined}
            >
              {it.src >= 0 && pdfOf(it) ? <Thumb doc={pdfOf(it)!} page={it.src} width={W} rotate={it.rotate} /> : <div className="blank" style={{ width: W, height: W * 1.414 }}>page blanche</div>}
              <span>
                {i + 1}
                {it.doc ? <em className="org-badge">inséré</em> : null}
              </span>
              <div className="org-move" onClick={(e) => e.stopPropagation()}>
                <button aria-label="Avancer" disabled={i === 0} onClick={() => change(moveItem(items, i, -1))}>‹</button>
                <button aria-label="Reculer" disabled={i === items.length - 1} onClick={() => change(moveItem(items, i, 1))}>›</button>
              </div>
            </div>
            <button className={`org-slot ${dropAt === i + 1 ? 'on' : ''}`} title="Insérer ici" onClick={(e) => insertMenuAt(e, i + 1)}>
              +
            </button>
            {sort.dragging && sort.insertAt === items.length && i === items.length - 1 && <div className="org-insert end" />}
          </div>
        ))}
      </div>
      {sort.dragging && sort.pos && (
        <div className="drag-badge" style={{ left: sort.pos.x + 14, top: sort.pos.y + 14 }}>
          {sort.dragging.length > 1 ? `${sort.dragging.length} pages` : `Page ${sort.dragging[0] + 1}`} → position {(sort.insertAt ?? 0) + 1}
        </div>
      )}
      <div className="row sticky-bottom">
        <button className="primary" disabled={!dirty || !!busy} onClick={apply}>
          {busy === 'Application…' ? 'Application…' : dirty ? '✓ Appliquer au document' : 'Aucun changement'}
        </button>
        <button
          disabled={!dirty}
          onClick={() => {
            change(init(ctx.numPages));
            setSources([]);
          }}
        >
          Tout annuler
        </button>
        {dirty && <small className="muted">{items.length} page(s) au total</small>}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Déplace un élément d'un cran (boutons ‹ › sur écran tactile, où le glisser-déposer ne marche pas). */
export function moveItem<T>(l: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= l.length) return l;
  const c = [...l];
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}
