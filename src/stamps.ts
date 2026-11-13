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

export function makeStamp(label: string, color: string, withDate = true): string {
  const date = new Date().toLocaleDateString('fr-FR');
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = 'bold 54px Helvetica, Arial, sans-serif';
  g.font = font;
  const w = Math.max(g.measureText(label).width, withDate ? 260 : 0) + 60;
  const h = withDate ? 130 : 96;
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
  g.fillText(label, w / 2, withDate ? 56 : h / 2 + 2);
  if (withDate) {
    g.font = '600 24px Helvetica, Arial, sans-serif';
    g.fillText(date, w / 2, 100);
  }
  return c.toDataURL('image/png');
}
