/* Signatures, tampons et logos en VECTORIEL (SVG) : nets à tous les zooms, à l'impression
   et dans le PDF enregistré (tracés PDF natifs, pas d'image).
   - tracé à la main : perfect-freehand (épaisseur variable selon la pression / la vitesse, lissage) ;
   - signature écrite : contours réels des lettres d'une police manuscrite (fontkit) ;
   - signature ou logo importé en image : vectorisation (seuillage + tracé de contours, imagetracerjs). */

import { getStroke } from 'perfect-freehand';
import greatVibesUrl from '@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff2?url';
import dancingUrl from '@fontsource/dancing-script/files/dancing-script-latin-700-normal.woff2?url';
import interBoldUrl from '@fontsource/inter/files/inter-latin-700-normal.woff2?url';
import interUrl from '@fontsource/inter/files/inter-latin-500-normal.woff2?url';

export type InkPoint = [number, number, number]; // x, y, pression (0–1)

export const isSvgUrl = (u?: string | null) => !!u && u.startsWith('data:image/svg+xml');

// ---------------------------------------------------------------- utilitaires SVG
const enc = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
/** SVG → data URL. On ajoute width/height (= viewBox) : sans eux, une image SVG n'a pas de taille naturelle. */
export function svgToDataUrl(svg: string) {
  const m = svg.match(/<svg[^>]*viewBox="([^"]+)"/);
  if (m && !/<svg[^>]*\swidth=/.test(svg)) {
    const [, , w, h] = m[1].split(/[\s,]+/).map(Number);
    svg = svg.replace('<svg', `<svg width="${w}" height="${h}"`);
  }
  return `data:image/svg+xml;base64,${enc(svg)}`;
}
export function dataUrlToSvg(url: string): string {
  const comma = url.indexOf(',');
  const meta = url.slice(0, comma);
  const body = url.slice(comma + 1);
  if (meta.includes(';base64')) {
    const bin = atob(body);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
  return decodeURIComponent(body);
}

export interface SvgShape {
  d: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  opacity: number;
}
export interface ParsedSvg {
  vb: [number, number, number, number];
  shapes: SvgShape[];
}

/** Lecture d'un SVG produit par Nova (chemins seulement). */
export function parseSvg(url: string): ParsedSvg {
  const doc = new DOMParser().parseFromString(dataUrlToSvg(url), 'image/svg+xml');
  const root = doc.documentElement;
  const vb = (root.getAttribute('viewBox') ?? `0 0 ${root.getAttribute('width') ?? 100} ${root.getAttribute('height') ?? 100}`)
    .trim()
    .split(/[\s,]+/)
    .map(Number) as [number, number, number, number];
  const shapes: SvgShape[] = [];
  root.querySelectorAll('path').forEach((p) => {
    const g = p.closest('g');
    const attr = (n: string) => p.getAttribute(n) ?? g?.getAttribute(n) ?? null;
    const fill = attr('fill');
    const stroke = attr('stroke');
    const op = parseFloat(attr('opacity') ?? attr('fill-opacity') ?? '1');
    if ((fill === 'none' || !fill) && (!stroke || stroke === 'none')) return;
    if (op <= 0.01) return;
    shapes.push({
      d: p.getAttribute('d') ?? '',
      fill: fill && fill !== 'none' ? fill : null,
      stroke: stroke && stroke !== 'none' ? stroke : null,
      strokeWidth: parseFloat(attr('stroke-width') ?? '1'),
      opacity: op,
    });
  });
  return { vb, shapes };
}

/** Change la couleur d'un SVG vectoriel (signature, tampon). */
export function recolorSvg(url: string, color: string): string {
  const svg = dataUrlToSvg(url)
    .replace(/fill="(?!none)[^"]*"/g, `fill="${color}"`)
    .replace(/stroke="(?!none)[^"]*"/g, `stroke="${color}"`);
  return svgToDataUrl(svg);
}

/** Proportions (largeur / hauteur) d'un SVG. */
export function svgRatio(url: string) {
  const { vb } = parseSvg(url);
  return vb[2] / Math.max(1, vb[3]);
}

// ---------------------------------------------------------------- tracé à main levée
/** Polygone → chemin lissé (courbes quadratiques), méthode recommandée par perfect-freehand. */
function outlineToPath(pts: number[][]): string {
  if (pts.length < 3) return '';
  const r = (n: number) => Math.round(n * 100) / 100;
  let d = `M${r(pts[0][0])} ${r(pts[0][1])}Q`;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    d += `${r(x0)} ${r(y0)} ${r((x0 + x1) / 2)} ${r((y0 + y1) / 2)} `;
  }
  return `${d}Z`;
}

export interface InkOptions {
  size: number; // épaisseur de base
  thinning: number; // effet plume (pression)
  simulatePressure: boolean;
}

/** Un trait → chemin SVG rempli (épaisseur variable). */
export function strokePath(points: InkPoint[], o: InkOptions, last = true): string {
  const outline = getStroke(points, {
    size: o.size,
    thinning: o.thinning,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: o.simulatePressure,
    last,
    start: { taper: o.size * 2, cap: true },
    end: { taper: o.size * 2.5, cap: true },
  });
  return outlineToPath(outline);
}

/** Traits → SVG recadré au plus juste. */
export function strokesToSvg(strokes: InkPoint[][], o: InkOptions, color: string): string | null {
  const paths = strokes.filter((s) => s.length).map((s) => (s.length === 1 ? strokePath([s[0], [s[0][0] + 0.5, s[0][1] + 0.5, s[0][2]]], o) : strokePath(s, o)));
  const all = strokes.flat();
  if (!all.length) return null;
  const pad = o.size * 2;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) - x0 + pad;
  const h = Math.max(...ys) - y0 + pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}"><g fill="${color}">${paths
    .filter(Boolean)
    .map((d) => `<path d="${d}"/>`)
    .join('')}</g></svg>`;
}

// ---------------------------------------------------------------- texte en contours
type FkFont = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  layout: (t: string) => { glyphs: { path: { scale: (x: number, y: number) => FkPath } }[]; positions: { xAdvance: number; xOffset: number; yOffset: number }[] };
};
type FkPath = { translate: (x: number, y: number) => FkPath; toSVG: () => string };

export const SIG_FONTS = [
  { id: 'great-vibes', label: 'Élégante', url: greatVibesUrl, css: '"Great Vibes"' },
  { id: 'dancing', label: 'Manuscrite', url: dancingUrl, css: '"Dancing Script"' },
] as const;
const FONT_URLS: Record<string, string> = { 'great-vibes': greatVibesUrl, dancing: dancingUrl, 'inter-bold': interBoldUrl, inter: interUrl };

const fontCache = new Map<string, FkFont>();
export async function loadVectorFont(id: string): Promise<FkFont> {
  const hit = fontCache.get(id);
  if (hit) return hit;
  const [{ default: fontkit }, buf] = await Promise.all([import('@pdf-lib/fontkit'), fetch(FONT_URLS[id]).then((r) => r.arrayBuffer())]);
  const f = (fontkit as unknown as { create: (b: Uint8Array) => FkFont }).create(new Uint8Array(buf));
  fontCache.set(id, f);
  return f;
}
/** police déjà chargée ? (pour les tampons, dessinés sans attendre) */
export const vectorFontReady = (id: string) => fontCache.get(id);
/** Précharge les polices des tampons (appelé au démarrage, en tâche de fond). */
export const preloadStampFonts = () => Promise.all([loadVectorFont('inter-bold'), loadVectorFont('inter')]).catch(() => {});

/** Texte → chemin SVG (origine : début de la ligne de base). Renvoie aussi la largeur. */
export function textPath(font: FkFont, text: string, size: number, x = 0, baseline = 0) {
  const s = size / font.unitsPerEm;
  const run = font.layout(text);
  let pen = 0;
  let d = '';
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    d += g.path.scale(s, -s).translate(x + (pen + pos.xOffset) * s, baseline - pos.yOffset * s).toSVG();
    pen += pos.xAdvance;
  });
  return { d, width: pen * s, ascent: font.ascent * s, descent: -font.descent * s };
}

/** Signature écrite → SVG vectoriel (contours des lettres). */
export async function typedSignatureSvg(text: string, fontId: string, color: string): Promise<string> {
  const f = await loadVectorFont(fontId);
  const size = 100;
  const t = textPath(f, text, size, 0, 0);
  const pad = 8;
  const top = -t.ascent - pad;
  const h = t.ascent + t.descent + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${top.toFixed(1)} ${(t.width + pad * 2).toFixed(1)} ${h.toFixed(1)}"><path fill="${color}" d="${t.d}"/></svg>`;
}

// ---------------------------------------------------------------- vectorisation d'une image
/** Seuil d'Otsu sur la luminance. */
function otsu(hist: number[], total: number) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/** Image (photo/scan d'une signature, logo noir et blanc) → SVG vectoriel d'une seule couleur, fond transparent. */
export async function traceToSvg(src: Blob | string, color: string | null = null): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Image illisible'));
    i.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  });
  // résolution de travail : assez fine pour des courbes propres, assez petite pour rester rapide
  const k = Math.min(1, 1400 / Math.max(img.width, img.height), 4, 900 / Math.min(img.width, img.height));
  const up = Math.max(k, Math.min(3, 600 / Math.max(img.width, img.height))); // petites images : on agrandit
  const W = Math.max(1, Math.round(img.width * up));
  const H = Math.max(1, Math.round(img.height * up));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, W, H);
  const id = g.getImageData(0, 0, W, H);
  const px = id.data;
  const hist = new Array(256).fill(0);
  let rs = 0;
  let gs = 0;
  let bs = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    const l = Math.round((0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * a + 255 * (1 - a));
    hist[l]++;
  }
  const thr = Math.min(otsu(hist, W * H), 200);
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const ink = px[i + 3] > 40 && l < thr;
    if (ink) {
      rs += px[i];
      gs += px[i + 1];
      bs += px[i + 2];
      n++;
    }
    const v = ink ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  if (!n) throw new Error('Aucun tracé trouvé dans cette image.');
  // couleur de l'encre d'origine (bleu stylo, noir…) si aucune couleur n'est imposée
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  const ink = color ?? `#${hex(rs / n)}${hex(gs / n)}${hex(bs / n)}`;
  const mod = (await import('imagetracerjs')) as unknown as { default?: TracerLib } & TracerLib;
  const tracer: TracerLib = mod.default ?? mod;
  const svg = tracer.imagedataToSVG(id, {
    colorsampling: 0,
    numberofcolors: 2,
    pal: [
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
    ],
    ltres: 0.6,
    qtres: 0.6,
    pathomit: Math.round(Math.max(W, H) / 300) + 4,
    rightangleenhance: false,
    linefilter: true,
    strokewidth: 0,
    roundcoords: 1,
    viewbox: true,
    desc: false,
    blurradius: 0,
  });
  // on garde les formes noires (l'encre), recolorées ; le blanc (fond) disparaît
  const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const keep: string[] = [];
  d.querySelectorAll('path').forEach((p) => {
    const f = p.getAttribute('fill') ?? '';
    if (/rgb\(0,0,0\)|#000/.test(f.replace(/\s/g, ''))) keep.push(p.getAttribute('d') ?? '');
  });
  if (!keep.length) throw new Error('Aucun tracé trouvé dans cette image.');
  // recadrage au plus juste
  const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  tmp.setAttribute('style', 'position:absolute;visibility:hidden;width:0;height:0');
  tmp.innerHTML = keep.map((x) => `<path d="${x}"/>`).join('');
  document.body.appendChild(tmp);
  let bb: DOMRect | SVGRect = { x: 0, y: 0, width: W, height: H } as DOMRect;
  try {
    bb = (tmp as SVGGraphicsElement).getBBox();
  } catch {
    /* garde l'image entière */
  }
  tmp.remove();
  const pad = Math.max(W, H) / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(bb.x - pad).toFixed(1)} ${(bb.y - pad).toFixed(1)} ${(bb.width + pad * 2).toFixed(1)} ${(bb.height + pad * 2).toFixed(1)}"><g fill="${ink}">${keep
    .map((x) => `<path d="${x}"/>`)
    .join('')}</g></svg>`;
}
type TracerLib = { imagedataToSVG: (img: ImageData, o: Record<string, unknown>) => string };

// ---------------------------------------------------------------- tampons vectoriels
/** Tampon (cadre arrondi double + texte) en tracés vectoriels. Renvoie null si la police n'est pas encore chargée. */
export function stampSvg(label: string, color: string, line2: string): string | null {
  const fb = vectorFontReady('inter-bold');
  const fr = vectorFontReady('inter');
  if (!fb || !fr) return null;
  const t1 = textPath(fb, label, 46);
  const t2 = line2 ? textPath(fr, line2, 21) : null;
  const w = Math.max(t1.width, t2?.width ?? 0, t2 ? 240 : 0) + 64;
  const h = t2 ? 128 : 94;
  const base1 = t2 ? 64 : h / 2 + 16;
  const p1 = textPath(fb, label, 46, (w - t1.width) / 2, base1);
  const p2 = t2 ? textPath(fr, line2, 21, (w - t2.width) / 2, 99) : null;
  const rr = (x: number, y: number, ww: number, hh: number, r: number) =>
    `M${x + r} ${y}H${x + ww - r}Q${x + ww} ${y} ${x + ww} ${y + r}V${y + hh - r}Q${x + ww} ${y + hh} ${x + ww - r} ${y + hh}H${x + r}Q${x} ${y + hh} ${x} ${y + hh - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h}"><path d="${rr(4, 4, w - 8, h - 8, 14)}" fill="none" stroke="${color}" stroke-width="6"/><path d="${rr(13, 13, w - 26, h - 26, 8)}" fill="none" stroke="${color}" stroke-width="2"/><path fill="${color}" d="${p1.d}${p2 ? p2.d : ''}"/></svg>`;
}

/** Ajoute « Signé par … le … » sous une signature vectorielle. */
export async function svgSignatureWithCaption(url: string, caption: string): Promise<string> {
  const f = await loadVectorFont('inter');
  const { vb } = parseSvg(url);
  const inner = dataUrlToSvg(url).replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const fs = Math.max(12, vb[2] / 20);
  const cap = textPath(f, caption, fs, vb[0], vb[1] + vb[3] + fs * 1.6);
  const w = Math.max(vb[2], cap.width + 4);
  const h = vb[3] + fs * 2.1;
  const lineY = vb[1] + vb[3] + fs * 0.3;
  return svgToDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb[0]} ${vb[1]} ${w.toFixed(1)} ${h.toFixed(1)}">${inner}<path d="M${vb[0]} ${lineY.toFixed(1)}H${(vb[0] + w).toFixed(1)}" fill="none" stroke="#8e8e93" stroke-width="${(fs / 10).toFixed(2)}"/><path fill="#3a3a3c" d="${cap.d}"/></svg>`,
  );
}
