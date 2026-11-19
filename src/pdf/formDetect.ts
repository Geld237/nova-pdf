import type { PDFDocumentProxy } from './engine';
import type { Rect } from '../types';

/* Reconnaissance automatique des champs d'un formulaire « à plat » (PDF ou scan) :
   lignes de saisie (soulignés, pointillés « ____ » / « ..... »), cases à cocher (□, carrés dessinés),
   cadres vides et cellules vides de tableaux. Analyse du rendu de la page (fonctionne aussi sur les scans)
   + du texte (libellés « Nom : » pour nommer les champs). */

export interface DetectedField {
  page: number;
  rect: Rect; // coordonnées de page (pt, origine en haut à gauche)
  type: 'text' | 'checkbox' | 'multiline';
  name: string;
}

interface TItem {
  str: string;
  x: number;
  y: number; // haut
  w: number;
  h: number;
}

const S = 2; // échelle d'analyse (px par pt)

export async function detectFields(pdf: PDFDocumentProxy, pages?: number[]): Promise<DetectedField[]> {
  const out: DetectedField[] = [];
  for (const pi of pages ?? Array.from({ length: pdf.numPages }, (_, i) => i)) out.push(...(await detectPage(pdf, pi)));
  // noms uniques
  const seen = new Map<string, number>();
  for (const f of out) {
    const n = seen.get(f.name) ?? 0;
    seen.set(f.name, n + 1);
    if (n) f.name = `${f.name} ${n + 1}`;
  }
  return out;
}

async function detectPage(pdf: PDFDocumentProxy, pi: number): Promise<DetectedField[]> {
  const page = await pdf.getPage(pi + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items: TItem[] = [];
  for (const t of tc.items as { str: string; transform: number[]; width: number; height: number }[]) {
    if (!t.str) continue;
    const [x, y] = vp1.convertToViewportPoint(t.transform[4], t.transform[5]);
    const h = Math.hypot(t.transform[2], t.transform[3]) || t.height || 10;
    items.push({ str: t.str, x, y: y - h, w: t.width, h });
  }
  const fields: DetectedField[] = [];
  const W = vp1.width;

  // libellé : texte juste à gauche (même ligne) ou juste au-dessus
  const labelFor = (r: Rect) => {
    const left = items
      .filter((t) => t.str.trim() && !/^[_.\s…]+$/.test(t.str) && Math.abs(t.y + t.h / 2 - (r.y + r.h / 2)) < Math.max(8, r.h) && t.x + t.w <= r.x + 4 && r.x - (t.x + t.w) < 160)
      .sort((a, b) => b.x - a.x)[0];
    const above = items
      .filter((t) => t.str.trim() && !/^[_.\s…]+$/.test(t.str) && t.y + t.h <= r.y + 2 && r.y - (t.y + t.h) < 22 && t.x < r.x + r.w && t.x + t.w > r.x - 4)
      .sort((a, b) => b.y - a.y)[0];
    const raw = (left ?? above)?.str ?? '';
    const clean = raw.replace(/[_.…]{2,}.*$/, '').replace(/[:*]+\s*$/, '').replace(/^\s*[□☐❏]\s*/, '').trim();
    return clean.slice(0, 40) || `Champ ${pi + 1}`;
  };

  // 1) texte : « Nom : ________ », « ...... », cases □
  for (const t of items) {
    const m = /[_]{4,}|[.…]{5,}/.exec(t.str);
    if (m) {
      const per = t.w / Math.max(1, t.str.length);
      const x = t.x + m.index * per;
      const w = m[0].length * per;
      const rect = { x, y: t.y - 2, w, h: t.h + 4 };
      const before = t.str.slice(0, m.index).replace(/[:*]\s*$/, '').trim();
      fields.push({ page: pi, rect, type: 'text', name: before.slice(0, 40) || labelFor(rect) });
    }
    for (const g of t.str.matchAll(/[□☐❏❑]/g)) {
      const per = t.w / Math.max(1, t.str.length);
      const x = t.x + (g.index ?? 0) * per;
      const sz = Math.max(8, t.h * 0.9);
      const after = t.str.slice((g.index ?? 0) + 1).trim().split(/\s{2,}|[□☐❏❑]/)[0];
      fields.push({ page: pi, rect: { x, y: t.y + (t.h - sz) / 2, w: sz, h: sz }, type: 'checkbox', name: (after || labelFor({ x, y: t.y, w: sz, h: sz })).slice(0, 40) });
    }
  }

  // 2) rendu : traits horizontaux (lignes de saisie) et cadres (cases, zones, cellules vides)
  const vp = page.getViewport({ scale: S });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvas: c, viewport: vp }).promise;
  // le texte ne doit pas compter comme trait : on l'efface du rendu
  g.fillStyle = '#fff';
  for (const t of items) if (!/^[_.\s…]+$/.test(t.str)) g.fillRect(t.x * S, (t.y + t.h * 0.1) * S, t.w * S, t.h * 0.85 * S);
  const { data } = g.getImageData(0, 0, c.width, c.height);
  const CW = c.width;
  const CH = c.height;
  const dark = new Uint8Array(CW * CH);
  for (let i = 0; i < CW * CH; i++) dark[i] = data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] < 3 * 150 ? 1 : 0;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < CW && y < CH ? dark[y * CW + x] : 0);

  // segments horizontaux
  interface Seg { x1: number; x2: number; y: number }
  const segs: Seg[] = [];
  const minLen = 8 * S; // assez court pour les cases à cocher (≈ 10 pt)
  for (let y = 0; y < CH; y++) {
    let x = 0;
    while (x < CW) {
      if (!dark[y * CW + x]) {
        x++;
        continue;
      }
      let e = x;
      // tolérance aux petites coupures (pointillés)
      let gap = 0;
      while (e + 1 < CW && (dark[y * CW + e + 1] || gap < 3 * S)) {
        if (dark[y * CW + e + 1]) gap = 0;
        else gap++;
        e++;
      }
      e -= gap;
      if (e - x >= minLen) segs.push({ x1: x, x2: e, y });
      x = e + 1;
    }
  }
  // fusion des lignes épaisses (plusieurs rangées de pixels)
  const lines: Seg[] = [];
  for (const s of segs) {
    const l = lines.find((L) => s.y - L.y <= 2 * S && Math.abs(L.x1 - s.x1) < 3 * S && Math.abs(L.x2 - s.x2) < 3 * S);
    if (l) l.y = s.y;
    else lines.push({ ...s });
  }
  // segments verticaux près d'une abscisse (bords de cadre)
  const vertical = (x: number, y1: number, y2: number) => {
    let n = 0;
    for (let y = y1; y <= y2; y++) if (at(x, y) || at(x - 1, y) || at(x + 1, y) || at(x - 2, y) || at(x + 2, y)) n++;
    return n / Math.max(1, y2 - y1 + 1) > 0.85;
  };
  const used = new Set<Seg>();
  // cadres : deux traits horizontaux de même étendue reliés par des bords verticaux
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) {
    const top = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const bot = sorted[j];
      const h = bot.y - top.y;
      if (h < 6 * S) continue;
      if (h > 120 * S) break;
      if (Math.abs(bot.x1 - top.x1) > 3 * S || Math.abs(bot.x2 - top.x2) > 3 * S) continue;
      if (!vertical(top.x1, top.y, bot.y) || !vertical(top.x2, top.y, bot.y)) continue;
      // découpe en cellules par les verticales internes (tableaux)
      const xs = [top.x1];
      for (let x = top.x1 + 6 * S; x < top.x2 - 6 * S; x++) if (vertical(x, top.y + 2, bot.y - 2) && x - xs[xs.length - 1] > 6 * S) xs.push(x);
      xs.push(top.x2);
      for (let k = 0; k + 1 < xs.length; k++) {
        const r = { x: xs[k] / S + 2, y: top.y / S + 2, w: (xs[k + 1] - xs[k]) / S - 4, h: h / S - 4 };
        if (r.w < 6 || r.h < 6) continue;
        // déjà du texte dedans → ce n'est pas une case vide
        const filled = items.some((t) => t.str.trim() && t.x < r.x + r.w && t.x + t.w > r.x && t.y < r.y + r.h && t.y + t.h > r.y);
        if (filled) continue;
        const square = Math.abs(r.w - r.h) < 4 && r.w <= 26;
        if (square) fields.push({ page: pi, rect: r, type: 'checkbox', name: labelForCheckbox(items, r) || labelFor(r) });
        else if (r.w >= 30) fields.push({ page: pi, rect: r, type: r.h > 40 ? 'multiline' : 'text', name: labelFor(r) });
      }
      used.add(top);
      used.add(bot);
      break;
    }
  }
  // lignes de saisie : trait seul, sans texte juste au-dessus
  for (const l of lines) {
    if (used.has(l)) continue;
    const x = l.x1 / S;
    const w = (l.x2 - l.x1) / S;
    if (w < 40 || w > W * 0.92) continue; // trop court, ou filet de séparation pleine largeur
    const y = l.y / S;
    const r = { x, y: y - 16, w, h: 15 };
    const textAbove = items.some((t) => t.str.trim() && !/^[_.\s…]+$/.test(t.str) && t.x < r.x + r.w - 4 && t.x + t.w > r.x + 4 && t.y + t.h > r.y + 3 && t.y < y);
    if (textAbove) continue; // texte souligné, ou déjà rempli
    fields.push({ page: pi, rect: r, type: 'text', name: labelFor(r) });
  }

  // doublons (même zone repérée deux fois)
  const res: DetectedField[] = [];
  for (const f of fields) {
    const dup = res.find((o) => overlap(o.rect, f.rect) > 0.5);
    if (!dup) res.push(f);
  }
  return res;
}

function labelForCheckbox(items: TItem[], r: Rect) {
  const right = items
    .filter((t) => t.str.trim() && Math.abs(t.y + t.h / 2 - (r.y + r.h / 2)) < Math.max(8, r.h) && t.x >= r.x + r.w - 2 && t.x - (r.x + r.w) < 40)
    .sort((a, b) => a.x - b.x)[0];
  return right?.str.trim().slice(0, 40) ?? '';
}

function overlap(a: Rect, b: Rect) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (x * y) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}
