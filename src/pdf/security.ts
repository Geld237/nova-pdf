/**
 * Chiffrement / déchiffrement (AES-256) via @cantoo/pdf-lib, chargé à la demande.
 */
export interface Permissions {
  printing: boolean;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  documentAssembly: boolean;
}

export async function protectPdf(
  bytes: Uint8Array,
  userPassword: string,
  ownerPassword: string,
  perms: Permissions,
): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const pdf = await PDFDocument.load(bytes);
  pdf.encrypt({
    userPassword,
    ownerPassword: ownerPassword || userPassword,
    permissions: {
      printing: perms.printing ? 'highResolution' : undefined,
      modifying: perms.modifying,
      copying: perms.copying,
      annotating: perms.annotating,
      fillingForms: perms.fillingForms,
      contentAccessibility: true,
      documentAssembly: perms.documentAssembly,
    },
  });
  return pdf.save();
}

/** Retire le mot de passe d'un PDF (il faut le connaître). */
export async function unlockPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const pdf = await PDFDocument.load(bytes, { password });
  return pdf.save();
}
