import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

/* En-têtes et pieds de page (gauche / centre / droite) avec variables, et numérotation Bates. */

export interface HeaderFooterOpts {
  header: [string, string, string]; // gauche, centre, droite
  footer: [string, string, string];
  size: number;
  color: string;
  margin: number; // pt depuis le bord
  font: 'sans' | 'serif' | 'mono';
  pages: 'all' | 'odd' | 'even' | number[]; // indices 0-based
  skipFirst: boolean;
  startNumber: number;
  bates: { prefix: string; suffix: string; start: number; digits: number };
  fileName: string;
  /** numéro Bates du premier document (traitement par lots : continuité d'un fichier à l'autre) */
  batesOffset?: number;
}

export const DEFAULT_HF: HeaderFooterOpts = {
  header: ['', '', ''],
  footer: ['', 'Page {page} sur {total}', ''],
  size: 10,
  color: '#333333',
  margin: 24,
  font: 'sans',
  pages: 'all',
  skipFirst: false,
  startNumber: 1,
  bates: { prefix: 'NOVA', suffix: '', start: 1, digits: 6 },
  fileName: '',
};

const FONTS = { sans: StandardFonts.Helvetica, serif: StandardFonts.TimesRoman, mono: StandardFonts.Courier };

export const HF_TOKENS = [
  ['{page}', 'numéro de page'],
  ['{total}', 'nombre de pages'],
  ['{date}', 'date du jour'],
  ['{heure}', 'heure'],
  ['{fichier}', 'nom du fichier'],
  ['{bates}', 'numéro Bates'],
] as const;

const hex = (h: string) => {
  const m = h.replace('#', '');
  return rgb(parseInt(m.slice(0, 2), 16) / 255, parseInt(m.slice(2, 4), 16) / 255, parseInt(m.slice(4, 6), 16) / 255);
};

/** Ajoute en-têtes/pieds. Renvoie aussi le prochain numéro Bates (pour enchaîner les fichiers). */
export async function addHeaderFooter(bytes: Uint8Array, o: HeaderFooterOpts): Promise<{ bytes: Uint8Array; nextBates: number }> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(FONTS[o.font]);
  const pages = pdf.getPages();
  const total = pages.length;
  const now = new Date();
  let bates = o.batesOffset ?? o.bates.start;
  const clean = (s: string) => [...s].filter((ch) => { try { font.encodeText(ch); return true; } catch { return false; } }).join('');
  pages.forEach((page, i) => {
    const want = o.pages === 'all' || (o.pages === 'odd' && i % 2 === 0) || (o.pages === 'even' && i % 2 === 1) || (Array.isArray(o.pages) && o.pages.includes(i));
    if (!want || (o.skipFirst && i === 0)) return;
    const batesNo = `${o.bates.prefix}${String(bates).padStart(o.bates.digits, '0')}${o.bates.suffix}`;
    const fill = (t: string) =>
      clean(
        t
          .replace(/\{page\}/g, String(i + o.startNumber))
          .replace(/\{total\}/g, String(total + o.startNumber - 1))
          .replace(/\{date\}/g, now.toLocaleDateString('fr-FR'))
          .replace(/\{heure\}/g, now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))
          .replace(/\{fichier\}/g, o.fileName)
          .replace(/\{bates\}/g, batesNo),
      );
    const usesBates = [...o.header, ...o.footer].some((t) => t.includes('{bates}'));
    // tenir compte de la rotation de la page : on écrit dans le sens de lecture
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const { width: W, height: H } = page.getSize();
    const vw = rot % 180 ? H : W;
    const vh = rot % 180 ? W : H;
    const put = (text: string, align: 0 | 1 | 2, top: boolean) => {
      if (!text) return;
      const w = font.widthOfTextAtSize(text, o.size);
      const vx = align === 0 ? o.margin : align === 1 ? (vw - w) / 2 : vw - o.margin - w;
      const vy = top ? vh - o.margin - o.size * 0.8 : o.margin;
      // coordonnées « vues » → coordonnées de la page
      const [x, y] = rot === 90 ? [W - vy, vx] : rot === 180 ? [W - vx, H - vy] : rot === 270 ? [vy, H - vx] : [vx, vy];
      page.drawText(text, { x, y, size: o.size, font, color: hex(o.color), rotate: degrees(rot) });
    };
    o.header.forEach((t, k) => put(fill(t), k as 0 | 1 | 2, true));
    o.footer.forEach((t, k) => put(fill(t), k as 0 | 1 | 2, false));
    if (usesBates) bates++;
  });
  return { bytes: await pdf.save(), nextBates: bates };
}
