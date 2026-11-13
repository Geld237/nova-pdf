import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from '../pdf/engine';
import {
  allMemories, allNotes, clearAllData, exportAllData, importAllData, type AppSettings,
} from '../memory';
import { download } from '../pdf/tools';
import {
  APP_COMMIT, APP_VERSION, BUILD_DATE, REPO, applyAppUpdate, checkForAppUpdate, fetchLatestCommit,
  onUpdateState, updateState, type RemoteVersion,
} from '../update';

interface DocInfo {
  name: string;
  size: number;
  pdf: PDFDocumentProxy;
  currentPage: number;
  pageSize?: { w: number; h: number };
  encrypted: boolean;
}

interface Props {
  doc: DocInfo | null;
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  notify: (m: string) => void;
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl+O', 'Ouvrir'], ['Ctrl+S', 'Enregistrer'], ['Ctrl+Maj+S', 'Enregistrer sous'], ['Ctrl+P', 'Imprimer'],
  ['Ctrl+F', 'Rechercher'], ['Ctrl+Z / Ctrl+Y', 'Annuler / rétablir'], ['Ctrl + / −', 'Zoom'], ['Ctrl+0', 'Pleine largeur'],
  ['← → Début Fin', 'Navigation'], ['V', 'Sélection'], ['H U S', 'Surligner / souligner / barrer'], ['D', 'Dessin libre'],
  ['R E A', 'Rectangle / ellipse / flèche'], ['T N', 'Texte / note'], ['M', 'Mesure'], ['W', 'Correcteur blanc'],
  ['X', 'Gomme'], ['F', 'Mode concentration'], ['Échap', 'Revenir à la sélection'],
];

export function SettingsPanel({ doc, settings, setSettings, notify }: Props) {
  const [tab, setTab] = useState<'info' | 'settings' | 'updates' | 'data' | 'about'>(doc ? 'info' : 'settings');
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setSettings({ ...settings, [k]: v });

  return (
    <div className="panel settings-panel">
      <header className="panel-head">
        <h2>Infos & paramètres</h2>
      </header>
      <div className="seg wrap">
        {(
          [
            ['info', 'Document'],
            ['settings', 'Paramètres'],
            ['updates', 'Mises à jour'],
            ['data', 'Données'],
            ['about', 'À propos'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
            {id === 'updates' && updateState.needRefresh && <span className="dot" />}
          </button>
        ))}
      </div>

      {tab === 'info' && (doc ? <DocInfoView doc={doc} /> : <p className="empty">Aucun document ouvert.</p>)}

      {tab === 'settings' && (
        <div className="col">
          <label>
            Thème
            <select value={settings.theme} onChange={(e) => set('theme', e.target.value as AppSettings['theme'])}>
              <option value="system">Comme le système</option>
              <option value="light">Clair</option>
              <option value="dark">Sombre</option>
            </select>
          </label>
          <label>
            Zoom à l'ouverture
            <select value={settings.defaultFit} onChange={(e) => set('defaultFit', e.target.value as AppSettings['defaultFit'])}>
              <option value="width">Pleine largeur</option>
              <option value="page">Page entière</option>
              <option value="actual">Taille réelle (100 %)</option>
            </select>
          </label>
          <label>
            Couleur de surlignage par défaut
            <input type="color" value={settings.highlightColor} onChange={(e) => set('highlightColor', e.target.value)} />
          </label>
          <label>
            Langue OCR par défaut
            <select value={settings.ocrLang} onChange={(e) => set('ocrLang', e.target.value)}>
              <option value="fra+eng">Français + anglais</option>
              <option value="fra">Français</option>
              <option value="eng">Anglais</option>
              <option value="spa">Espagnol</option>
              <option value="deu">Allemand</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.resumeLastPage} onChange={(e) => set('resumeLastPage', e.target.checked)} />
            Reprendre à la dernière page lue
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.rememberAnnotations} onChange={(e) => set('rememberAnnotations', e.target.checked)} />
            Mémoriser les annotations sur cet appareil
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.confirmClose} onChange={(e) => set('confirmClose', e.target.checked)} />
            Confirmer avant de fermer un document modifié
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.autoCheckUpdates} onChange={(e) => set('autoCheckUpdates', e.target.checked)} />
            Vérifier les mises à jour au démarrage
          </label>
          <p className="muted">Les réglages de l'IA (moteur, modèle) sont dans le panneau ✦ IA → ⚙.</p>
          <details>
            <summary>Raccourcis clavier</summary>
            <table className="kbd-table">
              <tbody>
                {SHORTCUTS.map(([k, v]) => (
                  <tr key={k}>
                    <td><kbd>{k}</kbd></td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}

      {tab === 'updates' && <Updates notify={notify} />}
      {tab === 'data' && <DataView notify={notify} />}
      {tab === 'about' && <About />}
    </div>
  );
}

function DocInfoView({ doc }: { doc: DocInfo }) {
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<{ name: string; content: Uint8Array; description?: string }[]>([]);
  const [hasForm, setHasForm] = useState(false);

  useEffect(() => {
    (async () => {
      const m = await doc.pdf.getMetadata().catch(() => null);
      const info = (m?.info ?? {}) as Record<string, unknown>;
      const date = (v: unknown) => {
        const s = String(v ?? '');
        const r = s.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
        return r ? new Date(+r[1], +r[2] - 1, +r[3], +(r[4] ?? 0), +(r[5] ?? 0)).toLocaleString('fr-FR') : s;
      };
      setMeta({
        Titre: String(info.Title ?? ''),
        Auteur: String(info.Author ?? ''),
        Sujet: String(info.Subject ?? ''),
        'Mots-clés': String(info.Keywords ?? ''),
        'Créé avec': String(info.Creator ?? ''),
        Producteur: String(info.Producer ?? ''),
        Création: date(info.CreationDate),
        Modification: date(info.ModDate),
        'Version PDF': String(info.PDFFormatVersion ?? ''),
        Linéarisé: info.IsLinearized ? 'Oui (affichage web rapide)' : 'Non',
      });
      setHasForm(!!info.IsAcroFormPresent || !!info.IsXFAPresent);
      const att = (await doc.pdf.getAttachments().catch(() => null)) as Record<string, { filename: string; content: Uint8Array; description?: string }> | null;
      setAttachments(att ? Object.values(att).map((a) => ({ name: a.filename, content: a.content, description: a.description })) : []);
    })();
  }, [doc.pdf]);

  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  const rows: [string, string][] = [
    ['Fichier', doc.name],
    ['Taille', doc.size > 1048576 ? `${(doc.size / 1048576).toFixed(2)} Mo` : `${Math.round(doc.size / 1024)} Ko`],
    ['Pages', String(doc.pdf.numPages)],
    ['Page courante', doc.pageSize ? `${doc.currentPage + 1} — ${mm(doc.pageSize.w)} × ${mm(doc.pageSize.h)} mm` : String(doc.currentPage + 1)],
    ['Protégé', doc.encrypted ? 'Oui (déverrouillé pour cette session)' : 'Non'],
    ['Formulaire', hasForm ? 'Oui' : 'Non'],
    ...Object.entries(meta).filter(([, v]) => v),
    ['Empreinte', doc.pdf.fingerprints[0] ?? ''],
  ];
  return (
    <div className="col">
      <table className="info-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="sub">Pièces jointes ({attachments.length})</h3>
      {attachments.length === 0 ? (
        <p className="muted">Aucune. Vous pouvez en ajouter dans Outils → Pièces jointes.</p>
      ) : (
        <ul className="att-list">
          {attachments.map((a) => (
            <li key={a.name}>
              <span>📎 {a.name}</span>
              <button className="link" onClick={() => download(new Blob([a.content as BlobPart]), a.name)}>
                télécharger
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Updates({ notify }: { notify: (m: string) => void }) {
  const [, force] = useState(0);
  const [remote, setRemote] = useState<RemoteVersion | null>(null);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [install, setInstall] = useState<(Event & { prompt: () => Promise<void> }) | null>(null);

  useEffect(() => {
    const off = onUpdateState(() => force((n) => n + 1));
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setInstall(e as Event & { prompt: () => Promise<void> });
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);

  const check = async () => {
    setRemoteErr(null);
    const [app] = await Promise.all([
      checkForAppUpdate(),
      fetchLatestCommit().then(setRemote).catch((e) => setRemoteErr((e as Error).message)),
    ]);
    if (!app) notify('Aucune nouvelle version de l’application à installer.');
  };

  const upToDate = remote && APP_COMMIT && remote.sha === APP_COMMIT;
  const standalone = matchMedia?.('(display-mode: standalone)').matches;

  return (
    <div className="col">
      <table className="info-table">
        <tbody>
          <tr><th>Version</th><td>{APP_VERSION}</td></tr>
          <tr><th>Révision</th><td><code>{APP_COMMIT ? APP_COMMIT.slice(0, 7) : 'locale'}</code></td></tr>
          <tr><th>Compilée le</th><td>{new Date(BUILD_DATE).toLocaleString('fr-FR')}</td></tr>
          <tr><th>Hors ligne</th><td>{updateState.offlineReady || navigator.serviceWorker?.controller ? 'Prêt ✓' : 'Non (ouvrez l’app en ligne une fois)'}</td></tr>
          {updateState.lastCheck > 0 && <tr><th>Dernière vérif.</th><td>{new Date(updateState.lastCheck).toLocaleTimeString('fr-FR')}</td></tr>}
        </tbody>
      </table>

      {updateState.needRefresh ? (
        <div className="update-box">
          <b>Une nouvelle version est prête.</b>
          <p className="muted">Enregistrez vos documents ; vos annotations et notes sont conservées.</p>
          <button className="primary" onClick={applyAppUpdate}>Installer et redémarrer</button>
        </div>
      ) : (
        <button className="primary" disabled={updateState.checking} onClick={check}>
          {updateState.checking ? 'Vérification…' : 'Rechercher une mise à jour'}
        </button>
      )}

      {remote && (
        <div className="update-box">
          <small className="muted">Dernière version publiée sur GitHub</small>
          <div>
            <code>{remote.sha.slice(0, 7)}</code> — {remote.message}
          </div>
          <small className="muted">{new Date(remote.date).toLocaleString('fr-FR')}</small>
          <div>{upToDate ? '✓ Vous avez la dernière version.' : APP_COMMIT ? '↻ Une version plus récente existe sur GitHub.' : ''}</div>
          <a href={remote.url} target="_blank" rel="noreferrer">Voir les changements</a>
        </div>
      )}
      {remoteErr && <p className="muted">GitHub injoignable ({remoteErr}).</p>}

      <h3 className="sub">Installer l'application</h3>
      {standalone ? (
        <p className="muted">✓ Nova PDF est installée sur cet appareil.</p>
      ) : install ? (
        <button onClick={() => install.prompt()}>Installer Nova PDF</button>
      ) : (
        <p className="muted">Utilisez le menu du navigateur → « Installer Nova PDF » (Chrome, Edge) ou « Sur l'écran d'accueil » (Safari).</p>
      )}
      <p className="muted">
        Les mises à jour arrivent automatiquement quand une nouvelle version est publiée sur GitHub Pages ; vous choisissez quand l'installer.
        Depuis le code source : <code>git pull && npm install && npm run build</code>.
      </p>
    </div>
  );
}

function DataView({ notify }: { notify: (m: string) => void }) {
  const [est, setEst] = useState<{ usage?: number; quota?: number }>({});
  const [counts, setCounts] = useState({ docs: 0, anns: 0, notes: 0 });
  const refresh = async () => {
    setEst((await navigator.storage?.estimate?.()) ?? {});
    const m = await allMemories();
    const n = await allNotes();
    setCounts({ docs: m.length, anns: m.reduce((s, x) => s + x.annotations.length, 0), notes: n.length });
  };
  useEffect(() => {
    refresh();
  }, []);
  const mb = (b?: number) => (b ? `${(b / 1048576).toFixed(1)} Mo` : '—');

  return (
    <div className="col">
      <p className="muted">Tout est stocké uniquement sur cet appareil, dans le navigateur.</p>
      <table className="info-table">
        <tbody>
          <tr><th>Documents mémorisés</th><td>{counts.docs}</td></tr>
          <tr><th>Annotations</th><td>{counts.anns}</td></tr>
          <tr><th>Carnets de notes</th><td>{counts.notes}</td></tr>
          <tr><th>Espace utilisé</th><td>{mb(est.usage)} sur {mb(est.quota)}</td></tr>
        </tbody>
      </table>
      <p className="muted small">L'espace inclut le cache des modèles IA et des données OCR.</p>
      <button onClick={async () => download(await exportAllData(), `nova-pdf-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')}>
        Exporter une sauvegarde (annotations, notes, signatures, réglages)
      </button>
      <button
        onClick={() => {
          const i = document.createElement('input');
          i.type = 'file';
          i.accept = 'application/json';
          i.onchange = async () => {
            const f = i.files?.[0];
            if (!f) return;
            try {
              const n = await importAllData(await f.text());
              notify(`${n} élément(s) restauré(s).`);
              refresh();
            } catch (e) {
              notify(`Erreur : ${(e as Error).message}`);
            }
          };
          i.click();
        }}
      >
        Restaurer une sauvegarde…
      </button>
      <button
        className="danger"
        onClick={async () => {
          if (!confirm('Effacer toutes les annotations, notes, signatures et réglages mémorisés sur cet appareil ?')) return;
          await clearAllData();
          notify('Données effacées.');
          refresh();
        }}
      >
        Tout effacer
      </button>
    </div>
  );
}

function About() {
  return (
    <div className="col about">
      <p>
        <b>Nova PDF</b> — lecteur PDF libre, rapide et privé, avec une IA qui tourne sur votre appareil.
      </p>
      <p>
        Code source : <a href={`https://github.com/${REPO}`} target="_blank" rel="noreferrer">github.com/{REPO}</a>
        <br />
        Signaler un problème : <a href={`https://github.com/${REPO}/issues/new`} target="_blank" rel="noreferrer">ouvrir une issue</a>
      </p>
      <p className="muted">Licence MIT. Construit avec pdf.js (Apache-2.0), pdf-lib (MIT), @cantoo/pdf-lib (MIT), Tesseract.js (Apache-2.0), WebLLM (Apache-2.0), docx (MIT), React (MIT).</p>
      <p className="muted">Aucune télémétrie, aucun compte, aucun serveur.</p>
    </div>
  );
}
