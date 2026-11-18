import { isSvgUrl, stampSvg, svgSignatureWithCaption, svgToDataUrl } from './vector';
/** Tampons prêts à l'emploi, dessinés en image (PNG) pour être placés sur la page. */
export const STAMP_PRESETS: { label: string; color: string }[] = [
  { label: 'APPROUVÉ', color: '#2e7d32' },
  { label: 'REJETÉ', color: '#c62828' },
  { label: 'CONFIDENTIEL', color: '#c62828' },
  { label: 'BROUILLON', color: '#546e7a' },
  { label: 'PAYÉ', color: '#2e7d32' },
  { label: 'REÇU', color: '#1565c0' },
  { label: 'VU', color: '#1565c0' },
  { label: 'URGENT', color: '#e65100' },
  { label: 'COPIE', color: '#546e7a' },
  { label: 'FINAL', color: '#3d52d5' },
];

export type StampDate = 'none' | 'date' | 'datetime';

const stampWhen = (mode: StampDate, d = new Date()) =>
  mode === 'none' ? '' : mode === 'date' ? d.toLocaleDateString('fr-FR') : `${d.toLocaleDateString('fr-FR')} · ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;

/** Dessine un tampon. `withDate` : true/false (ancien) ou mode de date ; `author` ajouté sous la date. */
export function makeStamp(label: string, color: string, withDate: boolean | StampDate = true, author = ''): string {
  const mode: StampDate = withDate === true ? 'date' : withDate === false ? 'none' : withDate;
  const line2 = [stampWhen(mode), author.trim()].filter(Boolean).join(' — ');
  // version vectorielle (nette à tous les zooms et dans le PDF) dès que la police est chargée
  const svg = stampSvg(label, color, line2);
  if (svg) return svgToDataUrl(svg);
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = 'bold 54px Helvetica, Arial, sans-serif';
  g.font = '600 24px Helvetica, Arial, sans-serif';
  const w2 = line2 ? g.measureText(line2).width : 0;
  g.font = font;
  const w = Math.max(g.measureText(label).width, w2, line2 ? 260 : 0) + 60;
  const h = line2 ? 130 : 96;
  c.width = w;
  c.height = h;
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 6;
  const r = 14;
  g.beginPath();
  g.roundRect(5, 5, w - 10, h - 10, r);
  g.stroke();
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(14, 14, w - 28, h - 28, r - 6);
  g.stroke();
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, w / 2, line2 ? 56 : h / 2 + 2);
  if (line2) {
    g.font = '600 24px Helvetica, Arial, sans-serif';
    g.fillText(line2, w / 2, 100);
  }
  return c.toDataURL('image/png');
}

/** Ajoute « Signé le … à … (par …) » sous une image de signature. */
export function signatureWithDate(src: string, who = '', mode: StampDate = 'datetime'): Promise<string> {
  if (isSvgUrl(src)) {
    const d = new Date();
    const when = mode === 'date' ? `le ${d.toLocaleDateString('fr-FR')}` : `le ${d.toLocaleDateString('fr-FR')} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    return svgSignatureWithCaption(src, `Signé ${who.trim() ? `par ${who.trim()} ` : ''}${when}`).catch(() => src);
  }
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const d = new Date();
      const when = mode === 'date' ? `le ${d.toLocaleDateString('fr-FR')}` : `le ${d.toLocaleDateString('fr-FR')} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
      const text = `Signé ${who.trim() ? `par ${who.trim()} ` : ''}${when}`;
      const scale = Math.max(1, 600 / img.width);
      const W = Math.round(img.width * scale);
      const H = Math.round(img.height * scale);
      const fs = Math.max(22, Math.round(W / 22));
      const c = document.createElement('canvas');
      const g = c.getContext('2d')!;
      g.font = `500 ${fs}px Helvetica, Arial, sans-serif`;
      c.width = Math.max(W, Math.ceil(g.measureText(text).width) + 8);
      c.height = H + fs + 16;
      g.drawImage(img, 0, 0, W, H);
      g.strokeStyle = '#8e8e93';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, H + 4);
      g.lineTo(c.width, H + 4);
      g.stroke();
      g.font = `500 ${fs}px Helvetica, Arial, sans-serif`;
      g.fillStyle = '#3a3a3c';
      g.textBaseline = 'top';
      g.fillText(text, 2, H + 10);
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => res(src);
    img.src = src;
  });
}
