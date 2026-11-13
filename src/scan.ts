/** Scan de documents : détection des bords, redressement (perspective) et filtres, en JavaScript pur. */
export type Pt = [number, number];
export type Quad = [Pt, Pt, Pt, Pt]; // haut-gauche, haut-droite, bas-droite, bas-gauche

/** Détecte la feuille (zone claire principale) et renvoie ses 4 coins en coordonnées image. */
export function detectQuad(img: HTMLCanvasElement): Quad {
  const W = img.width;
  const H = img.height;
  const s = Math.min(1, 360 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * s));
  const h = Math.max(8, Math.round(H * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.filter = 'blur(2px)';
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const lum = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) {
    const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    lum[i] = v;
    hist[lum[i]]++;
  }
  // seuil d'Otsu
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = w * h - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) [best, thr] = [between, t];
  }
  // plus grande composante claire (4-connexité)
  const seen = new Uint8Array(w * h);
  let bestComp: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || lum[i] <= thr) continue;
    const comp: number[] = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const x = k % w;
      const y = (k / w) | 0;
      const nb = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const q of nb) if (q >= 0 && !seen[q] && lum[q] > thr) { seen[q] = 1; stack.push(q); }
    }
    if (comp.length > bestComp.length) bestComp = comp;
  }
  const inset: Quad = [[W * 0.05, H * 0.05], [W * 0.95, H * 0.05], [W * 0.95, H * 0.95], [W * 0.05, H * 0.95]];
  if (bestComp.length < w * h * 0.12 || bestComp.length > w * h * 0.985) return inset;
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (const k of bestComp) {
    const x = k % w;
    const y = (k / w) | 0;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x - y < bl[2]) bl = [x, y, x - y];
  }
  const up = (p: number[]): Pt => [p[0] / s, p[1] / s];
  return [up(tl), up(tr), up(br), up(bl)];
}

/** Homographie : résout la matrice qui envoie les 4 points src sur les 4 points dst. */
function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // élimination de Gauss
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Redresse la zone `q` de l'image en un rectangle. */
export function warp(img: HTMLCanvasElement, q: Quad, maxSide = 2000): HTMLCanvasElement {
  let ow = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let oh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, maxSide / Math.max(ow, oh));
  ow = Math.round(ow * k);
  oh = Math.round(oh * k);
  const H = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], q); // destination → source
  const sctx = img.getContext('2d', { willReadFrequently: true })!;
  const src = sctx.getImageData(0, 0, img.width, img.height);
  const out = document.createElement('canvas');
  out.width = ow;
  out.height = oh;
  const octx = out.getContext('2d')!;
  const dst = octx.createImageData(ow, oh);
  const sw = img.width;
  const sh = img.height;
  const sd = src.data;
  const dd = dst.data;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const den = H[6] * x + H[7] * y + 1;
      const u = (H[0] * x + H[1] * y + H[2]) / den;
      const v = (H[3] * x + H[4] * y + H[5]) / den;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) continue;
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const o = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++)
        dd[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      dd[o + 3] = 255;
    }
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

export type ScanFilter = 'color' | 'gray' | 'bw';

/** Améliore la lisibilité : contraste automatique, gris, ou noir et blanc (seuil adaptatif). */
export function applyFilter(c: HTMLCanvasElement, f: ScanFilter): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = c.height;
  const g = out.getContext('2d')!;
  g.drawImage(c, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const n = c.width * c.height;
  if (f === 'color' || f === 'gray') {
    // étirement des niveaux (1 % - 99 %)
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[(d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0]++;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
    acc = 0;
    for (; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
    const k = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < n * 4; i += 4) {
      if (f === 'gray') {
        const v = Math.min(255, Math.max(0, (((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) - lo) * k));
        d[i] = d[i + 1] = d[i + 2] = v;
      } else for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.min(255, Math.max(0, (d[i + ch] - lo) * k));
    }
  } else {
    // seuil adaptatif (moyenne locale par image intégrale)
    const W = c.width;
    const Hh = c.height;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    const integ = new Float64Array((W + 1) * (Hh + 1));
    for (let y = 1; y <= Hh; y++) {
      let row = 0;
      for (let x = 1; x <= W; x++) {
        row += lum[(y - 1) * W + x - 1];
        integ[y * (W + 1) + x] = integ[(y - 1) * (W + 1) + x] + row;
      }
    }
    const r = Math.max(8, Math.round(Math.min(W, Hh) / 24));
    for (let y = 0; y < Hh; y++)
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r), y0 = Math.max(0, y - r), y1 = Math.min(Hh, y + r);
        const area = (x1 - x0) * (y1 - y0);
        const s = integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
        const v = lum[y * W + x] < (s / area) * 0.88 ? 0 : 255;
        const i = (y * W + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
  }
  g.putImageData(img, 0, 0);
  return out;
}

export function fileToCanvas(file: Blob, maxSide = 2600): Promise<HTMLCanvasElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, maxSide / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * k);
      c.height = Math.round(im.height * k);
      c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c);
    };
    im.onerror = rej;
    im.src = url;
  });
}
