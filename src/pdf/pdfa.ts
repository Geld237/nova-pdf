import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import type { PDFDocumentProxy } from './engine';

/* Export PDF/A-2b (archivage à long terme) :
   - métadonnées XMP déclarant PDF/A-2B, cohérentes avec le dictionnaire Info ;
   - profil de couleur sRGB (OutputIntent), identifiant de fichier, pas de chiffrement ni de JavaScript ;
   - mode « images » : chaque page devient une image (aucune police à intégrer → conformité la plus sûre).
   Le mode « texte conservé » signale les polices non intégrées, qui empêchent la conformité. */

// ---------------------------------------------------------------- profil ICC sRGB (v2, compact)
export function srgbIcc(): Uint8Array {
  const tags: { sig: string; data: Uint8Array }[] = [];
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const s15 = (v: number) => be32(Math.round(v * 65536) | 0);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const pad4 = (a: number[]) => {
    while (a.length % 4) a.push(0);
    return a;
  };
  const xyz = (x: number, y: number, z: number) => new Uint8Array([...ascii('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)]);
  const text = (s: string) => new Uint8Array(pad4([...ascii('text'), 0, 0, 0, 0, ...ascii(s), 0]));
  const desc = (s: string) =>
    new Uint8Array(pad4([...ascii('desc'), 0, 0, 0, 0, ...be32(s.length + 1), ...ascii(s), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...new Array(67).fill(0)]));
  // courbe sRGB échantillonnée (256 points)
  const curvePts: number[] = [];
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const q = Math.round(lin * 65535);
    curvePts.push((q >> 8) & 255, q & 255);
  }
  const curve = new Uint8Array(pad4([...ascii('curv'), 0, 0, 0, 0, ...be32(256), ...curvePts]));
  tags.push({ sig: 'desc', data: desc('sRGB IEC61966-2.1') });
  tags.push({ sig: 'cprt', data: text('Domaine public') });
  tags.push({ sig: 'wtpt', data: xyz(0.9642, 1.0, 0.8249) });
  tags.push({ sig: 'rXYZ', data: xyz(0.4361, 0.2225, 0.0139) });
  tags.push({ sig: 'gXYZ', data: xyz(0.3851, 0.7169, 0.0971) });
  tags.push({ sig: 'bXYZ', data: xyz(0.1431, 0.0606, 0.7141) });
  tags.push({ sig: 'rTRC', data: curve });
  tags.push({ sig: 'gTRC', data: curve });
  tags.push({ sig: 'bTRC', data: curve });
  const headerLen = 128;
  const tableLen = 4 + tags.length * 12;
  let offset = headerLen + tableLen;
  const entries: number[] = [];
  const blobs: Uint8Array[] = [];
  const seen = new Map<Uint8Array, number>();
  for (const t of tags) {
    let off = seen.get(t.data);
    if (off == null) {
      off = offset;
      seen.set(t.data, off);
      blobs.push(t.data);
      offset += t.data.length;
    }
    entries.push(...ascii(t.sig), ...be32(off), ...be32(t.data.length));
  }
  const size = offset;
  const out = new Uint8Array(size);
  const h = [
    ...be32(size), 0, 0, 0, 0, // taille, CMM
    0x02, 0x10, 0, 0, // version 2.1
    ...ascii('mntr'), ...ascii('RGB '), ...ascii('XYZ '),
    0x07, 0xe6, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, // date
    ...ascii('acsp'), 0, 0, 0, 0, // plateforme
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // drapeaux, fabricant, modèle
    0, 0, 0, 0, 0, 0, 0, 0, // attributs
    0, 0, 0, 0, // intention de rendu
    ...s15(0.9642), ...s15(1.0), ...s15(0.8249), // illuminant D50
    0, 0, 0, 0, // créateur
  ];
  out.set(h, 0);
  out.set([...be32(tags.length), ...entries], headerLen);
  let p = headerLen + tableLen;
  for (const b of blobs) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

// ---------------------------------------------------------------- utilitaires
const xmlEsc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
const isoDate = (d: Date) => {
  const z = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${z >= 0 ? '+' : '-'}${pad(z / 60)}:${pad(z % 60)}`;
};

/** Polices utilisées mais non intégrées (empêchent la conformité PDF/A). */
export async function unembeddedFonts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const missing = new Set<string>();
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.lookup(PDFName.of('Type')) !== PDFName.of('Font')) continue;
    const sub = obj.lookup(PDFName.of('Subtype'));
    if (sub === PDFName.of('Type0') || sub === PDFName.of('Type3')) continue;
    const fd = obj.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const has = fd && (fd.has(PDFName.of('FontFile')) || fd.has(PDFName.of('FontFile2')) || fd.has(PDFName.of('FontFile3')));
    if (!has) missing.add(String(obj.lookup(PDFName.of('BaseFont')) ?? '?').replace(/^\//, ''));
  }
  return [...missing];
}

async function finalizePdfA(pdf: PDFDocument, title: string) {
  const now = new Date();
  pdf.setTitle(title || 'Document');
  pdf.setProducer('Nova PDF');
  pdf.setCreator('Nova PDF');
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);
  const ctx = pdf.context;
  const cat = pdf.catalog;
  // pas de JavaScript ni d'actions automatiques
  cat.delete(PDFName.of('OpenAction'));
  cat.delete(PDFName.of('AA'));
  const names = cat.lookupMaybe(PDFName.of('Names'), PDFDict);
  names?.delete(PDFName.of('JavaScript'));
  names?.delete(PDFName.of('EmbeddedFiles')); // PDF/A-2 n'autorise que des pièces jointes PDF/A
  // profil de couleur
  const icc = ctx.flateStream(srgbIcc(), { N: 3 });
  const iccRef = ctx.register(icc);
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  });
  cat.set(PDFName.of('OutputIntents'), ctx.obj([intent]));
  // métadonnées XMP (identiques au dictionnaire Info)
  const d = isoDate(now);
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<pdfaid:part>2</pdfaid:part>
<pdfaid:conformance>B</pdfaid:conformance>
<dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title || 'Document')}</rdf:li></rdf:Alt></dc:title>
<xmp:CreateDate>${d}</xmp:CreateDate>
<xmp:ModifyDate>${d}</xmp:ModifyDate>
<xmp:MetadataDate>${d}</xmp:MetadataDate>
<xmp:CreatorTool>Nova PDF</xmp:CreatorTool>
<pdf:Producer>Nova PDF</pdf:Producer>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const meta = ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
  cat.set(PDFName.of('Metadata'), ctx.register(meta));
  // identifiant de fichier
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  // annotations : imprimables, sans transparence interdite (drapeau Print obligatoire)
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (!a) continue;
      const f = Number(String(a.lookup(PDFName.of('F')) ?? 0)) || 0;
      a.set(PDFName.of('F'), ctx.obj((f | 4) & ~(1 | 2 | 32)));
    }
  }
  return pdf.save({ useObjectStreams: false });
}

/** PDF/A-2b en gardant le texte (sélectionnable). Renvoie aussi les polices non intégrées à signaler. */
export async function toPdfAKeep(bytes: Uint8Array, title: string): Promise<{ bytes: Uint8Array; missingFonts: string[] }> {
  const missingFonts = await unembeddedFonts(bytes);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  // flux XFA / formulaires dynamiques interdits
  const acro = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  acro?.delete(PDFName.of('XFA'));
  acro?.delete(PDFName.of('NeedAppearances'));
  void PDFRawStream;
  void PDFStream;
  void decodePDFRawStream;
  return { bytes: await finalizePdfA(pdf, title), missingFonts };
}

/** PDF/A-2b « images » : chaque page en image JPEG (conformité la plus sûre ; le texte n'est plus sélectionnable). */
export async function toPdfAImages(doc: PDFDocumentProxy, title: string, dpi = 200, onProgress?: (i: number, n: number) => void): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < doc.numPages; i++) {
    onProgress?.(i, doc.numPages);
    const page = await doc.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport: vp }).promise;
    const jpg = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.88));
    const img = await pdf.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    const p = pdf.addPage([vp1.width, vp1.height]);
    p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  return finalizePdfA(pdf, title);
}
