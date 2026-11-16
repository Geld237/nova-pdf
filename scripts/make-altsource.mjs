// Source SideStore / AltStore de Nova PDF : SideStore propose chaque nouvelle version
// avec un bouton « Mettre à jour ».
// Utilisation (CI) : node scripts/make-altsource.mjs <version> <fichier.ipa> <sortie.json>
// Adresse à ajouter dans SideStore :
//   https://github.com/Geld237/nova-pdf/releases/latest/download/nova-pdf-source.json
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const [version, ipa, out = 'nova-pdf-source.json'] = process.argv.slice(2);
if (!version || !ipa || !existsSync(ipa)) {
  console.error('usage : make-altsource.mjs <version> <fichier.ipa> [sortie.json]');
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY || 'Geld237/nova-pdf';
const [owner, name] = repo.split('/');
const site = `https://${owner.toLowerCase()}.github.io/${name}/`;
const [maj, min, pat] = version.split('.').map(Number);
const tint = '#4F7CFF';
const desc = 'Nova PDF : lire, annoter, signer et organiser vos PDF, hors ligne.';

const source = {
  name: 'Nova PDF',
  identifier: `io.github.${owner.toLowerCase()}.novapdf.source`,
  subtitle: 'Lecteur et éditeur PDF',
  description: 'Source officielle de Nova PDF pour SideStore et AltStore.',
  iconURL: `${site}icon-512.png`,
  website: `https://github.com/${repo}`,
  tintColor: tint,
  apps: [{
    name: 'Nova PDF',
    bundleIdentifier: 'io.github.geld237.novapdf',
    developerName: owner,
    subtitle: 'Lecteur et éditeur PDF',
    localizedDescription: desc,
    iconURL: `${site}icon-512.png`,
    tintColor: tint,
    category: 'utilities',
    screenshots: [],
    versions: [{
      version,
      buildVersion: String(maj * 10000 + min * 100 + pat),
      date: new Date().toISOString().slice(0, 10),
      localizedDescription: `Nova PDF ${version}. Nouveautés : https://github.com/${repo}/releases/tag/v${version}`,
      downloadURL: `https://github.com/${repo}/releases/download/v${version}/${basename(ipa)}`,
      size: statSync(ipa).size,
      minOSVersion: '15.0',
    }],
    appPermissions: { entitlements: [], privacy: {} },
  }],
  news: [],
};
writeFileSync(out, JSON.stringify(source, null, 2) + '\n');
console.log(`✓ ${out} (Nova PDF ${version}, ${source.apps[0].versions[0].size} octets)`);
