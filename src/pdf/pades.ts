import forge from 'node-forge';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from 'pdf-lib';

/* Signature numérique à certificat (PAdES B-B : SubFilter ETSI.CAdES.detached, CMS SHA-256 avec
   l'attribut signing-certificate-v2). Le certificat vient d'un fichier .p12/.pfx (ou d'un certificat
   personnel créé ici). Toute modification ultérieure du PDF invalide la signature : c'est voulu. */

const SIG_BYTES = 12000; // place réservée pour la signature CMS (octets)

export interface CertInfo {
  name: string;
  email?: string;
  org?: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  selfSigned: boolean;
}

interface Loaded {
  key: forge.pki.PrivateKey;
  cert: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
}

const toBin = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return s;
};
const fromBin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export function loadP12(p12: Uint8Array, password: string): Loaded {
  let pk: forge.pkcs12.Pkcs12Pfx;
  try {
    pk = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(toBin(p12)), false, password);
  } catch {
    throw new Error('Certificat illisible ou mot de passe incorrect.');
  }
  const keyBag = pk.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ?? pk.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const certs = (pk.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert!).filter(Boolean);
  if (!keyBag?.key || !certs.length) throw new Error('Le fichier ne contient pas de clé privée et de certificat.');
  const key = keyBag.key as forge.pki.rsa.PrivateKey;
  // le certificat du signataire est celui dont la clé publique correspond à la clé privée
  const cert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n.equals(key.n)) ?? certs[0];
  return { key, cert, chain: certs.filter((c) => c !== cert) };
}

export function certInfo(p12: Uint8Array, password: string): CertInfo {
  const { cert } = loadP12(p12, password);
  const f = (attrs: forge.pki.CertificateField[], sn: string) => attrs.find((a) => a.shortName === sn)?.value as string | undefined;
  return {
    name: f(cert.subject.attributes, 'CN') ?? 'Inconnu',
    email: f(cert.subject.attributes, 'E') ?? (cert.subject.getField({ name: 'emailAddress' })?.value as string | undefined),
    org: f(cert.subject.attributes, 'O'),
    issuer: f(cert.issuer.attributes, 'CN') ?? f(cert.issuer.attributes, 'O') ?? '—',
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
    selfSigned: cert.isIssuer(cert),
  };
}

/** Crée un certificat personnel auto-signé (RSA 2048, 3 ans) et le renvoie en .p12 protégé. */
export async function createSelfSigned(o: { name: string; email?: string; org?: string; password: string }): Promise<Uint8Array> {
  const keys = await new Promise<forge.pki.rsa.KeyPair>((res, rej) =>
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, kp) => (err ? rej(err) : res(kp))),
  );
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(9))}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3 * 365 * 86400_000);
  // UTF8String (accents) et IA5String (adresse e-mail), comme l'exige la norme X.509
  const U8 = forge.asn1.Type.UTF8;
  const attrs: forge.pki.CertificateField[] = [{ shortName: 'CN', value: o.name, valueTagClass: U8 } as unknown as forge.pki.CertificateField];
  if (o.org) attrs.push({ shortName: 'O', value: o.org, valueTagClass: U8 } as unknown as forge.pki.CertificateField);
  if (o.email) attrs.push({ name: 'emailAddress', value: o.email, valueTagClass: forge.asn1.Type.IA5STRING } as unknown as forge.pki.CertificateField);
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], o.password, { algorithm: '3des', friendlyName: o.name });
  return fromBin(forge.asn1.toDer(p12).getBytes());
}

export interface SignOpts {
  reason?: string;
  location?: string;
  contact?: string;
  /** signature visible : page et zone (pt, origine en haut à gauche) ; absent = signature invisible */
  visible?: { page: number; rect: { x: number; y: number; w: number; h: number } };
}

/** Signe le PDF (PAdES B-B). Le PDF renvoyé ne doit plus être modifié, sous peine d'invalider la signature. */
export async function signPdf(bytes: Uint8Array, p12: Uint8Array, password: string, o: SignOpts = {}): Promise<Uint8Array> {
  const { key, cert, chain } = loadP12(p12, password);
  const now = new Date();
  if (cert.validity.notAfter < now) throw new Error('Ce certificat a expiré.');
  const signer = (cert.subject.getField('CN')?.value as string) ?? 'Signataire';

  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const ctx = pdf.context;
  const pages = pdf.getPages();
  const pageIdx = o.visible ? Math.min(o.visible.page, pages.length - 1) : 0;
  const page = pages[pageIdx];
  let rect = [0, 0, 0, 0];
  if (o.visible) {
    // apparence : cadre + texte, dessinés dans la page (avant la signature)
    const { height } = page.getSize();
    const r = o.visible.rect;
    const x = r.x;
    const y = height - r.y - r.h;
    rect = [x, y, x + r.w, y + r.h];
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    page.drawRectangle({ x, y, width: r.w, height: r.h, borderColor: rgb(0.24, 0.32, 0.84), borderWidth: 1, color: rgb(0.96, 0.97, 1), opacity: 1 });
    const fs = Math.max(6, Math.min(10, r.h / 5.2));
    const clean = (s: string) => [...s].filter((ch) => { try { font.encodeText(ch); return true; } catch { return false; } }).join('');
    const lines = [
      [clean(`Signé numériquement par ${signer}`), bold],
      [clean(`Date : ${now.toLocaleString('fr-FR')}`), font],
      ...(o.reason ? [[clean(`Motif : ${o.reason}`), font]] : []),
      ...(o.location ? [[clean(`Lieu : ${o.location}`), font]] : []),
    ] as [string, typeof font][];
    lines.forEach(([t, f], i) => page.drawText(t, { x: x + 6, y: y + r.h - 6 - fs * (i + 1) * 1.25, size: fs, font: f, color: rgb(0.1, 0.12, 0.3), maxWidth: r.w - 12 }));
  }

  // dictionnaire de signature avec emplacements réservés
  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of('**********'));
  byteRange.push(PDFName.of('**********'));
  byteRange.push(PDFName.of('**********'));
  const sigDict = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(SIG_BYTES * 2)),
    M: PDFString.fromDate(now),
    Name: PDFString.of(signer),
    ...(o.reason ? { Reason: PDFString.of(o.reason) } : {}),
    ...(o.location ? { Location: PDFString.of(o.location) } : {}),
    ...(o.contact ? { ContactInfo: PDFString.of(o.contact) } : {}),
  });
  const sigRef = ctx.register(sigDict);
  const form = pdf.getForm();
  let n = 1;
  while (form.getFieldMaybe(`Signature${n}`)) n++;
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: rect,
    V: sigRef,
    T: PDFString.of(`Signature${n}`),
    F: 132, // imprimable + verrouillé
    P: page.ref,
  });
  const widgetRef = ctx.register(widget);
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(widgetRef);
  else page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
  const acro = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict) ?? (() => {
    const d = ctx.obj({ Fields: [] });
    pdf.catalog.set(PDFName.of('AcroForm'), d);
    return d;
  })();
  const fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray) ?? (() => {
    const a = ctx.obj([]);
    acro.set(PDFName.of('Fields'), a);
    return a;
  })();
  fields.push(widgetRef);
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  const raw = await pdf.save({ useObjectStreams: false });
  // repérage des emplacements réservés
  const txt = new TextDecoder('latin1').decode(raw);
  const brPh = '/ByteRange [ 0 /********** /********** /********** ]';
  let brPos = txt.lastIndexOf(brPh);
  let brLen = brPh.length;
  if (brPos < 0) {
    const m = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/.exec(txt);
    if (!m) throw new Error('Emplacement de signature introuvable.');
    brPos = m.index;
    brLen = m[0].length;
  }
  const contentsTag = `<${'0'.repeat(SIG_BYTES * 2)}>`;
  const start = txt.indexOf(contentsTag, brPos - 200000 > 0 ? brPos - 200000 : 0);
  if (start < 0) throw new Error('Emplacement de signature introuvable.');
  const end = start + contentsTag.length;
  const ranges = [0, start, end, raw.length - end];
  const brText = `/ByteRange [${ranges.join(' ')}]`;
  if (brText.length > brLen) throw new Error('Document trop volumineux pour la signature.');
  const out = raw.slice();
  const brBytes = new TextEncoder().encode(brText.padEnd(brLen, ' '));
  out.set(brBytes, brPos);

  // signature CMS détachée sur les deux plages
  const signed = new Uint8Array(start + (out.length - end));
  signed.set(out.subarray(0, start), 0);
  signed.set(out.subarray(end), start);
  const der = buildCms(toBin(signed), key as forge.pki.rsa.PrivateKey, cert, chain);
  const hex = forge.util.bytesToHex(der);
  if (hex.length > SIG_BYTES * 2) throw new Error('Signature trop grande (chaîne de certificats trop longue).');
  out.set(new TextEncoder().encode(hex.padEnd(SIG_BYTES * 2, '0')), start + 1);
  return out;
}

// ------------------------------------------------------------------ certificat mémorisé (facultatif)
import { del, get, set } from 'idb-keyval';
export const saveCert = (p12: Uint8Array, label: string) => set('nova:cert', { p12, label });
export const loadCert = () => get<{ p12: Uint8Array; label: string }>('nova:cert');
export const forgetCert = () => del('nova:cert');

/** CMS SignedData détaché (RFC 5652) pour PAdES : contentType, messageDigest, signing-certificate-v2 ; RSA + SHA-256. */
function buildCms(data: string, key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate, chain: forge.pki.Certificate[]): string {
  const { asn1, pki } = forge;
  const U = asn1.Class.UNIVERSAL;
  const T = asn1.Type;
  const oid = (o: string) => asn1.create(U, T.OID, false, asn1.oidToDer(o).getBytes());
  const seq = (v: forge.asn1.Asn1[]) => asn1.create(U, T.SEQUENCE, true, v);
  const set = (v: forge.asn1.Asn1[]) => asn1.create(U, T.SET, true, v);
  const octets = (b: string) => asn1.create(U, T.OCTETSTRING, false, b);
  const int = (n: number) => asn1.create(U, T.INTEGER, false, asn1.integerToDer(n).getBytes());
  const sha256Alg = seq([oid(pki.oids.sha256), asn1.create(U, T.NULL, false, '')]);
  const certAsn1 = pki.certificateToAsn1(cert);
  const certDer = asn1.toDer(certAsn1).getBytes();
  const digest = forge.md.sha256.create().update(data).digest().getBytes();
  const certHash = forge.md.sha256.create().update(certDer).digest().getBytes();
  const attr = (type: string, value: forge.asn1.Asn1) => seq([oid(type), set([value])]);
  const attrs = [
    attr(pki.oids.contentType, oid(pki.oids.data)),
    attr(pki.oids.messageDigest, octets(digest)),
    // signing-certificate-v2 : SEQUENCE { SEQUENCE OF ESSCertIDv2 { certHash } } (SHA-256 par défaut)
    attr('1.2.840.113549.1.9.16.2.47', seq([seq([seq([octets(certHash)])])])),
  ];
  // SET OF en DER : éléments triés par leur encodage
  const sorted = attrs.map((a) => ({ a, d: asn1.toDer(a).getBytes() })).sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0)).map((x) => x.a);
  const signedAttrsDer = asn1.toDer(set(sorted)).getBytes();
  const md = forge.md.sha256.create();
  md.update(signedAttrsDer);
  const signature = key.sign(md);
  // dans SignerInfo, les attributs signés sont en [0] IMPLICIT
  const signedAttrsTagged = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, sorted);
  // émetteur et numéro de série repris tels quels du certificat (même encodage, sinon le signataire n'est pas retrouvé)
  const tbs = (certAsn1.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[];
  const off = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  const issuerAndSerial = seq([tbs[off + 2], tbs[off]]);
  const signerInfo = seq([int(1), issuerAndSerial, sha256Alg, signedAttrsTagged, seq([oid(pki.oids.rsaEncryption), asn1.create(U, T.NULL, false, '')]), octets(signature)]);
  const signedData = seq([
    int(1),
    set([sha256Alg]),
    seq([oid(pki.oids.data)]),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [certAsn1, ...chain.map((c) => pki.certificateToAsn1(c))]),
    set([signerInfo]),
  ]);
  const contentInfo = seq([oid(pki.oids.signedData), asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData])]);
  return asn1.toDer(contentInfo).getBytes();
}
