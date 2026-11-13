// Recopie la version de package.json dans les projets natifs (Android, iOS, Tauri).
// Usage : node scripts/sync-version.mjs   (lancé automatiquement par la CI de release)
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const [maj, min, pat] = version.split('.').map(Number);
const code = maj * 10000 + min * 100 + pat;

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));

edit('android/app/build.gradle', (s) =>
  s.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${version}"`),
);
edit('ios/App/App.xcodeproj/project.pbxproj', (s) =>
  s.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`).replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${code};`),
);
edit('src-tauri/Cargo.toml', (s) => s.replace(/^version = "[^"]*"/m, `version = "${version}"`));
console.log(`Version ${version} (code ${code}) appliquée à Android, iOS et Tauri.`);
