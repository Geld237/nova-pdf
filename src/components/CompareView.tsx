import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';

/* Comparaison visuelle de deux versions : pages côte à côte, mots supprimés en rouge à gauche,
   mots ajoutés en vert à droite, et (option) différences de pixels (images, mise en page). */

interface Word {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function pageWords(pdf: PDFDocumentProxy, i: number): Promise<{ words: Word[]; w: number; h: number }> {
  if (i >= pdf.numPages) return { words: [], w: 595, h: 842 };
  const page = await pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const words: Word[] = [];
  for (const it of tc.items as { str: string; transform: number[]; width: number; height: number }[]) {
    if (!it.str?.trim()) continue;
    const [x0, y0] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    const fh = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
    const per = it.width / Math.max(1, it.str.length);
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(it.str))) words.push({ t: m[0], x: x0 + m.index * per, y: y0 - fh, w: m[0].length * per, h: fh * 1.15 });
  }
  return { words, w: vp.width, h: vp.height };
}

/** LCS sur les mots (normalisés). Renvoie les indices supprimés (a) et ajoutés (b). */
function wordDiff(a: Word[], b: Word[]) {
  const norm = (w: Word) => w.t.toLowerCase().replace(/[’']/g, "'");
  const A = a.map(norm);
  const B = b.map(norm);
  // préfixe / suffixe communs pour réduire le travail
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const a2 = A.slice(s, A.length - e);
  const b2 = B.slice(s, B.length - e);
  const del = new Set<number>();
  const add = new Set<number>();
  if (a2.length * b2.length > 4_000_000) {
    // trop gros : tout ce qui est au milieu est considéré comme modifié
    a2.forEach((_, i) => del.add(s + i));
    b2.forEach((_, i) => add.add(s + i));
    return { del, add };
  }
  const n = a2.length;
  const m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a2[i] === b2[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) del.add(s + i++);
    else add.add(s + j++);
  }
  while (i < n) del.add(s + i++);
  while (j < m) add.add(s + j++);
  return { del, add };
}

interface PageDiff {
  i: number;
  a: { words: Word[]; w: number; h: number };
  b: { words: Word[]; w: number; h: number };
  del: Set<number>;
  add: Set<number>;
}

export function CompareView({ a, b, nameA, nameB, onClose }: { a: PDFDocumentProxy; b: PDFDocumentProxy; nameA: string; nameB: string; onClose: () => void }) {
  const [pages, setPages] = useState<PageDiff[]>([]);
  const [pixels, setPixels] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  const n = Math.max(a.numPages, b.numPages);

  useEffect(() => {
    let dead = false;
    (async () => {
      const out: PageDiff[] = [];
      for (let i = 0; i < n && !dead; i++) {
        const [pa, pb] = await Promise.all([pageWords(a, i), pageWords(b, i)]);
        const { del, add } = wordDiff(pa.words, pb.words);
        out.push({ i, a: pa, b: pb, del, add });
        if (i % 5 === 4 || i === n - 1) setPages([...out]);
      }
    })();
    return () => {
      dead = true;
    };
  }, [a, b, n]);

  const totals = useMemo(() => pages.reduce((t, p) => ({ del: t.del + p.del.size, add: t.add + p.add.size }), { del: 0, add: 0 }), [pages]);
  const changed = pages.filter((p) => p.del.size || p.add.size || p.i >= a.numPages || p.i >= b.numPages);
  const shown = onlyChanged ? changed : pages;

  const jump = (dir: 1 | -1) => {
    if (!changed.length) return;
    const k = (cursor + dir + changed.length) % changed.length;
    setCursor(k);
    body.current?.querySelector(`[data-cmp="${changed[k].i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="overlay compare-view">
      <header className="overlay-bar">
        <b>Comparer deux versions</b>
        <span className="cmp-legend del">− {totals.del} mot(s) supprimé(s)</span>
        <span className="cmp-legend add">+ {totals.add} mot(s) ajouté(s)</span>
        <small className="muted">{changed.length} page(s) modifiée(s){pages.length < n ? ` · analyse ${pages.length}/${n}…` : ''}</small>
        <span style={{ flex: 1 }} />
        <button onClick={() => jump(-1)} disabled={!changed.length} title="Différence précédente">↑</button>
        <button onClick={() => jump(1)} disabled={!changed.length} title="Différence suivante">↓ Suivante</button>
        <label className="check"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Pages modifiées seulement</label>
        <label className="check"><input type="checkbox" checked={pixels} onChange={(e) => setPixels(e.target.checked)} /> Différences d'image</label>
        <button className="primary" onClick={onClose}>Fermer</button>
      </header>
      <div className="cmp-heads">
        <div>Version ouverte : {nameA}</div>
        <div>Nouvelle version : {nameB}</div>
      </div>
      <div className="tv-body" ref={body}>
        {shown.map((p) => (
          <div className="tv-row" key={p.i} data-cmp={p.i}>
            <CmpPage pdf={a} pd={p} side="a" pixels={pixels} other={b} />
            <CmpPage pdf={b} pd={p} side="b" pixels={pixels} other={a} />
          </div>
        ))}
        {onlyChanged && !changed.length && pages.length === n && <p className="empty">Aucune différence de texte trouvée ✓</p>}
      </div>
    </div>
  );
}

function CmpPage({ pdf, other, pd, side, pixels }: { pdf: PDFDocumentProxy; other: PDFDocumentProxy; pd: PageDiff; side: 'a' | 'b'; pixels: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const info = side === 'a' ? pd.a : pd.b;
  const marks = side === 'a' ? pd.del : pd.add;
  const exists = pd.i < pdf.numPages;
  const W = 520;
  const scale = W / info.w;

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '400px' });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !exists) return;
    let dead = false;
    (async () => {
      const page = await pdf.getPage(pd.i + 1);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: scale * dpr });
      const c = canvas.current!;
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      await page.render({ canvas: c, viewport: vp }).promise;
      if (dead || !pixels || side !== 'b' || pd.i >= other.numPages) return;
      // différence de pixels avec l'autre version, en magenta
      const op = await other.getPage(pd.i + 1);
      const ovp = op.getViewport({ scale: (W / pd.a.w) * dpr });
      const oc = document.createElement('canvas');
      oc.width = c.width;
      oc.height = c.height;
      await op.render({ canvas: oc, viewport: ovp }).promise;
      const ctx = c.getContext('2d')!;
      const A = oc.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const B = img.data;
      for (let k = 0; k < B.length; k += 4) {
        const d = Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]);
        if (d > 90) {
          B[k] = 255;
          B[k + 1] = 0;
          B[k + 2] = 200;
        } else {
          // le reste est estompé pour faire ressortir les changements
          B[k] = 255 - (255 - B[k]) * 0.35;
          B[k + 1] = 255 - (255 - B[k + 1]) * 0.35;
          B[k + 2] = 255 - (255 - B[k + 2]) * 0.35;
        }
      }
      ctx.putImageData(img, 0, 0);
    })().catch(() => {});
    return () => {
      dead = true;
    };
  }, [visible, exists, pdf, other, pd.i, pd.a.w, scale, pixels, side]);

  return (
    <div className={`cmp-page ${side}`} ref={ref}>
      <div className="cmp-sheet" style={{ width: W, height: info.h * scale }}>
        {exists ? <canvas ref={canvas} style={{ width: W, height: info.h * scale }} /> : <div className="cmp-missing">{side === 'a' ? 'Page ajoutée dans la nouvelle version' : 'Page supprimée'}</div>}
        {!pixels &&
          [...marks].map((k) => {
            const w = info.words[k];
            return w && <i key={k} style={{ left: w.x * scale, top: w.y * scale, width: w.w * scale, height: w.h * scale }} title={side === 'a' ? `Supprimé : ${w.t}` : `Ajouté : ${w.t}`} />;
          })}
      </div>
      <small className="muted">
        Page {pd.i + 1}
        {marks.size ? ` · ${marks.size} mot(s) ${side === 'a' ? 'supprimé(s)' : 'ajouté(s)'}` : ''}
      </small>
    </div>
  );
}
