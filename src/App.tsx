import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractAllText, getOutline, openPdfWithPassword, type PDFDocumentProxy } from './pdf/engine';
import { unlockPdf } from './pdf/security';
import { isNative, isTauri, listenOpenedFiles, nativeOpenPdfs, saveFile, writeNativeFile, clickInput } from './platform';
import { TAB_MIME, canMultiWindow, droppedOutside, dropStash, newToken, openWindow, stashDoc, takeDoc, wasTaken, closeIfSecondary } from './windows';
import { applyAnnotations } from './pdf/writer';
import { DEFAULT_SETTINGS, appendNote, loadMemory, loadSetting, saveMemory, saveSetting, type AppSettings } from './memory';
import { STAMP_PRESETS, makeStamp } from './stamps';
import { APP_VERSION, applyAppUpdate, checkForAppUpdate, checkNativeUpdate, onUpdateState, updateState, type NativeUpdate } from './update';
import { NotesPanel } from './components/NotesPanel';
import { LibraryPanel } from './components/LibraryPanel';
import { StudyPanel } from './components/StudyPanel';
import { SharePanel } from './components/SharePanel';
import { TranslateView } from './components/TranslateView';
import { Presentation } from './components/Presentation';
import { ScanModal } from './components/ScanModal';
import { addToLibrary, getLibFile, getLibText, listLibrary, removeFromLibrary, saveLibText, updateLibItem, type LibItem } from './library';
import { extractReferences, refMap } from './refs';
import { listen, parseCommand, speechSupported } from './voice';
import { session } from './p2p';
import { listSigRequests } from './pdf/sigreq';
import { allDecks, dueCards } from './study';
import type { CorpusDoc } from './components/AIPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { DEFAULT_AI, aiTasks, onAiTasks, stopAllAi, type AiSettings } from './ai/llm';
import { makeDemoPdf } from './demo';
import type { Annotation, OutlineItem, PageText, ToolId } from './types';
import { Viewer, type ViewerHandle } from './components/Viewer';
import { Sidebar } from './components/Sidebar';
import { AIPanel } from './components/AIPanel';
import { ToolsPanel, type DocCtx } from './components/ToolsPanel';
import { OrganizePanel } from './components/OrganizePanel';
import { FormPanel } from './components/FormPanel';
import { ReadingPanel } from './components/ReadingPanel';
import { SignatureModal } from './components/SignatureModal';
import type { ToolOptions } from './components/PageView';
import { Icon, type IconName } from './icons';
import { ColorPicker } from './components/ColorPicker';
import { AnnInspector } from './components/AnnInspector';
import { CompareView } from './components/CompareView';
import { ImageExport } from './components/ImageExport';
import { TextStyleBar, type TextStyle } from './components/TextStyleBar';
import { ContextMenu, type MenuItem, type MenuState } from './components/ContextMenu';
import { Workspace, type WorkspaceKind } from './components/Workspace';
import { DialogHost, ui } from './dialogs';
import { download, extractPages, baseName, assemblePages, imagesToPdf } from './pdf/tools';
import { identity, movePages, remapAnnotations, type LayoutItem } from './pageLayout';
import { renderPageToCanvas, canvasToBlob, openPdf } from './pdf/engine';
import { loadDeck, newCard, saveDeck } from './study';

interface DocState {
  id: string;
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  version: number;
  sizes: { w: number; h: number }[];
  outline: OutlineItem[];
  texts: PageText[] | null;
  fingerprint: string;
  annotations: Annotation[];
  undo: Annotation[][];
  redo: Annotation[][];
  dirty: boolean;
  handle?: FileSystemFileHandle;
  path?: string; // chemin natif (application de bureau)
  review?: boolean; // partagé en relecture avec l'appareil connecté
  startPage: number;
  encrypted: boolean;
}

type Panel = 'ai' | 'notes' | 'study' | 'reading' | 'form' | 'organize' | 'tools' | 'library' | 'share' | 'settings' | null;
type SideTab = 'pages' | 'outline' | 'search' | 'annotations' | 'notebook';

const TOOLS: { id: ToolId; label: string; key?: string }[] = [
  { id: 'select', label: 'Sélection de texte', key: 'v' },
  { id: 'edittext', label: 'Modifier le texte du PDF (cliquez sur une ligne)', key: 'k' },
  { id: 'move', label: 'Déplacer / redimensionner une annotation', key: 'g' },
  { id: 'highlight', label: 'Surligner', key: 'h' },
  { id: 'underline', label: 'Souligner', key: 'u' },
  { id: 'strike', label: 'Barrer', key: 's' },
  { id: 'ink', label: 'Dessin libre', key: 'd' },
  { id: 'rect', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'e' },
  { id: 'arrow', label: 'Flèche', key: 'a' },
  { id: 'text', label: 'Texte', key: 't' },
  { id: 'note', label: 'Note', key: 'n' },
  { id: 'signature', label: 'Signature' },
  { id: 'stamp', label: 'Tampon' },
  { id: 'image', label: 'Insérer une image' },
  { id: 'whiteout', label: 'Correcteur blanc (masquer pour réécrire)', key: 'w' },
  { id: 'measure', label: 'Mesurer', key: 'm' },
  { id: 'field', label: 'Créer un champ de formulaire' },
  { id: 'redact', label: 'Caviarder (définitif)' },
  { id: 'eraser', label: 'Gomme (supprimer une annotation)', key: 'x' },
  { id: 'snapshot', label: 'Capturer une zone en image', key: 'c' },
];

const COLORS = ['#ffeb3b', '#8bc34a', '#4fc3f7', '#f48fb1', '#ff9800', '#e53935', '#3949ab', '#212121'];

const uid = () => Math.random().toString(36).slice(2, 10);

export default function App() {
  const [docs, setDocs] = useState<DocState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scale, setScale] = useState(1.2);
  const [fit, setFit] = useState<'width' | 'page' | null>('width');
  const [layout, setLayout] = useState<'single' | 'double'>('single');
  const [night, setNight] = useState(false);
  const [settings, setSettingsState] = useState<AppSettings>(() => loadSetting('settings', DEFAULT_SETTINGS));
  const setSettings = (v: AppSettings) => {
    setSettingsState(v);
    saveSetting('settings', v);
  };
  const [sysDark, setSysDark] = useState(() => !!matchMedia?.('(prefers-color-scheme: dark)').matches);
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && sysDark);
  const [updateReady, setUpdateReady] = useState(false);
  const [nativeUpdate, setNativeUpdate] = useState<NativeUpdate | null>(null);
  const [tool, setTool] = useState<ToolId>('select');
  const [opts, setOpts] = useState<ToolOptions>(() => ({
    color: loadSetting('settings', DEFAULT_SETTINGS).highlightColor,
    strokeWidth: 2,
    opacity: 1,
    fontSize: 14,
    fontFamily: 'sans',
    bold: false,
    italic: false,
    underline: false,
    align: 'left',
    textBg: null,
    fieldType: 'text',
    measureRatio: 1,
    measureUnit: 'cm',
    stamp: null,
    stampSpec: null,
    stampDate: (localStorage.getItem('nova:stamp-date') as 'none' | 'date' | 'datetime') || 'date',
    stampAuthor: localStorage.getItem('nova:stamp-author') ?? '',
    sigDate: localStorage.getItem('nova:sig-date') === '1',
    sigWidth: +(localStorage.getItem('nova:sig-width') ?? 160),
    stampWidth: +(localStorage.getItem('nova:stamp-width') ?? 170),
    image: null,
    signer: '',
  }));
  const applyTextStyle = (st: TextStyle) =>
    setOpts((o) => ({ ...o, color: st.color, fontSize: st.fontSize, fontFamily: st.fontFamily, bold: st.bold, italic: st.italic, underline: st.underline, align: st.align, textBg: st.bg }));
  useEffect(() => {
    const on = (e: Event) => applyTextStyle((e as CustomEvent).detail as TextStyle);
    window.addEventListener('nova:text-style', on);
    return () => window.removeEventListener('nova:text-style', on);
  }, []);
  // un texte jaune fluo serait illisible : avec l'outil Texte on part sur du noir
  useEffect(() => {
    if (tool === 'text') setOpts((o) => (['#ffeb3b', '#fff59d', '#8bc34a', '#4fc3f7', '#f48fb1'].includes(o.color.toLowerCase()) ? { ...o, color: '#1c1c1e' } : o));
  }, [tool]);
  const [imgExport, setImgExport] = useState<null | { zone: { page: number; rect: { x: number; y: number; w: number; h: number } } | null }>(null);
  useEffect(() => {
    const snap = (e: Event) => setImgExport({ zone: (e as CustomEvent).detail });
    const all = () => setImgExport({ zone: null });
    window.addEventListener('nova:snapshot', snap);
    window.addEventListener('nova:export-images', all);
    return () => {
      window.removeEventListener('nova:snapshot', snap);
      window.removeEventListener('nova:export-images', all);
    };
  }, []);
  const [comparing, setComparing] = useState<{ pdf: PDFDocumentProxy; name: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setComparing((e as CustomEvent).detail);
    window.addEventListener('nova:compare', on);
    return () => window.removeEventListener('nova:compare', on);
  }, []);
  const [presenting, setPresenting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [scanning, setScanning] = useState<boolean | ((bytes: Uint8Array) => void)>(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceHeard, setVoiceHeard] = useState('');
  const stopVoice = useRef<(() => void) | null>(null);
  const sigResolver = useRef<((s: string | null) => void) | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const pointerStart = useRef<[number, number] | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceKind | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [sigModal, setSigModal] = useState(false);
  const [sidebar, setSidebar] = useState(() => typeof window === 'undefined' || window.innerWidth > 760) // sur téléphone, le panneau de gauche couvrirait la page;
  const [sideTab, setSideTab] = useState<SideTab>('pages');
  const closeSidePanels = () => {
    setPanel(null);
    setSidebar(false);
  };
  const [panel, setPanel] = useState<Panel>(null);
  // les panneaux qui font travailler l'IA restent montés (cachés) : leurs tâches continuent en arrière-plan
  const [kept, setKept] = useState<{ ai?: boolean; study?: boolean; reading?: boolean }>({});
  useEffect(() => {
    if (panel === 'ai' || panel === 'study' || panel === 'reading') setKept((k) => (k[panel] ? k : { ...k, [panel]: true }));
  }, [panel]);
  const [inspect, setInspect] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setInspect((e as CustomEvent).detail);
    window.addEventListener('nova:ann-select', on);
    return () => window.removeEventListener('nova:ann-select', on);
  }, []);
  const [aiRunning, setAiRunning] = useState<string[]>([]);
  useEffect(
    () =>
      onAiTasks(() => {
        const l = aiTasks();
        setAiRunning(l.map((t) => (t.waiting ? `${t.label} (en attente)` : t.label)));
        if (l.length && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      }),
    [],
  );
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [ai, setAi] = useState<AiSettings>(() => {
    const saved = loadSetting<AiSettings & { cpuModel?: string }>('ai', DEFAULT_AI);
    // réglages d'une version précédente : passage au moteur automatique
    try {
      const raw = JSON.parse(localStorage.getItem('nova:ai') ?? '{}');
      if (!raw.cpuModel && raw.provider === 'webllm') return { ...saved, provider: 'auto' };
    } catch {
      /* rien */
    }
    return saved;
  });
  const viewer = useRef<ViewerHandle>(null);

  const doc = docs.find((d) => d.id === activeId) ?? null;
  const docsRef = useRef<DocState[]>([]);
  docsRef.current = docs;
  const docRef = useRef<DocState | null>(null);
  docRef.current = doc;

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout((notify as unknown as { t?: number }).t);
    (notify as unknown as { t?: number }).t = window.setTimeout(() => setToast(null), 3500);
  }, []);

  // tâche d'IA longue terminée → on prévient
  useEffect(() => {
    const on = (e: Event) => {
      const { labels, seconds } = (e as CustomEvent).detail as { labels: string[]; seconds: number };
      const what = labels.slice(0, 2).join(', ');
      notify(`✓ IA terminée : ${what} (${seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`})`);
      try {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Nova PDF — IA terminée', { body: what, icon: '/icon-192.png' });
      } catch {
        /* notifications indisponibles */
      }
    };
    window.addEventListener('nova:ai-done', on);
    return () => window.removeEventListener('nova:ai-done', on);
  }, [notify]);

  const patchDoc = useCallback((id: string, patch: Partial<DocState> | ((d: DocState) => Partial<DocState>)) => {
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d)));
  }, []);

  useEffect(() => {
    const th = settings.theme === 'sepia' || settings.theme === 'contrast' ? settings.theme : dark ? 'dark' : 'light';
    const root = document.documentElement;
    root.dataset.theme = th;
    root.classList.toggle('dyslexic', !!settings.dyslexia);
    root.classList.toggle('sepia-pages', th === 'sepia' && settings.sepiaPages !== false);
    if (settings.accent) {
      root.style.setProperty('--accent', settings.accent);
      root.style.setProperty('--accent-soft', `color-mix(in srgb, ${settings.accent} ${th === 'dark' ? 30 : 16}%, transparent)`);
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-soft');
    }
  }, [dark, settings.dyslexia, settings.theme, settings.accent, settings.sepiaPages]);
  useEffect(() => {
    const mq = matchMedia?.('(prefers-color-scheme: dark)');
    const h = () => setSysDark(mq.matches);
    mq?.addEventListener('change', h);
    return () => mq?.removeEventListener('change', h);
  }, []);
  // mises à jour de l'application
  useEffect(() => {
    const off = onUpdateState(() => setUpdateReady(updateState.needRefresh));
    if (settings.autoCheckUpdates)
      setTimeout(() => {
        checkForAppUpdate().catch(() => {});
        checkNativeUpdate().then(setNativeUpdate).catch(() => {});
      }, 4000);
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    setFit(settings.defaultFit === 'actual' ? null : settings.defaultFit);
    if (settings.defaultFit === 'actual') setScale(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.defaultFit]);

  // ----- Ouverture -----------------------------------------------------------
  const loadInto = useCallback(
    async (
      bytes: Uint8Array,
      name: string,
      existingId?: string,
      handle?: FileSystemFileHandle,
      path?: string,
      opts?: { startPage?: number; annotations?: Annotation[]; review?: boolean; forceNew?: boolean },
    ): Promise<string | undefined> => {
      let pdf: PDFDocumentProxy;
      let encrypted = false;
      try {
        const r = await openPdfWithPassword(bytes, (retry) =>
          ui.prompt(retry ? 'Mot de passe incorrect. Réessayez :' : `« ${name} » est protégé par un mot de passe :`, '', { password: true }),
        );
        pdf = r.doc;
        if (r.password !== undefined) {
          // On garde une copie déchiffrée pour que tous les outils fonctionnent.
          encrypted = true;
          try {
            bytes = await unlockPdf(bytes, r.password);
            pdf = (await openPdfWithPassword(bytes, () => r.password!)).doc;
          } catch {
            notify('Document ouvert en lecture ; certains outils peuvent échouer sur ce chiffrement.');
          }
        }
      } catch (e) {
        notify(`Impossible d'ouvrir « ${name} » : ${(e as Error).message}`);
        return;
      }
      const sizes: { w: number; h: number }[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        sizes.push({ w: vp.width, h: vp.height });
      }
      const outline = await getOutline(pdf).catch(() => []);
      const fingerprint = pdf.fingerprints[0] ?? uid();

      if (existingId) {
        patchDoc(existingId, (d) => ({
          bytes, pdf, sizes, outline, texts: null, version: d.version + 1, annotations: opts?.annotations ?? [], undo: [], redo: [], dirty: true,
        }));
        extractAllText(pdf).then((texts) => patchDoc(existingId, { texts }));
        const prev = docsRef.current.find((x) => x.id === existingId);
        if (prev && settings.autoLibrary) addToLibrary({ id: prev.fingerprint, name: prev.name, size: bytes.length, pages: pdf.numPages }, bytes);
        return existingId;
      }
      // déjà ouvert dans un onglet ?
      const already = opts?.review || opts?.forceNew ? undefined : docsRef.current.find((d) => d.fingerprint === fingerprint);
      if (already) {
        setActiveId(already.id);
        if (opts?.startPage !== undefined) setTimeout(() => viewer.current?.scrollToPage(opts.startPage!), 200);
        return already.id;
      }
      const mem = await loadMemory(fingerprint);
      const id = uid();
      const state: DocState = {
        id, name, bytes, pdf, version: 0, sizes, outline, texts: null, fingerprint,
        annotations: opts?.annotations ?? (settings.rememberAnnotations ? mem?.annotations ?? [] : []), undo: [], redo: [], dirty: false, handle, path,
        startPage: opts?.startPage ?? (settings.resumeLastPage ? mem?.lastPage ?? 0 : 0), encrypted, review: opts?.review,
      };
      setDocs((ds) => [...ds, state]);
      setActiveId(id);
      setPage(state.startPage);
      if (settings.rememberAnnotations && mem?.annotations.length) notify(`${mem.annotations.length} annotation(s) retrouvée(s) pour ce document.`);
      extractAllText(pdf).then((texts) => {
        patchDoc(id, { texts });
        if (settings.autoLibrary) saveLibText(fingerprint, texts);
      });
      if (settings.autoLibrary) addToLibrary({ id: fingerprint, name, size: bytes.length, pages: pdf.numPages }, bytes);
      // demande de signature en attente ?
      listSigRequests(bytes)
        .then((r) => r.requests.length && notify(`✍ Ce document attend ${r.requests.length} signature(s) : panneau Partager → Signatures.`))
        .catch(() => {});
      return id;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notify, patchDoc, settings.rememberAnnotations, settings.resumeLastPage, settings.autoLibrary],
  );

  const openFiles = useCallback(
    async (files: File[] | FileList, handles?: FileSystemFileHandle[]) => {
      const list = Array.from(files);
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) {
          notify(`« ${f.name} » n'est pas un PDF.`);
          continue;
        }
        await loadInto(new Uint8Array(await f.arrayBuffer()), f.name, undefined, handles?.[i]);
      }
    },
    [loadInto, notify],
  );

  const openDialog = useCallback(async () => {
    const native = await nativeOpenPdfs().catch(() => null);
    if (native) {
      for (const f of native) await loadInto(f.bytes, f.name, undefined, undefined, f.path);
      return;
    }
    const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> };
    if (w.showOpenFilePicker) {
      try {
        const hs = await w.showOpenFilePicker({ multiple: true, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        await openFiles(await Promise.all(hs.map((h) => h.getFile())), hs);
      } catch {
        /* annulé */
      }
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.multiple = true;
    input.onchange = () => input.files && openFiles(input.files);
    clickInput(input);
  }, [openFiles, loadInto]);

  // Applications natives : fichiers ouverts depuis le système (double-clic, « Ouvrir avec »)
  useEffect(() => {
    listenOpenedFiles(async (files) => {
      for (const f of files) await loadInto(f.bytes, f.name, undefined, undefined, f.path);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ouverture depuis le système (PWA installée : « Ouvrir avec Nova PDF »)
  useEffect(() => {
    const lq = (window as unknown as { launchQueue?: { setConsumer: (cb: (p: { files: FileSystemFileHandle[] }) => void) => void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      if (params.files?.length) await openFiles(await Promise.all(params.files.map((h) => h.getFile())), params.files);
    });
  }, [openFiles]);

  // ----- Ajustement du zoom ---------------------------------------------------
  const maxW = useMemo(() => (doc ? Math.max(...doc.sizes.map((s) => s.w)) : 600), [doc]);
  const applyFit = useCallback(() => {
    if (!doc || !fit || !viewer.current) return;
    const cw = viewer.current.containerWidth() - (window.innerWidth <= 760 ? 14 : 48); // marges réduites sur téléphone
    const ch = viewer.current.containerHeight() - 32;
    const perRow = layout === 'double' ? 2 : 1;
    const s0 = doc.sizes[page] ?? doc.sizes[0];
    const next = fit === 'width' ? cw / (maxW * perRow + (perRow - 1) * 16) : Math.min(cw / (s0.w * perRow), ch / s0.h);
    setScale(Math.max(0.25, Math.min(5, next)));
  }, [doc, fit, layout, maxW, page]);

  useEffect(() => {
    applyFit();
    const onResize = () => applyFit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.version, fit, layout, sidebar, panel, focus]);

  // Reprise à la dernière page lue
  useEffect(() => {
    if (doc && doc.startPage > 0) {
      const t = setTimeout(() => viewer.current?.scrollToPage(doc.startPage), 150);
      patchDoc(doc.id, { startPage: 0 });
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id]);

  const zoom = (f: number) => {
    setFit(null);
    setScale((s) => Math.max(0.25, Math.min(5, +(s * f).toFixed(2))));
  };

  // ----- Annotations, annuler/rétablir, mémoire ------------------------------
  const setAnns = useCallback(
    (fn: (a: Annotation[]) => Annotation[]) => {
      if (!activeId) return;
      patchDoc(activeId, (d) => ({ annotations: fn(d.annotations), undo: [...d.undo.slice(-50), d.annotations], redo: [], dirty: true }));
    },
    [activeId, patchDoc],
  );
  const onAdd = useCallback(
    (a: Annotation) => {
      setAnns((l) => [...l, a]);
      const d = docRef.current;
      if (d?.review) session.peer?.send({ type: 'ann-add', fp: d.fingerprint, ann: a });
    },
    [setAnns],
  );
  const onDelete = useCallback(
    (id: string) => {
      setAnns((l) => l.filter((a) => a.id !== id));
      const d = docRef.current;
      if (d?.review) session.peer?.send({ type: 'ann-del', fp: d.fingerprint, id });
    },
    [setAnns],
  );
  const onUpdate = useCallback(
    (a: Annotation) => {
      setAnns((l) => l.map((x) => (x.id === a.id ? a : x)));
      const d = docRef.current;
      if (d?.review) {
        session.peer?.send({ type: 'ann-del', fp: d.fingerprint, id: a.id });
        session.peer?.send({ type: 'ann-add', fp: d.fingerprint, ann: a });
      }
    },
    [setAnns],
  );
  const addAnnotations = useCallback((list: Annotation[]) => setAnns((l) => [...l, ...list]), [setAnns]);

  // Messages de l'appareil connecté : relecture partagée, documents à signer
  useEffect(() => {
    let off: (() => void) | undefined;
    const attach = () => {
      off?.();
      off = session.peer?.on(async (m) => {
        if (m.type === 'review-open' || m.type === 'sig-file') {
          await loadInto(m.bytes as Uint8Array, String(m.name), undefined, undefined, undefined, {
            annotations: (m.annotations as Annotation[]) ?? undefined,
            review: m.type === 'review-open',
            forceNew: true,
            startPage: 0,
          });
          notify(m.type === 'review-open' ? `Relecture partagée : « ${m.name} »` : `Document reçu : « ${m.name} »`);
        } else if (m.type === 'ann-add' || m.type === 'ann-del') {
          setDocs((ds) =>
            ds.map((d) =>
              d.fingerprint !== m.fp
                ? d
                : {
                    ...d,
                    annotations:
                      m.type === 'ann-add'
                        ? d.annotations.some((x) => x.id === (m.ann as Annotation).id) ? d.annotations : [...d.annotations, m.ann as Annotation]
                        : d.annotations.filter((x) => x.id !== m.id),
                  },
            ),
          );
        }
      }) as (() => void) | undefined;
    };
    attach();
    session.listeners.add(attach);
    return () => {
      off?.();
      session.listeners.delete(attach);
    };
  }, [loadInto, notify]);
  const undo = () =>
    doc?.undo.length &&
    patchDoc(doc.id, (d) => ({ annotations: d.undo[d.undo.length - 1], undo: d.undo.slice(0, -1), redo: [...d.redo, d.annotations] }));
  const redo = () =>
    doc?.redo.length &&
    patchDoc(doc.id, (d) => ({ annotations: d.redo[d.redo.length - 1], redo: d.redo.slice(0, -1), undo: [...d.undo, d.annotations] }));

  useEffect(() => {
    if (!doc || !settings.rememberAnnotations) return;
    const t = setTimeout(
      () => saveMemory({ fingerprint: doc.fingerprint, name: doc.name, annotations: doc.annotations, lastPage: page, updatedAt: Date.now() }),
      600,
    );
    return () => clearTimeout(t);
  }, [doc?.annotations, doc?.fingerprint, doc?.name, page, doc]);

  // ----- Enregistrement --------------------------------------------------------
  const getBytes = useCallback(async () => {
    if (!doc) throw new Error('Aucun document');
    return applyAnnotations(doc.bytes, doc.annotations, doc.pdf);
  }, [doc]);

  const save = async (asNew = false) => {
    if (!doc) return;
    try {
      const out = await getBytes();
      if (isTauri) {
        let path = asNew ? undefined : doc.path;
        if (path) await writeNativeFile(path, out);
        else path = (await saveFile(out, doc.name)) ?? undefined;
        if (!path) return;
        patchDoc(doc.id, { path, name: path.split(/[\\/]/).pop() ?? doc.name, dirty: false });
        notify('Document enregistré ✔');
        return;
      }
      const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
      let handle = asNew ? undefined : doc.handle;
      if (!handle && w.showSaveFilePicker) {
        try {
          handle = await w.showSaveFilePicker({ suggestedName: doc.name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        } catch {
          return;
        }
      }
      if (handle) {
        const ws = await handle.createWritable();
        await ws.write(out as BlobPart);
        await ws.close();
        patchDoc(doc.id, { handle, name: handle.name, dirty: false });
      } else {
        download(out, doc.name);
        patchDoc(doc.id, { dirty: false });
      }
      notify('Document enregistré ✔');
    } catch (e) {
      notify(`Erreur d'enregistrement : ${(e as Error).message}`);
    }
  };

  const print = async () => {
    if (!doc) return;
    const out = await getBytes();
    const url = URL.createObjectURL(new Blob([out as BlobPart], { type: 'application/pdf' }));
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    f.src = url;
    f.onload = () => {
      try {
        f.contentWindow?.focus();
        f.contentWindow?.print();
      } catch {
        window.open(url, '_blank');
      }
      setTimeout(() => {
        f.remove();
        URL.revokeObjectURL(url);
      }, 60_000);
    };
    document.body.appendChild(f);
  };

  const closeDoc = async (id: string, force = false) => {
    const d = docsRef.current.find((x) => x.id === id);
    if (!force && d?.dirty && settings.confirmClose && !(await ui.confirm(`« ${d.name} » a des modifications non enregistrées (les annotations restent mémorisées). Fermer quand même ?`, { ok: 'Fermer' }))) return;
    d?.pdf.cleanup().catch(() => {});
    const rest = docsRef.current.filter((x) => x.id !== id);
    setDocs(rest);
    setActiveId((cur) => (cur === id ? rest[rest.length - 1]?.id ?? null : cur));
  };

  const goTo = useCallback((p: number) => viewer.current?.scrollToPage(p), []);

  // ----- Plusieurs fenêtres ----------------------------------------------------
  const transferOf = (d: DocState) => ({
    name: d.name,
    bytes: d.bytes,
    path: d.path,
    handle: d.handle,
    annotations: d.annotations,
    page: d.id === activeId ? page : d.startPage,
    dirty: d.dirty,
  });
  /** Envoie un onglet dans une nouvelle fenêtre (move = l'onglet quitte cette fenêtre). */
  const toNewWindow = async (id: string, o: { move?: boolean; tab?: boolean; x?: number; y?: number; token?: string } = {}) => {
    const d = docsRef.current.find((x) => x.id === id);
    if (!d) return;
    const token = await stashDoc(transferOf(d), o.token);
    const ok = await openWindow({ transfer: token }, { title: d.name, tab: o.tab, x: o.x, y: o.y });
    if (!ok) {
      dropStash(token);
      notify(isTauri ? 'Impossible d’ouvrir une nouvelle fenêtre.' : 'Le navigateur a bloqué la nouvelle fenêtre : autorisez les fenêtres surgissantes pour Nova PDF.');
      return;
    }
    if (o.move) moveAway(id);
  };
  /** l'onglet est parti dans une autre fenêtre : on le retire ; une fenêtre secondaire vide se ferme */
  const moveAway = (id: string) => {
    const last = docsRef.current.length === 1;
    closeDoc(id, true);
    if (last) setTimeout(() => closeIfSecondary(), 300);
  };
  const dragTab = useRef<{ id: string; token: string; handled: boolean } | null>(null);
  const receiveTab = async (token: string) => {
    const t = await takeDoc(token);
    if (!t) return;
    const newId = await loadInto(t.bytes, t.name, undefined, t.handle, t.path, { startPage: t.page, annotations: t.annotations, forceNew: true });
    if (newId && t.dirty) setDocs((l) => l.map((x) => (x.id === newId ? { ...x, dirty: true } : x)));
  };
  // fenêtre ouverte pour un document précis (?transfer=… ou ?lib=…)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const tr = q.get('transfer');
    const lib = q.get('lib');
    if (q.has('win')) history.replaceState(null, '', location.pathname);
    if (!tr && !lib) return;
    history.replaceState(null, '', location.pathname);
    if (tr) receiveTab(tr);
    else if (lib) openFromLibrary(lib, q.get('page') ? +q.get('page')! : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // titre de la fenêtre = document actif
  useEffect(() => {
    const t = doc ? `${doc.name} — Nova PDF` : 'Nova PDF';
    document.title = t;
    if (isTauri) import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().setTitle(t)).catch(() => {});
  }, [doc?.name]);

  // ----- Téléphone / tablette : gestes et confort ---------------------------
  const touchPrefs = { ...DEFAULT_SETTINGS.touch, ...(settings.touch ?? {}) };
  const touchRef = useRef(touchPrefs);
  touchRef.current = touchPrefs;
  const lastRightPanel = useRef<Panel>('tools');
  useEffect(() => {
    if (panel) lastRightPanel.current = panel;
  }, [panel]);
  const gestureState = useRef({ sidebar, panel, page, tool, numPages: doc?.sizes.length ?? 0 });
  gestureState.current = { sidebar, panel, page, tool, numPages: doc?.sizes.length ?? 0 };
  const [barsHidden, setBarsHidden] = useState(false);

  // glisser le doigt : bords → panneaux, milieu → page suivante / précédente
  useEffect(() => {
    let st: { x: number; y: number; t: number; edge: 'left' | 'right' | null; el: HTMLElement; multi: boolean } | null = null;
    const EDGE = 32;
    const blocked = (el: HTMLElement) =>
      !!el.closest('input, textarea, select, [contenteditable], .modal, .workspace, .color-pop, .ann-inspector, .topbar, .rail, .tabs, .ws-strip, .crop-stage, .scan-stage, .presentation, .compare-view, .overlay, .sig-pad, .text-edit-box, .inline-editor');
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        if (st) st.multi = true;
        return;
      }
      const t = e.touches[0];
      const x = t.clientX;
      st = { x, y: t.clientY, t: Date.now(), edge: x < EDGE ? 'left' : x > window.innerWidth - EDGE ? 'right' : null, el: e.target as HTMLElement, multi: false };
    };
    const onEnd = (e: TouchEvent) => {
      const s0 = st;
      if (!s0 || e.touches.length) return;
      st = null;
      if (s0.multi) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s0.x;
      const dy = t.clientY - s0.y;
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6 || Date.now() - s0.t > 1200) return;
      const g = gestureState.current;
      const prefs = touchRef.current;
      if (window.getSelection()?.toString()) return;
      // fermer un panneau en le repoussant vers son bord
      if (g.sidebar && dx < 0 && (s0.el.closest('.sidebar') || window.innerWidth <= 760)) return setSidebar(false);
      if (g.panel && dx > 0 && (s0.el.closest('.right') || window.innerWidth <= 760)) return setPanel(null);
      if (blocked(s0.el)) return;
      if (prefs.swipePanels && s0.edge === 'left' && dx > 0) return setSidebar(true);
      if (prefs.swipePanels && s0.edge === 'right' && dx < 0) return setPanel(lastRightPanel.current ?? 'tools');
      // changer de page : seulement si la page tient en largeur et qu'aucun outil de dessin n'est actif
      const v = s0.el.closest('.viewer') as HTMLElement | null;
      if (prefs.swipePages && v && v.scrollWidth <= v.clientWidth + 2 && (g.tool === 'select' || g.tool === 'hand') && !g.sidebar && !g.panel) {
        const next = Math.max(0, Math.min(g.numPages - 1, g.page + (dx < 0 ? 1 : -1)));
        if (next !== g.page) viewer.current?.scrollToPage(next);
      }
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, []);

  // masquer les barres en lisant (téléphone) : on descend → elles disparaissent, on remonte → elles reviennent
  useEffect(() => {
    let lastY = 0;
    let acc = 0;
    const on = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!el.classList?.contains('viewer')) return;
      const y = el.scrollTop;
      const d = y - lastY;
      lastY = y;
      if (!touchRef.current.autoHideBars || window.innerWidth > 760) return setBarsHidden(false);
      acc = Math.sign(d) === Math.sign(acc) ? acc + d : d;
      if (y < 40) setBarsHidden(false);
      else if (acc > 60) setBarsHidden(true);
      else if (acc < -40) setBarsHidden(false);
    };
    document.addEventListener('scroll', on, true);
    return () => document.removeEventListener('scroll', on, true);
  }, []);
  useEffect(() => {
    if (panel || sidebar || tool !== 'select') setBarsHidden(false);
  }, [panel, sidebar, tool]);

  // garder l'écran allumé pendant la lecture
  useEffect(() => {
    if (!touchPrefs.keepAwake || !doc || !('wakeLock' in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    const get = () =>
      (navigator as unknown as { wakeLock: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => {});
    get();
    const vis = () => document.visibilityState === 'visible' && get();
    document.addEventListener('visibilitychange', vis);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      lock?.release().catch(() => {});
    };
  }, [touchPrefs.keepAwake, doc?.id]);

  const [toolSheet, setToolSheet] = useState(false);
  // après avoir posé une signature / un tampon / une image : retour à la lecture (pas de nouvelle pose par erreur)
  useEffect(() => {
    const on = () => setTool('select');
    window.addEventListener('nova:tool-done', on);
    return () => window.removeEventListener('nova:tool-done', on);
  }, []);

  const ctx: DocCtx | null = doc
    ? {
        name: doc.name,
        pdf: doc.pdf,
        numPages: doc.sizes.length,
        currentPage: page,
        texts: doc.texts,
        getBytes,
        replace: async (bytes, label) => {
          await loadInto(bytes, doc.name, doc.id);
          notify(label);
        },
        docId: doc.id,
        annotations: doc.annotations,
        applyLayout: (items, label, sources) => applyLayout(items, label, sources),
        replaceKeep: async (bytes, label, annotations) => {
          await loadInto(bytes, doc.name, doc.id, undefined, undefined, { annotations });
          notify(label);
        },
        openNew: (bytes, name) => void loadInto(bytes, name),
        notify,
        outline: doc.outline,
        ocrLang: settings.ocrLang,
        ai,
        addAnnotations,
        getBytesRaw: async () => doc.bytes,
        markReview: () => patchDoc(doc.id, { review: true }),
        startScan: (onPdf) => setScanning(onPdf ? () => onPdf : true),
        openPanel: (p) => setPanel(p),
        openWorkspace: (k) => setWorkspace(k),
        selectTool: (t) => pickTool(t),
        goTo: (pg) => {
          setWorkspace(null);
          setTimeout(() => goTo(pg), 50);
        },
      }
    : null;

  // ----- Bibliothèque et documents multiples -------------------------------
  const openFromLibrary = useCallback(
    async (id: string, startPage?: number) => {
      const open = docsRef.current.find((d) => d.fingerprint === id);
      if (open) {
        setActiveId(open.id);
        if (startPage !== undefined) setTimeout(() => viewer.current?.scrollToPage(startPage), 150);
        return;
      }
      const bytes = await getLibFile(id);
      const meta = (await listLibrary()).find((i) => i.id === id);
      if (!bytes || !meta) {
        notify('Document introuvable dans la bibliothèque.');
        return;
      }
      await loadInto(bytes, meta.name, undefined, undefined, undefined, { startPage });
      updateLibItem(id, { openedAt: Date.now() });
    },
    [loadInto, notify],
  );

  const corpus = useCallback(async (scope: 'tabs' | 'library'): Promise<CorpusDoc[]> => {
    if (scope === 'tabs')
      return Promise.all(
        docsRef.current.map(async (d) => ({ id: d.fingerprint, name: d.name, texts: d.texts ?? (await extractAllText(d.pdf)) })),
      );
    const items = await listLibrary();
    const out: CorpusDoc[] = [];
    for (const i of items) {
      const texts = await getLibText(i.id);
      if (texts?.length) out.push({ id: i.id, name: i.name, texts });
    }
    return out;
  }, []);

  const refs = useMemo(() => (doc?.texts ? refMap(extractReferences(doc.texts)) : null), [doc?.texts]);

  const pickSignature = () =>
    new Promise<string | null>((res) => {
      sigResolver.current = res;
      setSigModal(true);
    });

  // ----- Commandes vocales ----------------------------------------------------
  const runVoice = (text: string) => {
    const a = parseCommand(text);
    if (!a) return notify(`🎙 « ${text} » : commande non reconnue`);
    const d = docRef.current;
    switch (a.type) {
      case 'next': return goTo(Math.min(page + 1, (d?.sizes.length ?? 1) - 1));
      case 'prev': return goTo(Math.max(page - 1, 0));
      case 'page': return goTo(a.n - 1);
      case 'first': return goTo(0);
      case 'last': return goTo((d?.sizes.length ?? 1) - 1);
      case 'zoomIn': return zoom(1.2);
      case 'zoomOut': return zoom(1 / 1.2);
      case 'fit': return setFit('width');
      case 'tool': return setTool(a.tool as ToolId);
      case 'search': setSidebar(true); setSideTab('search'); return setQuery(a.q);
      case 'panel': return setPanel(a.panel as Panel);
      case 'read': return setPanel('reading');
      case 'stop': return speechSynthesis?.cancel();
      case 'save': return save();
      case 'night': return setNight((n) => !n);
      case 'present': return setPresenting(true);
      case 'note':
        if (d) appendNote(d.fingerprint, d.name, `- 🎙 ${a.text} [p. ${page + 1}]`).then(() => notify('Note ajoutée.'));
        return;
      case 'ask': setPanel('ai'); return notify(`Question : ${a.q} — tapez Entrée dans le panneau IA`);
    }
  };

  // ----- Menus contextuels (clic droit) -----------------------------------------
  // ----- Pages : toute modification de pages garde les annotations modifiables (et peut être annulée)
  const layoutUndo = useRef<Record<string, { bytes: Uint8Array; annotations: Annotation[]; label: string }[]>>({});
  const applyLayout = async (items: LayoutItem[], label: string, sources: Uint8Array[] = []) => {
    const d = docsRef.current.find((x) => x.id === activeId);
    if (!d) return;
    if (!items.length) return notify('Un document doit garder au moins une page.');
    try {
      const bytes = await assemblePages(d.bytes, sources, items);
      const annotations = remapAnnotations(d.annotations, items, d.sizes);
      (layoutUndo.current[d.id] ??= []).push({ bytes: d.bytes, annotations: d.annotations, label });
      if (layoutUndo.current[d.id].length > 20) layoutUndo.current[d.id].shift();
      await loadInto(bytes, d.name, d.id, undefined, undefined, { annotations });
      notify(`${label} — Ctrl+Z pour annuler`);
    } catch (e) {
      notify(`Erreur : ${(e as Error).message}`);
    }
  };
  const undoLayout = async () => {
    const d = docsRef.current.find((x) => x.id === activeId);
    const prev = d && layoutUndo.current[d.id]?.pop();
    if (!d || !prev) return notify('Rien à annuler sur les pages.');
    await loadInto(prev.bytes, d.name, d.id, undefined, undefined, { annotations: prev.annotations });
    notify(`Annulé : ${prev.label}`);
  };
  const nPages = () => docsRef.current.find((x) => x.id === activeId)?.sizes.length ?? 0;
  const pagesLabel = (l: number[]) => (l.length > 1 ? `${l.length} pages` : `Page ${l[0] + 1}`);
  const rotatePages = (l: number[], deg: number) =>
    applyLayout(identity(nPages()).map((o) => (l.includes(o.src) ? { ...o, rotate: deg } : o)), `${pagesLabel(l)} pivotée(s)`);
  const deletePages = async (l: number[]) => {
    if (l.length >= nPages()) return notify('Un document doit garder au moins une page.');
    if (!(await ui.confirm(l.length > 1 ? `Supprimer ces ${l.length} pages ?` : `Supprimer la page ${l[0] + 1} ?`, { ok: 'Supprimer', danger: true }))) return;
    applyLayout(identity(nPages()).filter((o) => !l.includes(o.src)), `${pagesLabel(l)} supprimée(s)`);
  };
  const insertBlank = (i: number) => {
    const o = identity(nPages());
    o.splice(i + 1, 0, { doc: 0, src: -1, rotate: 0 });
    applyLayout(o, 'Page blanche insérée');
  };
  const duplicatePages = (l: number[]) =>
    applyLayout(identity(nPages()).flatMap((o) => (l.includes(o.src) ? [o, { ...o }] : [o])), `${pagesLabel(l)} dupliquée(s)`);
  const reorderTo = (from: number[], to: number) => applyLayout(movePages(identity(nPages()), from, to), `${pagesLabel(from)} déplacée(s)`);
  /** Insère d'autres pages (PDF, images, scan) à la position `at`. */
  const insertFrom = async (at: number, kind: 'pdf' | 'images' | 'scan') => {
    const put = async (bytes: Uint8Array, what: string) => {
      const src = await openPdf(bytes, () => ui.prompt('Mot de passe du document à insérer :', '', { password: true }));
      const o = identity(nPages());
      o.splice(at, 0, ...Array.from({ length: src.numPages }, (_, i) => ({ doc: 1, src: i, rotate: 0 })));
      await applyLayout(o, `${src.numPages} page(s) insérée(s) depuis ${what}`, [bytes]);
    };
    if (kind === 'scan') return setScanning(() => (b: Uint8Array) => put(b, 'le scanner'));
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.accept = kind === 'pdf' ? 'application/pdf,.pdf' : 'image/*';
    i.onchange = async () => {
      const files = [...(i.files ?? [])];
      if (!files.length) return;
      try {
        if (kind === 'images') {
          await put(await imagesToPdf(files), files.length > 1 ? `${files.length} images` : files[0].name);
        } else for (const f of files.reverse()) await put(new Uint8Array(await f.arrayBuffer()), f.name);
      } catch (e) {
        notify(`Insertion impossible : ${(e as Error).message}`);
      }
    };
    clickInput(i);
  };
  const extractPagesTo = async (l: number[], tab: boolean) => {
    if (!doc || !ctx) return;
    const b = await extractPages(await ctx.getBytes(), [...l].sort((x, y) => x - y));
    const name = `${baseName(doc.name)}-pages-${l.map((x) => x + 1).join('-').slice(0, 30)}.pdf`;
    if (tab) loadInto(b, name);
    else download(b, name);
  };
  const exportPage = async (i: number) => doc && download(await canvasToBlob(await renderPageToCanvas(doc.pdf, i, 2)), `${baseName(doc.name)}-p${i + 1}.png`, 'image/png');
  const speak = (t: string) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'fr-FR';
    speechSynthesis.speak(u);
  };
  const askAi = (action: 'explain' | 'translate', text: string) => {
    setPanel('ai');
    setTimeout(() => window.dispatchEvent(new CustomEvent('nova:ai', { detail: { action, text } })), 120);
  };

  /** Menu d'une page (ou de plusieurs pages sélectionnées dans la colonne Pages). */
  const pageMenuItems = (i: number, sel: number[] = [i]): MenuItem[] => {
    const l = sel.includes(i) ? sel : [i];
    const many = l.length > 1;
    const last = Math.max(...l);
    const first = Math.min(...l);
    const n = nPages();
    return [
      { header: many ? `${l.length} pages sélectionnées` : `Page ${i + 1}` },
      { label: 'Insérer après : pages d’un autre PDF…', icon: 'merge', action: () => insertFrom(last + 1, 'pdf') },
      { label: 'Insérer après : image(s)…', icon: 'image', action: () => insertFrom(last + 1, 'images') },
      { label: 'Insérer après : scanner…', icon: 'scan', action: () => insertFrom(last + 1, 'scan') },
      { label: 'Insérer une page blanche après', icon: 'create', action: () => insertBlank(last) },
      { label: 'Insérer avant : pages d’un autre PDF…', icon: 'merge', action: () => insertFrom(first, 'pdf') },
      'sep',
      { label: 'Pivoter à droite', icon: 'rotateCw', action: () => rotatePages(l, 90) },
      { label: 'Pivoter à gauche', icon: 'rotateCcw', action: () => rotatePages(l, -90) },
      { label: many ? 'Dupliquer ces pages' : 'Dupliquer la page', icon: 'copy', action: () => duplicatePages(l) },
      { label: 'Déplacer au début', icon: 'back', disabled: first === 0 && !many, action: () => reorderTo(l, 0) },
      { label: 'Déplacer à la fin', icon: 'next', disabled: last === n - 1 && !many, action: () => reorderTo(l, n) },
      'sep',
      { label: many ? 'Extraire ces pages (PDF)…' : 'Extraire en PDF', icon: 'extract', action: () => extractPagesTo(l, false) },
      { label: 'Ouvrir dans un nouvel onglet', icon: 'open', action: () => extractPagesTo(l, true) },
      ...(!many
        ? [
            { label: 'Exporter en image', icon: 'picture' as IconName, action: () => exportPage(i) },
            { label: 'Copier le texte de la page', icon: 'file' as IconName, disabled: !doc?.texts, action: () => navigator.clipboard?.writeText(doc?.texts?.[i]?.text ?? '') },
            { label: 'Lire la page à voix haute', icon: 'speak' as IconName, disabled: !doc?.texts, action: () => speak(doc?.texts?.[i]?.text ?? '') },
          ]
        : []),
      { label: 'Organiser toutes les pages en grand…', icon: 'organize', action: () => setWorkspace('organize') },
      { label: 'Annuler la dernière modification de pages', icon: 'undo', disabled: !layoutUndo.current[activeId ?? '']?.length, action: undoLayout },
      'sep',
      { label: many ? `Supprimer ces ${l.length} pages` : 'Supprimer la page', icon: 'trash', danger: true, action: () => deletePages(l) },
    ];
  };

  const onViewerMenu = (e: React.MouseEvent) => {
    if (!doc) return;
    const pageEl = (e.target as HTMLElement).closest('.page') as HTMLElement | null;
    if (!pageEl) return;
    e.preventDefault();
    const pi = Number(pageEl.dataset.page);
    const r = pageEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / scale;
    const y = (e.clientY - r.top) / scale;
    const sel = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
    const items: MenuItem[] = [];

    if (sel) {
      const short = sel.length > 28 ? `${sel.slice(0, 28)}…` : sel;
      items.push(
        { header: `« ${short} »` },
        { label: 'Copier', icon: 'copy', shortcut: 'Ctrl+C', action: () => navigator.clipboard?.writeText(sel) },
        { label: 'Surligner', icon: 'highlight', shortcut: 'H', action: () => window.dispatchEvent(new CustomEvent('nova:mark-selection', { detail: { kind: 'highlight' } })) },
        { label: 'Souligner', icon: 'underline', action: () => window.dispatchEvent(new CustomEvent('nova:mark-selection', { detail: { kind: 'underline' } })) },
        { label: 'Barrer', icon: 'strike', action: () => window.dispatchEvent(new CustomEvent('nova:mark-selection', { detail: { kind: 'strike' } })) },
        'sep',
        { label: "Expliquer avec l'IA", icon: 'ai', action: () => askAi('explain', sel) },
        { label: 'Traduire', icon: 'translate', action: () => askAi('translate', sel) },
        { label: 'Citer dans mes notes', icon: 'cite', action: () => appendNote(doc.fingerprint, doc.name, `> « ${sel} » [p. ${pi + 1}]`).then(() => notify('Citation ajoutée à vos notes.')) },
        {
          label: 'Créer une fiche de révision',
          icon: 'card',
          action: async () => {
            const q = await ui.prompt('Question de la fiche (la sélection sera la réponse) :', `Que dit le document sur « ${short} » ?`);
            if (!q) return;
            const deck = await loadDeck(doc.fingerprint, doc.name);
            await saveDeck({ ...deck, cards: [...deck.cards, newCard(q, sel, pi)] });
            notify('Fiche ajoutée (panneau Étude).');
          },
        },
        { label: 'Rechercher dans le document', icon: 'search', action: () => { setSidebar(true); setSideTab('search'); setQuery(sel); } },
        { label: 'Lire à voix haute', icon: 'speak', action: () => speak(sel) },
      );
    } else {
      // annotation sous le curseur ?
      const hit = [...doc.annotations].reverse().find((a) => {
        if (a.page !== pi) return false;
        const boxes = a.rects ?? (a.rect ? [a.rect] : []);
        if (a.points?.length) {
          const xs = a.points.map((p) => p[0]);
          const ys = a.points.map((p) => p[1]);
          boxes.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
        }
        return boxes.some((b) => x >= b.x - 4 && x <= b.x + Math.max(b.w, 18) + 4 && y >= b.y - 4 && y <= b.y + Math.max(b.h, 18) + 4);
      });
      if (hit) {
        items.push(
          { header: 'Annotation' },
          ...(hit.text ? [{ label: 'Copier le texte', icon: 'copy' as IconName, action: () => navigator.clipboard?.writeText(hit.text!) }] : []),
          { label: 'Modifier (couleur, épaisseur, opacité…)', icon: 'palette' as IconName, action: () => setInspect({ id: hit.id, x: e.clientX, y: e.clientY }) },
          { label: "Supprimer l'annotation", icon: 'trash', danger: true, action: () => onDelete(hit.id) },
          'sep',
        );
      }
      items.push(
        { header: 'Ajouter ici' },
        { label: 'Note', icon: 'note', action: () => window.dispatchEvent(new CustomEvent('nova:edit-at', { detail: { page: pi, x, y, kind: 'note' } })) },
        { label: 'Texte', icon: 'text', action: () => window.dispatchEvent(new CustomEvent('nova:edit-at', { detail: { page: pi, x, y, kind: 'text' } })) },
        {
          label: 'Ma signature',
          icon: 'signature',
          action: async () => {
            const sig = signature ?? (await pickSignature());
            if (!sig) return;
            const img = new Image();
            img.onload = () => {
              const w = 160;
              const h = (img.height / img.width) * w;
              onAdd({ id: uid(), page: pi, kind: 'image', color: '#000', opacity: 1, strokeWidth: 1, rect: { x: x - w / 2, y: y - h / 2, w, h }, dataUrl: sig, createdAt: Date.now() });
            };
            img.src = sig;
          },
        },
        {
          label: 'Tampon « Approuvé »',
          icon: 'stamp',
          action: () => {
            const src = makeStamp('APPROUVÉ', '#2e7d32');
            const img = new Image();
            img.onload = () => {
              const w = 170;
              const h = (img.height / img.width) * w;
              onAdd({ id: uid(), page: pi, kind: 'image', color: '#000', opacity: 0.9, strokeWidth: 1, rect: { x: x - w / 2, y: y - h / 2, w, h }, dataUrl: src, createdAt: Date.now() });
            };
            img.src = src;
          },
        },
        'sep',
        { header: 'Outils' },
        { label: 'Surligner', icon: 'highlight', shortcut: 'H', action: () => setTool('highlight') },
        { label: 'Dessin libre', icon: 'ink', shortcut: 'D', action: () => setTool('ink') },
        { label: 'Rectangle', icon: 'rect', shortcut: 'R', action: () => setTool('rect') },
        { label: 'Mesurer', icon: 'measure', shortcut: 'M', action: () => setTool('measure') },
        { label: 'Caviarder', icon: 'redact', action: () => setTool('redact') },
        'sep',
        ...pageMenuItems(pi),
        'sep',
        { label: 'Présenter depuis cette page', icon: 'present', action: () => { goTo(pi); setPresenting(true); } },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onThumbMenu = (e: React.MouseEvent, i: number, sel: number[] = [i]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: [{ label: 'Aller à la page', icon: 'pages', action: () => goTo(i) }, 'sep', ...pageMenuItems(i, sel)] });
  };

  /** Clic droit sur un document de la bibliothèque ou des récents. */
  const libItemMenu = (e: React.MouseEvent, item: LibItem) => {
    e.preventDefault();
    const open = docsRef.current.find((d) => d.fingerprint === item.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { header: item.name },
        { label: open ? 'Afficher l’onglet' : 'Ouvrir', icon: 'open', action: () => openFromLibrary(item.id) },
        ...(canMultiWindow
          ? [
              { label: 'Ouvrir dans une nouvelle fenêtre', icon: 'split' as IconName, action: () => openWindow({ lib: item.id }, { title: item.name }) },
              ...(!isTauri ? [{ label: 'Ouvrir dans un nouvel onglet du navigateur', icon: 'open' as IconName, action: () => openWindow({ lib: item.id }, { tab: true }) }] : []),
            ]
          : []),
        {
          label: 'Reprendre à la dernière page lue',
          icon: 'reading',
          action: async () => openFromLibrary(item.id, (await loadMemory(item.id))?.lastPage ?? 0),
        },
        { label: 'Présenter', icon: 'present', action: async () => { await openFromLibrary(item.id); setTimeout(() => setPresenting(true), 300); } },
        'sep',
        { label: item.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', icon: 'bookmarks', action: () => updateLibItem(item.id, { favorite: !item.favorite }) },
        {
          label: 'Ranger dans un dossier…',
          icon: 'library',
          action: async () => {
            const f = await ui.prompt('Dossier (ex. Cours/Chimie, vide = racine) :', item.folder);
            if (f !== null) updateLibItem(item.id, { folder: f.trim().replace(/^\/+|\/+$/g, '') });
          },
        },
        {
          label: 'Étiquettes…',
          icon: 'hash',
          action: async () => {
            const t = await ui.prompt('Étiquettes séparées par des virgules :', item.tags.join(', '));
            if (t !== null) updateLibItem(item.id, { tags: t.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean) });
          },
        },
        {
          label: 'Renommer…',
          icon: 'edit',
          action: async () => {
            const n = await ui.prompt('Nouveau nom :', item.name);
            if (n?.trim()) updateLibItem(item.id, { name: /\.pdf$/i.test(n) ? n.trim() : `${n.trim()}.pdf` });
          },
        },
        {
          label: 'Enregistrer une copie…',
          icon: 'save',
          action: async () => {
            const b = await getLibFile(item.id);
            if (b) download(b, item.name);
          },
        },
        { label: 'Afficher dans la bibliothèque', icon: 'library', action: () => setPanel('library') },
        'sep',
        {
          label: 'Retirer de la bibliothèque',
          icon: 'trash',
          danger: true,
          action: async () => {
            if (await ui.confirm(`Retirer « ${item.name} » de la bibliothèque et des documents récents ? (le fichier d'origine n'est pas supprimé)`, { ok: 'Retirer', danger: true }))
              removeFromLibrary(item.id);
          },
        },
      ],
    });
  };

  const onTabMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { header: d.name },
        { label: 'Enregistrer', icon: 'save', shortcut: 'Ctrl+S', action: () => { setActiveId(id); setTimeout(() => save(), 50); } },
        { label: 'Afficher dans la bibliothèque', icon: 'library', action: () => setPanel('library') },
        { label: 'Présenter', icon: 'present', action: () => { setActiveId(id); setPresenting(true); } },
        ...(canMultiWindow
          ? [
              'sep' as const,
              { label: 'Déplacer vers une nouvelle fenêtre', icon: 'split' as IconName, action: () => toNewWindow(id, { move: true }) },
              { label: 'Dupliquer dans une nouvelle fenêtre', icon: 'copy' as IconName, action: () => toNewWindow(id) },
              ...(!isTauri ? [{ label: 'Ouvrir dans un nouvel onglet du navigateur', icon: 'open' as IconName, action: () => toNewWindow(id, { move: true, tab: true }) }] : []),
              { label: 'Nouvelle fenêtre vide', icon: 'split' as IconName, action: () => openWindow({}) },
            ]
          : []),
        'sep',
        { label: 'Fermer', icon: 'close', action: () => closeDoc(id) },
        { label: 'Fermer les autres onglets', icon: 'close', disabled: docs.length < 2, action: () => docs.filter((x) => x.id !== id).forEach((x) => closeDoc(x.id)) },
      ],
    });
  };

  const toggleVoice = () => {
    if (voiceOn) {
      stopVoice.current?.();
      return;
    }
    setVoiceOn(true);
    stopVoice.current = listen({
      continuous: true,
      onText: (t, final) => {
        setVoiceHeard(t);
        if (final) {
          runVoice(t.trim());
          setTimeout(() => setVoiceHeard(''), 1500);
        }
      },
      onEnd: () => {
        setVoiceOn(false);
        setVoiceHeard('');
      },
      onError: (e) => notify(e),
    });
  };

  // Raccourcis de l'application (icône, menu « Ouvrir avec »…) : ?action=scan|library|study
  useEffect(() => {
    const a = new URLSearchParams(location.search).get('action');
    if (a === 'scan') setScanning(true);
    else if (a === 'library') setPanel('library');
    else if (a === 'study')
      allDecks().then(async (ds) => {
        const d = ds.find((x) => dueCards(x).length);
        if (d) {
          await openFromLibrary(d.fingerprint);
          setPanel('study');
        }
      });
  }, []);

  // ----- Raccourcis clavier -----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openDialog(); return; }
      if (!doc) return;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); return; }
      if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); print(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setFocus((f) => !f); return; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); setSidebar(true); setSideTab('search'); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        // juste après une modification de pages (rien d'autre à annuler) : on annule la modification de pages
        if (!e.shiftKey && !doc.undo.length && layoutUndo.current[doc.id]?.length) return void undoLayout();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoom(1.15); return; }
      if (mod && e.key === '-') { e.preventDefault(); zoom(1 / 1.15); return; }
      if (mod && e.key === '0') { e.preventDefault(); setFit('width'); return; }
      if (mod) return;
      if (e.key === 'Escape') { setTool('select'); setFocus(false); return; }
      if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !e.shiftKey)) { goTo(Math.min(page + 1, doc.sizes.length - 1)); e.preventDefault(); return; }
      if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !e.shiftKey)) { goTo(Math.max(page - 1, 0)); e.preventDefault(); return; }
      if (e.key === 'Home') { goTo(0); return; }
      if (e.key === 'End') { goTo(doc.sizes.length - 1); return; }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) setTool(t.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pickTool = (t: ToolId) => {
    if (t === 'signature') {
      setSigModal(true);
      return;
    }
    if (t === 'image') {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
      i.onchange = () => {
        const f = i.files?.[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          setOpts((o) => ({ ...o, image: String(r.result) }));
          setTool('image');
          notify("Cliquez sur la page pour placer l'image. Outil « Déplacer » (G) pour l'ajuster.");
        };
        r.readAsDataURL(f);
      };
      clickInput(i);
      return;
    }
    if (t === 'edittext') notify('Cliquez sur une ligne du document pour la modifier. Entrée pour valider.');
    if (t === 'stamp' && !opts.stamp) setOpts({ ...opts, stamp: makeStamp(STAMP_PRESETS[0].label, STAMP_PRESETS[0].color, opts.stampDate, opts.stampAuthor), stampSpec: STAMP_PRESETS[0] });
    setTool(t);
    if (t === 'highlight' && ['#e53935', '#3949ab', '#212121'].includes(opts.color)) setOpts({ ...opts, color: '#ffeb3b' });
  };

  const showColor = !['select', 'eraser', 'signature', 'redact', 'whiteout', 'stamp', 'field', 'edittext', 'image', 'move'].includes(tool);

  return (
    <div
      className={`app ${focus ? 'focus' : ''} ${barsHidden ? 'bars-hidden' : ''} ${touchPrefs.bigButtons ? 'big-buttons' : ''} ${touchPrefs.toolSheet ? 'tool-sheet-mode' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
      }}
    >
      <header className="topbar">
        {doc && !isNative && (
          <div className="brand" title="Nova PDF">
            <img className="logo" src="./icon.svg" alt="Nova PDF" />
          </div>
        )}
        <button className="tb" onClick={openDialog} title="Ouvrir (Ctrl+O)"><Icon name="open" /><span>Ouvrir</span></button>
        {doc && (
          <>
            <button onClick={() => save()} title="Enregistrer (Ctrl+S)" className={`tb ${doc.dirty ? 'primary' : ''}`}>
              <Icon name="save" /><span>Enregistrer</span>
            </button>
            <button className="tb icon" onClick={() => save(true)} title="Enregistrer sous (Ctrl+Maj+S)"><Icon name="saveAs" /></button>
            <button className="tb icon" onClick={print} title="Imprimer (Ctrl+P)"><Icon name="print" /></button>
            <span className="sep" />
            <button className="icon" onClick={undo} disabled={!doc.undo.length} title="Annuler (Ctrl+Z)"><Icon name="undo" /></button>
            <button className="icon" onClick={redo} disabled={!doc.redo.length} title="Rétablir (Ctrl+Y)"><Icon name="redo" /></button>
            <span className="sep" />
            <div className="tools" role="toolbar" aria-label="Outils d'annotation">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={`tool ${tool === t.id ? 'active' : ''}`}
                  onClick={() => pickTool(t.id)}
                  title={`${t.label}${t.key ? ` (${t.key.toUpperCase()})` : ''}`}
                  aria-pressed={tool === t.id}
                >
                  <Icon name={t.id as IconName} />
                </button>
              ))}
            </div>
            {showColor && (
              <div className="tool-opts">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`color ${opts.color === c ? 'active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setOpts({ ...opts, color: c })}
                    aria-label={`Couleur ${c}`}
                  />
                ))}
                {tool !== 'text' && <ColorPicker value={opts.color} onChange={(c) => c && setOpts({ ...opts, color: c })} title="Carte des couleurs" />}
                {['highlight', 'rect', 'ellipse', 'ink'].includes(tool) && (
                  <input type="range" min={0.15} max={1} step={0.05} value={opts.opacity} onChange={(e) => setOpts({ ...opts, opacity: +e.target.value })} title={`Opacité ${Math.round(opts.opacity * 100)} %`} className="opacity-range" />
                )}
                {['ink', 'rect', 'ellipse', 'arrow'].includes(tool) && (
                  <input type="range" min={1} max={12} value={opts.strokeWidth} onChange={(e) => setOpts({ ...opts, strokeWidth: +e.target.value })} title="Épaisseur" />
                )}
                {tool === 'text' && (
                  <TextStyleBar
                    value={{ fontFamily: opts.fontFamily, fontSize: opts.fontSize, bold: opts.bold, italic: opts.italic, underline: opts.underline, align: opts.align, color: opts.color, bg: opts.textBg }}
                    onChange={applyTextStyle}
                  />
                )}
                {tool === 'measure' && (
                  <>
                    <label className="inline" title="Échelle du plan (1:N)">
                      1:
                      <input type="number" min={1} value={opts.measureRatio} onChange={(e) => setOpts({ ...opts, measureRatio: Math.max(1, +e.target.value) })} />
                    </label>
                    <select value={opts.measureUnit} onChange={(e) => setOpts({ ...opts, measureUnit: e.target.value as ToolOptions['measureUnit'] })}>
                      <option value="mm">mm</option>
                      <option value="cm">cm</option>
                      <option value="m">m</option>
                      <option value="in">po</option>
                    </select>
                  </>
                )}
              </div>
            )}
            {tool === 'signature' && (
              <div className="tool-opts">
                {signature && <img className="sig-chip" src={signature} alt="Signature" title="Changer de signature" onClick={() => setSigModal(true)} />}
                <label className="size-opt" title="Largeur de la signature posée">
                  Taille
                  <input type="range" min={60} max={360} step={10} value={opts.sigWidth ?? 160} onChange={(e) => { localStorage.setItem('nova:sig-width', e.target.value); setOpts({ ...opts, sigWidth: +e.target.value }); }} />
                  <output>{Math.round(((opts.sigWidth ?? 160) * 25.4) / 72)} mm</output>
                </label>
                <label className="check" title="Ajoute « Signé le … à … » sous la signature, à l'heure exacte de la pose">
                  <input
                    type="checkbox"
                    checked={!!opts.sigDate}
                    onChange={(e) => {
                      localStorage.setItem('nova:sig-date', e.target.checked ? '1' : '0');
                      setOpts({ ...opts, sigDate: e.target.checked });
                    }}
                  />
                  Date et heure sous la signature
                </label>
                {opts.sigDate && (
                  <input
                    className="stamp-author"
                    placeholder="Nom du signataire (facultatif)"
                    value={opts.stampAuthor}
                    onChange={(e) => {
                      localStorage.setItem('nova:stamp-author', e.target.value);
                      setOpts({ ...opts, stampAuthor: e.target.value });
                    }}
                  />
                )}
              </div>
            )}
            {tool === 'stamp' && (
              <div className="tool-opts">
                <select
                  onChange={(e) => {
                    const pr = STAMP_PRESETS[+e.target.value];
                    setOpts({ ...opts, stamp: makeStamp(pr.label, pr.color, opts.stampDate, opts.stampAuthor), stampSpec: pr });
                  }}
                  title="Tampon"
                >
                  {STAMP_PRESETS.map((p, i) => (
                    <option key={p.label} value={i}>{p.label}</option>
                  ))}
                </select>
                <button
                  onClick={async () => {
                    const t = await ui.prompt('Texte du tampon personnalisé :');
                    if (!t) return;
                    const spec = { label: t.toUpperCase(), color: opts.color === '#ffeb3b' ? '#3d52d5' : opts.color };
                    setOpts({ ...opts, stamp: makeStamp(spec.label, spec.color, opts.stampDate, opts.stampAuthor), stampSpec: spec });
                  }}
                >
                  Personnalisé…
                </button>
                <label className="size-opt" title="Largeur du tampon posé">
                  Taille
                  <input type="range" min={80} max={360} step={10} value={opts.stampWidth ?? 170} onChange={(e) => { localStorage.setItem('nova:stamp-width', e.target.value); setOpts({ ...opts, stampWidth: +e.target.value }); }} />
                  <output>{Math.round(((opts.stampWidth ?? 170) * 25.4) / 72)} mm</output>
                </label>
                <select
                  value={opts.stampDate}
                  title="Date sur le tampon (mise à jour à chaque pose)"
                  onChange={(e) => {
                    const m = e.target.value as 'none' | 'date' | 'datetime';
                    localStorage.setItem('nova:stamp-date', m);
                    const sp = opts.stampSpec ?? STAMP_PRESETS[0];
                    setOpts({ ...opts, stampDate: m, stamp: makeStamp(sp.label, sp.color, m, opts.stampAuthor) });
                  }}
                >
                  <option value="none">Sans date</option>
                  <option value="date">Date</option>
                  <option value="datetime">Date et heure</option>
                </select>
                <input
                  className="stamp-author"
                  placeholder="Nom (facultatif)"
                  value={opts.stampAuthor}
                  onChange={(e) => {
                    localStorage.setItem('nova:stamp-author', e.target.value);
                    const sp = opts.stampSpec ?? STAMP_PRESETS[0];
                    setOpts({ ...opts, stampAuthor: e.target.value, stamp: makeStamp(sp.label, sp.color, opts.stampDate, e.target.value) });
                  }}
                />
                {opts.stamp && <img src={opts.stamp} alt="" className="stamp-preview" />}
              </div>
            )}
            {tool === 'field' && (
              <div className="tool-opts">
                <select value={opts.fieldType} onChange={(e) => setOpts({ ...opts, fieldType: e.target.value as 'text' | 'checkbox' })}>
                  <option value="text">Champ texte</option>
                  <option value="checkbox">Case à cocher</option>
                </select>
              </div>
            )}
          </>
        )}
        <span className="spacer" />
        {speechSupported() && (
          <button className={`icon ${voiceOn ? 'active rec' : ''}`} onClick={toggleVoice} title="Commandes vocales : « page suivante », « page 12 », « cherche … », « note … »">
            <Icon name="mic" />
          </button>
        )}
        {voiceHeard && <span className="voice-heard">« {voiceHeard} »</span>}
        {nativeUpdate && (
          <button
            className="primary"
            title={`Installer Nova PDF ${nativeUpdate.version} et redémarrer`}
            onClick={() => {
              notify(`Installation de la version ${nativeUpdate.version}…`);
              nativeUpdate.install(() => {}).catch((e) => notify(`Échec de la mise à jour : ${(e as Error).message}`));
            }}
          >
            ↻ Mettre à jour ({nativeUpdate.version})
          </button>
        )}
        {updateReady && (
          <button className="primary" onClick={applyAppUpdate} title="Une nouvelle version est prête">
            ↻ Mettre à jour
          </button>
        )}
        <button className="icon" onClick={() => setSettings({ ...settings, theme: dark ? 'light' : 'dark' })} title="Thème clair / sombre">
          <Icon name={dark ? 'sun' : 'moon'} />
        </button>
      </header>

      {docs.length > 0 && (
        <nav
          className="tabs"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(TAB_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            const token = e.dataTransfer.getData(TAB_MIME);
            if (!token) return;
            e.preventDefault();
            if (dragTab.current?.token === token) {
              // lâché dans sa propre fenêtre : on le place en dernier
              dragTab.current.handled = true;
              const id = dragTab.current.id;
              setDocs((l) => [...l.filter((x) => x.id !== id), ...l.filter((x) => x.id === id)]);
              return;
            }
            receiveTab(token); // onglet venu d'une autre fenêtre
          }}
        >
          {docs.map((d) => (
            <div
              key={d.id}
              className={`tab ${d.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(d.id)}
              onContextMenu={(e) => onTabMenu(e, d.id)}
              title={canMultiWindow ? `${d.name} — faites glisser l’onglet hors de la fenêtre pour l’ouvrir dans une nouvelle fenêtre` : d.name}
              draggable={canMultiWindow}
              onDragStart={(e) => {
                const token = newToken();
                dragTab.current = { id: d.id, token, handled: false };
                stashDoc(transferOf(d), token);
                e.dataTransfer.setData(TAB_MIME, token);
                e.dataTransfer.setData('text/plain', d.name);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (dragTab.current && e.dataTransfer.types.includes(TAB_MIME)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(e) => {
                const dt = dragTab.current;
                if (!dt || e.dataTransfer.getData(TAB_MIME) !== dt.token) return;
                // réordonner les onglets dans la même fenêtre
                e.preventDefault();
                e.stopPropagation();
                dt.handled = true;
                if (dt.id === d.id) return;
                setDocs((l) => {
                  const moving = l.find((x) => x.id === dt.id)!;
                  const rest = l.filter((x) => x.id !== dt.id);
                  const at = rest.findIndex((x) => x.id === d.id);
                  return [...rest.slice(0, at), moving, ...rest.slice(at)];
                });
              }}
              onDragEnd={(e) => {
                const dt = dragTab.current;
                dragTab.current = null;
                if (!dt) return;
                if (dt.handled) return void dropStash(dt.token);
                const outside = droppedOutside(e);
                const pos = { x: e.screenX, y: e.screenY };
                const moved = e.dataTransfer.dropEffect === 'move';
                // déposé sur la barre d'onglets d'une autre fenêtre de Nova PDF ?
                wasTaken(dt.token, moved || outside ? 900 : 300).then((taken) => {
                  if (taken) return void moveAway(dt.id);
                  // lâché hors de la fenêtre : nouvelle fenêtre à cet endroit (ex. sur le 2e écran)
                  if (outside) return void toNewWindow(dt.id, { move: true, ...pos, token: dt.token });
                  dropStash(dt.token);
                });
              }}
            >
              <span>{d.dirty ? '● ' : ''}{d.name}</span>
              <button
                className="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  closeDoc(d.id);
                }}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="tab-add"
            onClick={openDialog}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: 'Ouvrir un PDF dans un onglet…', icon: 'open', action: openDialog },
                  ...(canMultiWindow ? [{ label: 'Nouvelle fenêtre', icon: 'split' as IconName, action: () => openWindow({}) }] : []),
                ],
              });
            }}
            title={canMultiWindow ? 'Ouvrir un autre PDF (clic droit : nouvelle fenêtre)' : 'Ouvrir un autre PDF'}
          >
            +
          </button>
        </nav>
      )}

      <main className="main">
        {doc && sidebar && !workspace && (
          <Sidebar
            doc={doc.pdf}
            numPages={doc.sizes.length}
            current={page}
            outline={doc.outline}
            texts={doc.texts}
            annotations={doc.annotations}
            query={query}
            setQuery={setQuery}
            goTo={(pg: number) => { goTo(pg); if (window.innerWidth <= 760) setSidebar(false); }}
            onDelete={onDelete}
            tab={sideTab}
            setTab={setSideTab}
            onThumbMenu={onThumbMenu}
            pageActions={{
              reorder: reorderTo,
              remove: deletePages,
              rotate: rotatePages,
              duplicate: duplicatePages,
              insert: (at, kind) => (kind === 'blank' ? insertBlank(at - 1) : insertFrom(at, kind)),
              organize: () => setWorkspace('organize'),
            }}
          />
        )}

        <section className="center">
          {doc && ctx && workspace ? (
            <Workspace kind={workspace} ctx={ctx} onClose={() => setWorkspace(null)} />
          ) : doc ? (
            <>
              <div className="viewbar">
                <button
                  className="icon"
                  onClick={() => {
                    if (focus) {
                      setFocus(false);
                      setSidebar(true);
                    } else setSidebar(!sidebar);
                  }}
                  title="Panneau latéral"
                >
                  <Icon name="sidebar" />
                </button>
                <button className="icon" disabled={page === 0} onClick={() => goTo(page - 1)} title="Page précédente (←)"><Icon name="back" /></button>
                <PageInput page={page} total={doc.sizes.length} onGo={goTo} />
                <button className="icon" disabled={page >= doc.sizes.length - 1} onClick={() => goTo(page + 1)} title="Page suivante (→)"><Icon name="next" /></button>
                <span className="sep" />
                <button className={`icon ${night ? 'active' : ''}`} onClick={() => setNight(!night)} title="Mode nuit (inverse les couleurs des pages)"><Icon name="night" /></button>
                <button className="icon" onClick={() => setFocus(!focus)} title="Mode concentration (Ctrl+Maj+F)"><Icon name="focus" /></button>
                <button className="icon" onClick={() => setPresenting(true)} title="Présenter (plein écran, pointeur laser)"><Icon name="present" /></button>
                <button className="icon" disabled={!doc.texts} onClick={() => setTranslating(true)} title="Traduction côte à côte"><Icon name="translate" /></button>
                <button className={`icon ${settings.readingRuler ? 'active' : ''}`} onClick={() => setSettings({ ...settings, readingRuler: !settings.readingRuler })} title="Règle de lecture"><Icon name="ruler" /></button>
                {doc.review && <span className="ok-badge">● relecture partagée</span>}
              </div>
              <div
                className="viewer-host"
                onContextMenu={onViewerMenu}
                onPointerDown={(e) => {
                  if (e.button === 0 || e.button === 2) pointerStart.current = [e.clientX, e.clientY];
                }}
                onPointerUp={(e) => {
                  const s0 = pointerStart.current;
                  pointerStart.current = null;
                  if (!s0 || Math.hypot(e.clientX - s0[0], e.clientY - s0[1]) > 4) return; // glissement / sélection
                  if (window.getSelection()?.toString()) return; // une sélection est en cours : on la garde
                  const t = e.target as HTMLElement;
                  if (t.closest('input, textarea, select, [contenteditable], .text-edit-box, .ann-editor, .color-pop')) return;
                  // clic gauche ou droit au milieu : on referme les panneaux latéraux (droite ET gauche)
                  closeSidePanels();
                  setBarsHidden(false); // un toucher fait réapparaître les barres masquées
                }}
              >
              <Viewer
                ref={viewer}
                onZoomBy={zoom}
                onDoubleTap={() => {
                  if (!touchRef.current.doubleTapZoom) return null;
                  if (fit === 'width' || fit === 'page') return 2.2; // zoom sur l'endroit touché
                  setFit('width'); // déjà zoomé : retour à la pleine largeur
                  return null;
                }}
                doc={doc.pdf}
                docKey={`${doc.id}-${doc.version}`}
                sizes={doc.sizes}
                scale={scale}
                layout={layout}
                tool={tool}
                opts={opts}
                annotations={doc.annotations}
                searchQuery={sideTab === 'search' ? query : ''}
                signature={signature}
                night={night}
                onAdd={onAdd}
                onDelete={onDelete}
                onUpdate={onUpdate}
                onPageChange={setPage}
                refs={refs}
                ruler={settings.readingRuler}
              />
              </div>
            </>
          ) : (
            <Welcome
              onOpen={openDialog}
              onDemo={async () => void (await loadInto(await makeDemoPdf(), 'demo-nova-pdf.pdf'))}
              onScan={() => setScanning(true)}
              onLibrary={(id) => (id ? openFromLibrary(id) : setPanel('library'))}
              onItemMenu={libItemMenu}
              onStudy={async () => {
                const d = (await allDecks()).find((x) => dueCards(x).length);
                if (!d) return;
                await openFromLibrary(d.fingerprint);
                setPanel('study');
              }}
            />
          )}
        </section>

        {(() => {
          const showAside = !!panel && !workspace && (panel === 'settings' || panel === 'library' || panel === 'share' || !!(doc && ctx));
          if (!showAside && !(doc && (kept.ai || kept.study || kept.reading))) return null;
          return (
          <aside className={`right ${showAside ? '' : 'bg-hidden'}`} aria-hidden={!showAside}>
            {panel === 'settings' && (
              <SettingsPanel
                doc={doc ? { name: doc.name, size: doc.bytes.length, pdf: doc.pdf, currentPage: page, pageSize: doc.sizes[page], encrypted: doc.encrypted } : null}
                settings={settings}
                setSettings={setSettings}
                notify={notify}
              />
            )}
            {panel === 'library' && <LibraryPanel onOpen={openFromLibrary} onImport={openDialog} activeId={doc?.fingerprint} onItemMenu={libItemMenu} ollamaUrl={ai.ollamaUrl} />}
            {panel === 'share' && (
              <SharePanel
                ctx={ctx}
                fingerprint={doc?.fingerprint}
                annotations={doc?.annotations ?? []}
                pickSignature={pickSignature}
                onSignatureFieldTool={(signer) => {
                  setOpts({ ...opts, fieldType: 'signature', signer });
                  setTool('field');
                  notify(`Dessinez sur la page le cadre où ${signer} signera.`);
                }}
              />
            )}
            {doc && (panel === 'study' || kept.study) && (
              <div className="keep" hidden={panel !== 'study'}><StudyPanel key={doc.id} fingerprint={doc.fingerprint} docName={doc.name} texts={doc.texts} currentPage={page} annotations={doc.annotations} ai={ai} goTo={goTo} /></div>
            )}
            {doc && panel === 'notes' && (
              <NotesPanel fingerprint={doc.fingerprint} docName={doc.name} currentPage={page} annotations={doc.annotations} goTo={goTo} />
            )}
            {doc && (panel === 'ai' || kept.ai) && (
              <div className="keep" hidden={panel !== 'ai'}><AIPanel key={doc.id}
                texts={doc.texts}
                currentPage={page}
                annotations={doc.annotations}
                settings={ai}
                setSettings={setAi}
                goTo={goTo}
                onToNotes={async (text) => {
                  await appendNote(doc.fingerprint, doc.name, `### ✦ Assistant IA — p. ${page + 1}\n${text}`);
                  notify('Ajouté à vos notes.');
                }}
                corpus={corpus}
                openAt={(id, p) => openFromLibrary(id, p)}
                chapters={doc.outline.filter((o) => o.page != null).map((o) => ({ title: o.title, page: o.page! }))}
              /></div>
            )}
            {ctx && panel === 'tools' && <ToolsPanel ctx={ctx} />}
            {ctx && panel === 'organize' && <OrganizePanel ctx={ctx} />}
            {ctx && panel === 'form' && <FormPanel ctx={ctx} />}
            {doc && (panel === 'reading' || kept.reading) && (
              <div className="keep" hidden={panel !== 'reading'}><ReadingPanel key={doc.id}
                texts={doc.texts}
                currentPage={page}
                goTo={goTo}
                ai={ai}
                docName={doc.name}
                onToNotes={(t) => appendNote(doc.fingerprint, doc.name, `### 🎧 Podcast\n${t}`).then(() => notify('Script ajouté à vos notes.'))}
                onTranslate={() => setTranslating(true)}
                onPresent={() => setPresenting(true)}
                dyslexia={settings.dyslexia}
                ruler={settings.readingRuler}
                setDyslexia={(v) => setSettings({ ...settings, dyslexia: v })}
                setRuler={(v) => setSettings({ ...settings, readingRuler: v })}
              /></div>
            )}
          </aside>
          );
        })()}

        <nav className="rail" aria-label="Panneaux">
          {(
            [
              ['library', 'Biblio', false],
              ['ai', 'IA', true],
              ['notes', 'Notes', true],
              ['study', 'Étude', true],
              ['reading', 'Lecture', true],
              ['form', 'Formulaire', true],
              ['organize', 'Pages', true],
              ['tools', 'Outils', true],
              ['share', 'Partager', false],
              ['settings', 'Infos', false],
            ] as [Panel, string, boolean][]
          ).map(([id, label, needsDoc]) => (
            <button
              key={id}
              className={(id === 'organize' ? workspace === 'organize' : panel === id) ? 'active' : ''}
              disabled={needsDoc && !doc}
              onClick={() => {
                if (focus) setFocus(false);
                if (id === 'organize') return setWorkspace(workspace === 'organize' ? null : 'organize');
                if (workspace) {
                  setWorkspace(null);
                  return setPanel(id);
                }
                setPanel(panel === id ? null : id);
              }}
              title={id === 'settings' ? 'Infos, paramètres et mises à jour' : label}
            >
              <span className="rail-ico"><Icon name={id as IconName} size={20} /></span>
              <small>{label}</small>
              {id === 'settings' && (updateReady || nativeUpdate) && <i className="dot" />}
            </button>
          ))}
        </nav>
      </main>

      <footer className="statusbar">
        {aiRunning.length > 0 && (
          <span className="sb-item ai-running">
            <span className="spin" /> IA : {aiRunning.join(', ')}
            <button className="stop-btn small" onClick={stopAllAi} title="Arrêter toutes les tâches d’IA">⏹ Arrêter</button>
          </span>
        )}
        {doc ? (
          <>
            <span className="sb-item" title={doc.name}>
              <Icon name="file" size={13} /> Page {page + 1} sur {doc.sizes.length}
            </span>
            <span className="sb-item muted">
              {doc.sizes[page] ? `${Math.round((doc.sizes[page].w / 72) * 25.4)} × ${Math.round((doc.sizes[page].h / 72) * 25.4)} mm` : ''}
            </span>
            {doc.annotations.length > 0 && <span className="sb-item muted">{doc.annotations.length} annotation(s)</span>}
            {doc.dirty && <span className="sb-item warn-dot">● Modifications non enregistrées</span>}
            {doc.review && <span className="sb-item ok-badge">● Relecture partagée</span>}
            <span className="spacer" />
            <div className="seg sb-seg" role="group" aria-label="Disposition">
              <button className={layout === 'single' ? 'active' : ''} onClick={() => setLayout('single')} title="Une page"><Icon name="pages" size={14} /></button>
              <button className={layout === 'double' ? 'active' : ''} onClick={() => setLayout('double')} title="Deux pages"><Icon name="grid" size={14} /></button>
            </div>
            <div className="seg sb-seg" role="group" aria-label="Ajustement">
              <button className={fit === 'width' ? 'active' : ''} onClick={() => setFit('width')} title="Pleine largeur (Ctrl+0)">Largeur</button>
              <button className={fit === 'page' ? 'active' : ''} onClick={() => setFit('page')} title="Page entière">Page</button>
            </div>
            <button className="icon sb-btn" onClick={() => zoom(1 / 1.15)} title="Zoom arrière (Ctrl −)"><Icon name="zoomOut" size={14} /></button>
            <input
              className="zoom-slider"
              type="range"
              min={25}
              max={400}
              step={5}
              value={Math.round(scale * 100)}
              onChange={(e) => {
                setFit(null);
                setScale(+e.target.value / 100);
              }}
              aria-label="Zoom"
            />
            <button className="icon sb-btn" onClick={() => zoom(1.15)} title="Zoom avant (Ctrl +)"><Icon name="zoomIn" size={14} /></button>
            <button className="sb-zoom" onClick={() => { setFit(null); setScale(1); }} title="Taille réelle (100 %)">{Math.round(scale * 100)} %</button>
          </>
        ) : (
          <>
            <span className="sb-item muted">Nova PDF {APP_VERSION}</span>
            <span className="spacer" />
            <span className="sb-item muted">🔒 Tout reste sur cet appareil</span>
          </>
        )}
      </footer>

      {sigModal && (
        <SignatureModal
          onClose={() => {
            setSigModal(false);
            sigResolver.current?.(null);
            sigResolver.current = null;
          }}
          onPick={(s) => {
            setSignature(s);
            setSigModal(false);
            if (sigResolver.current) {
              sigResolver.current(s);
              sigResolver.current = null;
              return;
            }
            setTool('signature');
            notify('Cliquez sur la page pour placer la signature.');
          }}
        />
      )}
      {presenting && doc && (
        <Presentation
          pdf={doc.pdf}
          start={page}
          bytes={doc.bytes}
          fingerprint={doc.fingerprint}
          annotations={doc.annotations}
          onExit={(p) => {
            setPresenting(false);
            setTimeout(() => goTo(p), 100);
          }}
        />
      )}
      {imgExport && doc && (
        <ImageExport
          pdf={doc.pdf}
          name={doc.name}
          currentPage={page}
          getBytes={getBytes}
          hasAnnotations={doc.annotations.length > 0}
          zone={imgExport.zone}
          notify={notify}
          onClose={() => setImgExport(null)}
        />
      )}
      {comparing && doc && (
        <CompareView a={doc.pdf} b={comparing.pdf} nameA={doc.name} nameB={comparing.name} onClose={() => setComparing(null)} />
      )}
      {translating && doc?.texts && (
        <TranslateView pdf={doc.pdf} texts={doc.texts} ai={ai} fingerprint={doc.fingerprint} name={doc.name} startPage={page} onClose={() => setTranslating(false)} />
      )}
      {scanning && (
        <ScanModal
          onClose={() => setScanning(false)}
          onDone={async (bytes) => {
            const cb = scanning;
            setScanning(false);
            if (typeof cb === 'function') return cb(bytes); // scan inséré dans un document
            await loadInto(bytes, `scan-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pdf`);
            notify('Scan créé. Lancez l’OCR (Outils) pour le rendre cherchable.');
          }}
        />
      )}
      {focus && (
        <button className="focus-exit" onClick={() => setFocus(false)} title="Quitter le mode concentration (Échap)">
          <Icon name="close" size={14} /> Quitter le mode concentration
        </button>
      )}
      {doc && !workspace && touchPrefs.toolSheet && (
        <button
          className={`fab ${tool !== 'select' ? 'active' : ''}`}
          onClick={() => setToolSheet(true)}
          aria-label="Outils d'annotation"
          title="Outils"
        >
          <Icon name={(tool === 'select' ? 'ink' : tool) as IconName} size={24} />
        </button>
      )}
      {doc && tool !== 'select' && touchPrefs.toolSheet && !workspace && (
        <button className="fab-stop" onClick={() => setTool('select')} aria-label="Revenir à la lecture">✕ {TOOLS.find((t) => t.id === tool)?.label.split(' (')[0]}</button>
      )}
      {toolSheet && (
        <div className="sheet-backdrop" onClick={() => setToolSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Outils">
            <div className="sheet-grip" />
            <div className="sheet-grid">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={`sheet-tool ${tool === t.id ? 'active' : ''}`}
                  onClick={() => {
                    pickTool(t.id);
                    setToolSheet(false);
                  }}
                >
                  <span className="sheet-ico"><Icon name={t.id as IconName} size={24} /></span>
                  <small>{SHORT_LABEL[t.id] ?? t.label.split(' (')[0]}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {doc && touchPrefs.swipePanels && !sidebar && !panel && !workspace && (
        <>
          <button className="edge-hint left" aria-label="Ouvrir le panneau de gauche" onClick={() => setSidebar(true)} />
          <button className="edge-hint right" aria-label="Ouvrir le panneau de droite" onClick={() => setPanel(lastRightPanel.current ?? 'tools')} />
        </>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {inspect && doc && (() => {
        const ann = doc.annotations.find((a) => a.id === inspect.id);
        if (!ann) return null;
        return (
          <AnnInspector
            ann={ann}
            pos={inspect}
            onChange={(n) => setAnns((l) => l.map((a) => (a.id === n.id ? n : a)))}
            onDelete={() => onDelete(ann.id)}
            onDuplicate={() => {
              const off = (r?: { x: number; y: number; w: number; h: number }) => r && { ...r, x: r.x + 12, y: r.y + 12 };
              const copy: Annotation = { ...ann, id: crypto.randomUUID(), createdAt: Date.now(), rect: off(ann.rect), rects: ann.rects?.map((r) => off(r)!), points: ann.points?.map(([x, y]) => [x + 12, y + 12] as [number, number]) };
              setAnns((l) => [...l, copy]);
              setInspect({ ...inspect, id: copy.id });
            }}
            onFront={() => setAnns((l) => [...l.filter((a) => a.id !== ann.id), ann])}
            onClose={() => setInspect(null)}
          />
        );
      })()}
      <DialogHost />
      {dragOver && <div className="drop-overlay">Déposez vos PDF ici</div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Welcome({
  onOpen, onDemo, onScan, onLibrary, onStudy, onItemMenu,
}: {
  onItemMenu: (e: React.MouseEvent, item: LibItem) => void;
  onOpen: () => void;
  onDemo: () => void;
  onScan: () => void;
  onLibrary: (id?: string) => void;
  onStudy: () => void;
}) {
  const [recent, setRecent] = useState<LibItem[]>([]);
  const [due, setDue] = useState(0);
  useEffect(() => {
    const load = () => listLibrary().then((l) => setRecent(l.slice(0, 6)));
    load();
    window.addEventListener('nova:library-changed', load);
    allDecks().then((ds) => setDue(ds.reduce((n, d) => n + dueCards(d).length, 0)));
    return () => window.removeEventListener('nova:library-changed', load);
  }, []);
  return (
    <div className="welcome">
      <div className="hero">
        <img className="logo-big" src="./icon.svg" alt="Logo Nova PDF (chat)" />
        <h1>Nova PDF</h1>
        <p>Le lecteur PDF libre, rapide et privé, avec une IA qui tourne sur votre appareil.</p>
        <div className="row center">
          <button className="primary big" onClick={onOpen}>
            Ouvrir un PDF
          </button>
          <button className="big" onClick={onScan}>
            📷 Scanner
          </button>
          <button className="big" onClick={onDemo}>
            Essayer avec un exemple
          </button>
        </div>
        <p className="muted">ou glissez-déposez vos fichiers n'importe où dans la fenêtre</p>
      </div>
      {(recent.length > 0 || due > 0) && (
        <div className="recent">
          {due > 0 && (
            <button className="due-banner" onClick={onStudy}>
              🎓 {due} fiche(s) à réviser aujourd'hui
            </button>
          )}
          {recent.length > 0 && (
            <>
              <div className="row">
                <b>Récemment ouverts</b>
                <button className="link" onClick={() => onLibrary()}>Toute la bibliothèque →</button>
              </div>
              <div className="recent-grid">
                {recent.map((r) => (
                  <button key={r.id} onClick={() => onLibrary(r.id)} onContextMenu={(e) => onItemMenu(e, r)} title={`${r.name} — clic droit pour plus d'options`}>
                    <span>📄</span>
                    <b>{r.name}</b>
                    <small>{r.pages} p. · {new Date(r.openedAt).toLocaleDateString('fr-FR')}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div className="features">
        {[
          ['Lire', 'Miniatures, sommaire, recherche, mode nuit, deux pages, aperçu des liens au survol, mode lecture et lecture à voix haute.'],
          ['Annoter', 'Surligner, souligner, barrer, dessiner, formes, flèches, textes, notes. Annuler/rétablir. Carnet de toutes vos notes.'],
          ['Signer et remplir', 'Formulaires interactifs, signature dessinée, écrite ou importée, mémorisée sur l’appareil.'],
          ['Organiser', 'Réordonner, pivoter, dupliquer, supprimer, insérer, fusionner, découper, extraire des pages.'],
          ['Transformer', 'Filigrane, numérotation, OCR local, export PNG/JPG/TXT/Markdown, images vers PDF, comparaison de versions.'],
          ['IA locale', 'Résumé, questions avec pages citées, explication, traduction, fiches de révision, sans rien envoyer en ligne.'],
        ].map(([t, d]) => (
          <div key={t} className="feature">
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </div>
      {!isNative && (
        <div className="get-apps">
          <span className="muted">Aussi disponible en application :</span>
          {['Windows', 'macOS', 'Linux', 'Android', 'iPhone'].map((p) => (
            <a key={p} href="https://github.com/Geld237/nova-pdf/releases/latest" target="_blank" rel="noreferrer">
              {p}
            </a>
          ))}
        </div>
      )}
      <p className="muted small">100 % local · Open source (MIT) · Installable comme application</p>
    </div>
  );
}

/** Champ « page » : on peut taper librement, la page s'ouvre à Entrée ou en quittant le champ. */
const SHORT_LABEL: Partial<Record<string, string>> = {
  select: 'Lecture', edittext: 'Éditer texte', move: 'Déplacer', field: 'Champ', ink: 'Dessin',
  eraser: 'Gomme', snapshot: 'Capture', whiteout: 'Correcteur', redact: 'Caviarder', image: 'Image',
};

function PageInput({ page, total, onGo }: { page: number; total: number; onGo: (p: number) => void }) {
  const [v, setV] = useState(String(page + 1));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setV(String(page + 1));
  }, [page, editing]);
  const commit = () => {
    const n = parseInt(v, 10);
    if (n >= 1 && n <= total) onGo(n - 1);
    else setV(String(page + 1));
    setEditing(false);
  };
  return (
    <span className="pager">
      <input
        aria-label="Numéro de page"
        inputMode="numeric"
        value={v}
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setV(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(String(page + 1));
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="muted">/ {total}</span>
    </span>
  );
}
