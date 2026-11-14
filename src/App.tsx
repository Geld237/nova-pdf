import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractAllText, getOutline, openPdfWithPassword, type PDFDocumentProxy } from './pdf/engine';
import { unlockPdf } from './pdf/security';
import { isNative, isTauri, listenOpenedFiles, nativeOpenPdfs, saveFile, writeNativeFile } from './platform';
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
import { DEFAULT_AI, type AiSettings } from './ai/llm';
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
import { ContextMenu, type MenuItem, type MenuState } from './components/ContextMenu';
import { Workspace, type WorkspaceKind } from './components/Workspace';
import { DialogHost, ui } from './dialogs';
import { download, extractPages, reorderPages, baseName } from './pdf/tools';
import { renderPageToCanvas, canvasToBlob } from './pdf/engine';
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
    fieldType: 'text',
    measureRatio: 1,
    measureUnit: 'cm',
    stamp: null,
    image: null,
    signer: '',
  }));
  const [presenting, setPresenting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceHeard, setVoiceHeard] = useState('');
  const stopVoice = useRef<(() => void) | null>(null);
  const sigResolver = useRef<((s: string | null) => void) | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const pointerStart = useRef<[number, number] | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceKind | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [sigModal, setSigModal] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [sideTab, setSideTab] = useState<SideTab>('pages');
  const [panel, setPanel] = useState<Panel>(null);
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

  const patchDoc = useCallback((id: string, patch: Partial<DocState> | ((d: DocState) => Partial<DocState>)) => {
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d)));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dyslexic', !!settings.dyslexia);
  }, [dark, settings.dyslexia]);
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
          bytes, pdf, sizes, outline, texts: null, version: d.version + 1, annotations: [], undo: [], redo: [], dirty: true,
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
    input.click();
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
    const cw = viewer.current.containerWidth() - 48;
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

  const closeDoc = async (id: string) => {
    const d = docsRef.current.find((x) => x.id === id);
    if (d?.dirty && settings.confirmClose && !(await ui.confirm(`« ${d.name} » a des modifications non enregistrées (les annotations restent mémorisées). Fermer quand même ?`, { ok: 'Fermer' }))) return;
    d?.pdf.cleanup().catch(() => {});
    const rest = docsRef.current.filter((x) => x.id !== id);
    setDocs(rest);
    setActiveId((cur) => (cur === id ? rest[rest.length - 1]?.id ?? null : cur));
  };

  const goTo = useCallback((p: number) => viewer.current?.scrollToPage(p), []);

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
        openNew: (bytes, name) => void loadInto(bytes, name),
        notify,
        outline: doc.outline,
        ocrLang: settings.ocrLang,
        ai,
        addAnnotations,
        getBytesRaw: async () => doc.bytes,
        markReview: () => patchDoc(doc.id, { review: true }),
        startScan: () => setScanning(true),
        openPanel: (p) => setPanel(p),
        openWorkspace: (k) => setWorkspace(k),
        selectTool: (t) => pickTool(t),
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
  const pageOp = async (label: string, fn: (bytes: Uint8Array, n: number) => Promise<Uint8Array>) => {
    if (!ctx || !doc) return;
    try {
      await ctx.replace(await fn(await ctx.getBytes(), doc.sizes.length), label);
    } catch (e) {
      notify(`Erreur : ${(e as Error).message}`);
    }
  };
  const order = (n: number) => Array.from({ length: n }, (_, i) => ({ src: i, rotate: 0 }));
  const rotatePage = (i: number, deg: number) =>
    pageOp(`Page ${i + 1} pivotée`, (b, n) => reorderPages(b, order(n).map((o) => (o.src === i ? { ...o, rotate: deg } : o))));
  const deletePage = async (i: number) => {
    if (!doc || doc.sizes.length < 2) return notify('Impossible de supprimer la seule page.');
    if (!(await ui.confirm(`Supprimer la page ${i + 1} ?`, { ok: 'Supprimer', danger: true }))) return;
    pageOp(`Page ${i + 1} supprimée`, (b, n) => reorderPages(b, order(n).filter((o) => o.src !== i)));
  };
  const insertBlank = (i: number) =>
    pageOp('Page blanche insérée', (b, n) => {
      const o = order(n);
      o.splice(i + 1, 0, { src: -1, rotate: 0 });
      return reorderPages(b, o);
    });
  const duplicatePage = (i: number) =>
    pageOp(`Page ${i + 1} dupliquée`, (b, n) => {
      const o = order(n);
      o.splice(i + 1, 0, { src: i, rotate: 0 });
      return reorderPages(b, o);
    });
  const extractPage = async (i: number) => doc && ctx && download(await extractPages(await ctx.getBytes(), [i]), `${baseName(doc.name)}-p${i + 1}.pdf`);
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

  const pageMenuItems = (i: number): MenuItem[] => [
    { header: `Page ${i + 1}` },
    { label: 'Pivoter à droite', icon: 'rotateCw', action: () => rotatePage(i, 90) },
    { label: 'Pivoter à gauche', icon: 'rotateCcw', action: () => rotatePage(i, -90) },
    { label: 'Dupliquer la page', icon: 'copy', action: () => duplicatePage(i) },
    { label: 'Insérer une page blanche après', icon: 'create', action: () => insertBlank(i) },
    { label: 'Extraire en PDF', icon: 'extract', action: () => extractPage(i) },
    { label: 'Exporter en image', icon: 'picture', action: () => exportPage(i) },
    { label: 'Copier le texte de la page', icon: 'file', disabled: !doc?.texts, action: () => navigator.clipboard?.writeText(doc?.texts?.[i]?.text ?? '') },
    { label: 'Lire la page à voix haute', icon: 'speak', disabled: !doc?.texts, action: () => speak(doc?.texts?.[i]?.text ?? '') },
    'sep',
    { label: 'Supprimer la page', icon: 'trash', danger: true, action: () => deletePage(i) },
  ];

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
          ...(['highlight', 'underline', 'strike', 'ink', 'rect', 'ellipse', 'arrow', 'text'].includes(hit.kind)
            ? ['#ffeb3b', '#8bc34a', '#4fc3f7', '#f48fb1', '#e53935'].map((c) => ({
                label: { '#ffeb3b': 'Jaune', '#8bc34a': 'Vert', '#4fc3f7': 'Bleu', '#f48fb1': 'Rose', '#e53935': 'Rouge' }[c]!,
                icon: 'palette' as IconName,
                action: () => setAnns((l) => l.map((a) => (a.id === hit.id ? { ...a, color: c } : a))),
              }))
            : []),
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

  const onThumbMenu = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: [{ label: 'Aller à la page', icon: 'pages', action: () => goTo(i) }, 'sep', ...pageMenuItems(i)] });
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
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
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
      i.accept = 'image/png,image/jpeg';
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
      i.click();
      return;
    }
    if (t === 'edittext') notify('Cliquez sur une ligne du document pour la modifier. Entrée pour valider.');
    if (t === 'stamp' && !opts.stamp) setOpts({ ...opts, stamp: makeStamp(STAMP_PRESETS[0].label, STAMP_PRESETS[0].color) });
    setTool(t);
    if (t === 'highlight' && ['#e53935', '#3949ab', '#212121'].includes(opts.color)) setOpts({ ...opts, color: '#ffeb3b' });
  };

  const showColor = !['select', 'eraser', 'signature', 'redact', 'whiteout', 'stamp', 'field', 'edittext', 'image', 'move'].includes(tool);

  return (
    <div
      className={`app ${focus ? 'focus' : ''}`}
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
                {['ink', 'rect', 'ellipse', 'arrow'].includes(tool) && (
                  <input type="range" min={1} max={12} value={opts.strokeWidth} onChange={(e) => setOpts({ ...opts, strokeWidth: +e.target.value })} title="Épaisseur" />
                )}
                {tool === 'text' && (
                  <input type="number" min={6} max={72} value={opts.fontSize} onChange={(e) => setOpts({ ...opts, fontSize: +e.target.value })} title="Taille du texte" />
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
            {tool === 'stamp' && (
              <div className="tool-opts">
                <select
                  onChange={(e) => {
                    const pr = STAMP_PRESETS[+e.target.value];
                    setOpts({ ...opts, stamp: makeStamp(pr.label, pr.color) });
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
                    if (t) setOpts({ ...opts, stamp: makeStamp(t.toUpperCase(), opts.color === '#ffeb3b' ? '#3d52d5' : opts.color) });
                  }}
                >
                  Personnalisé…
                </button>
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
        <nav className="tabs">
          {docs.map((d) => (
            <div key={d.id} className={`tab ${d.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(d.id)} onContextMenu={(e) => onTabMenu(e, d.id)} title={d.name}>
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
          <button className="tab-add" onClick={openDialog} title="Ouvrir un autre PDF">
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
            goTo={goTo}
            onDelete={onDelete}
            tab={sideTab}
            setTab={setSideTab}
            onThumbMenu={onThumbMenu}
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
                  if (e.button === 0) pointerStart.current = [e.clientX, e.clientY];
                }}
                onPointerUp={(e) => {
                  const s0 = pointerStart.current;
                  pointerStart.current = null;
                  if (!s0 || Math.hypot(e.clientX - s0[0], e.clientY - s0[1]) > 4) return; // glissement / sélection
                  if (window.getSelection()?.toString()) return;
                  if (tool !== 'select' && tool !== 'hand') return; // un outil d'annotation est en cours
                  // les panneaux « outils » se ferment ; ceux qu'on consulte en lisant (IA, notes, étude, lecture) restent
                  if (panel && ['tools', 'form', 'settings', 'library', 'share'].includes(panel)) setPanel(null);
                }}
              >
              <Viewer
                ref={viewer}
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

        {panel && !workspace && (panel === 'settings' || panel === 'library' || panel === 'share' || (doc && ctx)) && (
          <aside className="right">
            {panel === 'settings' && (
              <SettingsPanel
                doc={doc ? { name: doc.name, size: doc.bytes.length, pdf: doc.pdf, currentPage: page, pageSize: doc.sizes[page], encrypted: doc.encrypted } : null}
                settings={settings}
                setSettings={setSettings}
                notify={notify}
              />
            )}
            {panel === 'library' && <LibraryPanel onOpen={openFromLibrary} onImport={openDialog} activeId={doc?.fingerprint} onItemMenu={libItemMenu} />}
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
            {doc && panel === 'study' && (
              <StudyPanel fingerprint={doc.fingerprint} docName={doc.name} texts={doc.texts} currentPage={page} annotations={doc.annotations} ai={ai} goTo={goTo} />
            )}
            {doc && panel === 'notes' && (
              <NotesPanel fingerprint={doc.fingerprint} docName={doc.name} currentPage={page} annotations={doc.annotations} goTo={goTo} />
            )}
            {doc && panel === 'ai' && (
              <AIPanel
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
              />
            )}
            {ctx && panel === 'tools' && <ToolsPanel ctx={ctx} />}
            {ctx && panel === 'organize' && <OrganizePanel ctx={ctx} />}
            {ctx && panel === 'form' && <FormPanel ctx={ctx} />}
            {doc && panel === 'reading' && (
              <ReadingPanel
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
              />
            )}
          </aside>
        )}

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
          onExit={(p) => {
            setPresenting(false);
            setTimeout(() => goTo(p), 100);
          }}
        />
      )}
      {translating && doc?.texts && (
        <TranslateView pdf={doc.pdf} texts={doc.texts} ai={ai} fingerprint={doc.fingerprint} name={doc.name} startPage={page} onClose={() => setTranslating(false)} />
      )}
      {scanning && (
        <ScanModal
          onClose={() => setScanning(false)}
          onDone={async (bytes) => {
            setScanning(false);
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
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
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
