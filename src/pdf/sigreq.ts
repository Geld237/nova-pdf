import { PDFDocument, PDFTextField, StandardFonts, rgb } from 'pdf-lib';
import { sanitize } from './writer';

/**
 * Demandes de signature sans serveur : le PDF contient des champs « nova_sig:<signataire>:<id> ».
 * Le signataire ouvre le PDF dans Nova PDF, signe, et renvoie le fichier.
 */
export const SIG_PREFIX = 'nova_sig:';

export interface SigRequest {
  field: string;
  signer: string;
  page: number;
  rect: { x: number; y: number; width: number; height: number };
}

export async function listSigRequests(bytes: Uint8Array): Promise<{ requests: SigRequest[]; from: string; message: string }> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages();
  const requests: SigRequest[] = [];
  for (const f of pdf.getForm().getFields()) {
    const name = f.getName();
    if (!name.startsWith(SIG_PREFIX)) continue;
    const signer = name.slice(SIG_PREFIX.length).split(':')[0] || 'Signataire';
    for (const w of f.acroField.getWidgets()) {
      const pref = w.P();
      const page = Math.max(0, pages.findIndex((p) => pref && p.ref === pref));
      requests.push({ field: name, signer, page, rect: w.getRectangle() });
    }
  }
  const subject = pdf.getSubject() ?? '';
  const m = subject.match(/^Demande de signature de (.+?) — (.*)$/s);
  return { requests, from: m?.[1] ?? '', message: m?.[2] ?? '' };
}

export async function markSigRequest(bytes: Uint8Array, from: string, message: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  pdf.setSubject(`Demande de signature de ${from || 'un expéditeur'} — ${message}`);
  pdf.setKeywords([...(pdf.getKeywords()?.split(/[,;]\s*/) ?? []), 'nova-signature-request'].filter(Boolean));
  return pdf.save();
}

/** Appose la signature dans les champs demandés (tous, ou ceux d'un signataire). */
export async function signRequests(bytes: Uint8Array, signature: string, signerName: string, onlySigner?: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const img = await pdf.embedPng(await fetch(signature).then((r) => r.arrayBuffer()));
  const form = pdf.getForm();
  const pages = pdf.getPages();
  const date = new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  for (const f of form.getFields()) {
    const name = f.getName();
    if (!name.startsWith(SIG_PREFIX)) continue;
    const signer = name.slice(SIG_PREFIX.length).split(':')[0];
    if (onlySigner && signer !== onlySigner) continue;
    for (const w of f.acroField.getWidgets()) {
      const pref = w.P();
      const page = pages.find((p) => pref && p.ref === pref) ?? pages[0];
      const r = w.getRectangle();
      const s = Math.min((r.width - 4) / img.width, (r.height - 12) / img.height);
      page.drawImage(img, { x: r.x + (r.width - img.width * s) / 2, y: r.y + 10, width: img.width * s, height: img.height * s });
      page.drawText(sanitize(font, `Signé par ${signerName} le ${date}`), { x: r.x + 2, y: r.y + 2, size: 6, font, color: rgb(0.3, 0.3, 0.3) });
    }
    form.removeField(f as PDFTextField);
  }
  const subj = pdf.getSubject() ?? '';
  pdf.setSubject(subj.replace(/^Demande de signature/, 'Signé'));
  return pdf.save();
}
