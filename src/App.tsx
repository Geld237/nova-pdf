import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractAllText, getOutline, openPdfWithPassword, type PDFDocumentProxy } from './pdf/engine';
import { unlockPdf } from './pdf/security';
import { applyAnnotations } from './pdf/writer';
import { download } from './pdf/tools';
import { DEFAULT_SETTINGS, appendNote, loadMemory, loadSetting, saveMemory, saveSetting, type AppSettings } from './memory';
import { STAMP_PRESETS, makeStamp } from './stamps';
import { applyAppUpdate, checkForAppUpdate, onUpdateState, updateState } from './update';
import { NotesPanel } from './components/NotesPanel';
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
  startPage: number;
  encrypted: boolean;
}

type Panel = 'ai' | 'notes' | 'reading' | 'form' | 'organize' | 'tools' | 'settings' | null;
type SideTab = 'pages' | 'outline' | 'search' | 'annotations' | 'notebook';

const TOOLS: { id: ToolId; icon: string; label: string; key?: string }[] = [
  { id: 'select', icon: '𝙸', label: 'Sélection de texte', key: 'v' },
  { id: 'highlight', icon: '▮', label: 'Surligner', key: 'h' },
  { id: 'underline', icon: 'U̲', label: 'Souligner', key: 'u' },
  { id: 'strike', icon: 'S̶', label: 'Barrer', key: 's' },
  { id: 'ink', icon: '✎', label: 'Dessin libre', key: 'd' },
  { id: 'rect', icon: '▭', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', icon: '◯', label: 'Ellipse', key: 'e' },
  { id: 'arrow', icon: '➚', label: 'Flèche', key: 'a' },
  { id: 'text', icon: 'T', label: 'Texte', key: 't' },
  { id: 'note', icon: '🗨', label: 'Note', key: 'n' },
  { id: 'signature', icon: '✍', label: 'Signature' },
  { id: 'stamp', icon: '⎔', label: 'Tampon' },
  { id: 'whiteout', icon: '▯', label: 'Correcteur blanc (masquer pour réécrire)', key: 'w' },
  { id: 'measure', icon: '📏', label: 'Mesurer', key: 'm' },
  { id: 'field', icon: '⌸', label: 'Créer un champ de formulaire' },
  { id: 'redact', icon: '█', label: 'Caviarder (définitif)' },
  { id: 'eraser', icon: '⌫', label: 'Gomme (supprimer une annotation)', key: 'x' },
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
  }));
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
  const [ai, setAi] = useState<AiSettings>(() => loadSetting('ai', DEFAULT_AI));
  const viewer = useRef<ViewerHandle>(null);

  const doc = docs.find((d) => d.id === activeId) ?? null;

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
  }, [dark]);
  useEffect(() => {
    const mq = matchMedia?.('(prefers-color-scheme: dark)');
    const h = () => setSysDark(mq.matches);
    mq?.addEventListener('change', h);
    return () => mq?.removeEventListener('change', h);
  }, []);
  // mises à jour de l'application
  useEffect(() => {
    const off = onUpdateState(() => setUpdateReady(updateState.needRefresh));
    if (settings.autoCheckUpdates) setTimeout(() => checkForAppUpdate().catch(() => {}), 4000);
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
    async (bytes: Uint8Array, name: string, existingId?: string, handle?: FileSystemFileHandle) => {
      let pdf: PDFDocumentProxy;
      let encrypted = false;
      try {
        const r = await openPdfWithPassword(bytes, (retry) =>
          prompt(retry ? 'Mot de passe incorrect. Réessayez :' : `« ${name} » est protégé. Mot de passe :`),
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
        return;
      }
      const mem = await loadMemory(fingerprint);
      const id = uid();
      const state: DocState = {
        id, name, bytes, pdf, version: 0, sizes, outline, texts: null, fingerprint,
        annotations: settings.rememberAnnotations ? mem?.annotations ?? [] : [], undo: [], redo: [], dirty: false, handle,
        startPage: settings.resumeLastPage ? mem?.lastPage ?? 0 : 0, encrypted,
      };
      setDocs((ds) => [...ds, state]);
      setActiveId(id);
      setPage(state.startPage);
      if (settings.rememberAnnotations && mem?.annotations.length) notify(`${mem.annotations.length} annotation(s) retrouvée(s) pour ce document.`);
      extractAllText(pdf).then((texts) => patchDoc(id, { texts }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notify, patchDoc, settings.rememberAnnotations, settings.resumeLastPage],
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
  }, [openFiles]);

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
  const onAdd = useCallback((a: Annotation) => setAnns((l) => [...l, a]), [setAnns]);
  const onDelete = useCallback((id: string) => setAnns((l) => l.filter((a) => a.id !== id)), [setAnns]);
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

  const closeDoc = (id: string) => {
    const d = docs.find((x) => x.id === id);
    if (d?.dirty && settings.confirmClose && !confirm(`« ${d.name} » a des modifications non enregistrées (les annotations restent mémorisées). Fermer ?`)) return;
    d?.pdf.cleanup().catch(() => {});
    const rest = docs.filter((x) => x.id !== id);
    setDocs(rest);
    if (activeId === id) setActiveId(rest[rest.length - 1]?.id ?? null);
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
        openNew: (bytes, name) => loadInto(bytes, name),
        notify,
        outline: doc.outline,
        ocrLang: settings.ocrLang,
      }
    : null;

  // ----- Raccourcis clavier -----------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openDialog(); return; }
      if (!doc) return;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(e.shiftKey); return; }
      if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); print(); return; }
      if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); setSidebar(true); setSideTab('search'); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoom(1.15); return; }
      if (mod && e.key === '-') { e.preventDefault(); zoom(1 / 1.15); return; }
      if (mod && e.key === '0') { e.preventDefault(); setFit('width'); return; }
      if (mod) return;
      if (e.key === 'Escape') { setTool('select'); setFocus(false); return; }
      if (e.key === 'f') { setFocus((f) => !f); return; }
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
    if (t === 'stamp' && !opts.stamp) setOpts({ ...opts, stamp: makeStamp(STAMP_PRESETS[0].label, STAMP_PRESETS[0].color) });
    setTool(t);
    if (t === 'highlight' && ['#e53935', '#3949ab', '#212121'].includes(opts.color)) setOpts({ ...opts, color: '#ffeb3b' });
  };

  const showColor = !['select', 'eraser', 'signature', 'redact', 'whiteout', 'stamp', 'field'].includes(tool);

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
        <div className="brand">
          <span className="logo">◆</span> Nova<b>PDF</b>
        </div>
        <button onClick={openDialog} title="Ouvrir (Ctrl+O)">Ouvrir</button>
        {doc && (
          <>
            <button onClick={() => save()} title="Enregistrer (Ctrl+S)" className={doc.dirty ? 'primary' : ''}>
              Enregistrer
            </button>
            <button onClick={() => save(true)} title="Enregistrer sous (Ctrl+Maj+S)">Enregistrer sous</button>
            <button onClick={print} title="Imprimer (Ctrl+P)">Imprimer</button>
            <span className="sep" />
            <button className="icon" onClick={undo} disabled={!doc.undo.length} title="Annuler (Ctrl+Z)">↶</button>
            <button className="icon" onClick={redo} disabled={!doc.redo.length} title="Rétablir (Ctrl+Y)">↷</button>
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
                  {t.icon}
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
                  onClick={() => {
                    const t = prompt('Texte du tampon personnalisé :');
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
        {updateReady && (
          <button className="primary" onClick={applyAppUpdate} title="Une nouvelle version est prête">
            ↻ Mettre à jour
          </button>
        )}
        <button className="icon" onClick={() => setSettings({ ...settings, theme: dark ? 'light' : 'dark' })} title="Thème clair / sombre">
          {dark ? '☀' : '☾'}
        </button>
      </header>

      {docs.length > 0 && (
        <nav className="tabs">
          {docs.map((d) => (
            <div key={d.id} className={`tab ${d.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(d.id)} title={d.name}>
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
        {doc && sidebar && (
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
          />
        )}

        <section className="center">
          {doc ? (
            <>
              <div className="viewbar">
                <button className="icon" onClick={() => setSidebar(!sidebar)} title="Panneau latéral">☰</button>
                <span className="pager">
                  <input
                    aria-label="Page"
                    value={page + 1}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (n >= 1 && n <= doc.sizes.length) goTo(n - 1);
                    }}
                  />
                  / {doc.sizes.length}
                </span>
                <button className="icon" onClick={() => zoom(1 / 1.15)} title="Zoom arrière">−</button>
                <span className="zoom">{Math.round(scale * 100)} %</span>
                <button className="icon" onClick={() => zoom(1.15)} title="Zoom avant">+</button>
                <select value={fit ?? ''} onChange={(e) => setFit((e.target.value || null) as typeof fit)}>
                  <option value="">Zoom libre</option>
                  <option value="width">Pleine largeur</option>
                  <option value="page">Page entière</option>
                </select>
                <select value={layout} onChange={(e) => setLayout(e.target.value as typeof layout)}>
                  <option value="single">Une page</option>
                  <option value="double">Deux pages</option>
                </select>
                <button className={`icon ${night ? 'active' : ''}`} onClick={() => setNight(!night)} title="Mode nuit (inverse les couleurs des pages)">◐</button>
                <button className="icon" onClick={() => setFocus(!focus)} title="Mode concentration (F)">⛶</button>
              </div>
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
                onPageChange={setPage}
              />
            </>
          ) : (
            <Welcome
              onOpen={openDialog}
              onDemo={async () => loadInto(await makeDemoPdf(), 'demo-nova-pdf.pdf')}
            />
          )}
        </section>

        {panel && (panel === 'settings' || (doc && ctx)) && (
          <aside className="right">
            {panel === 'settings' && (
              <SettingsPanel
                doc={doc ? { name: doc.name, size: doc.bytes.length, pdf: doc.pdf, currentPage: page, pageSize: doc.sizes[page], encrypted: doc.encrypted } : null}
                settings={settings}
                setSettings={setSettings}
                notify={notify}
              />
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
              />
            )}
            {ctx && panel === 'tools' && <ToolsPanel ctx={ctx} />}
            {ctx && panel === 'organize' && <OrganizePanel ctx={ctx} />}
            {ctx && panel === 'form' && <FormPanel ctx={ctx} />}
            {doc && panel === 'reading' && <ReadingPanel texts={doc.texts} currentPage={page} goTo={goTo} />}
          </aside>
        )}

        <nav className="rail" aria-label="Panneaux">
          {(
            [
              ['ai', '✦', 'IA', true],
              ['notes', '✎', 'Notes', true],
              ['reading', '📖', 'Lecture', true],
              ['form', '☑', 'Formulaire', true],
              ['organize', '▦', 'Pages', true],
              ['tools', '⚒', 'Outils', true],
              ['settings', 'ⓘ', 'Infos', false],
            ] as [Panel, string, string, boolean][]
          ).map(([id, icon, label, needsDoc]) => (
            <button
              key={id}
              className={panel === id ? 'active' : ''}
              disabled={needsDoc && !doc}
              onClick={() => setPanel(panel === id ? null : id)}
              title={id === 'settings' ? 'Infos, paramètres et mises à jour' : label}
            >
              <span aria-hidden>{icon}</span>
              <small>{label}</small>
              {id === 'settings' && updateReady && <i className="dot" />}
            </button>
          ))}
        </nav>
      </main>

      {sigModal && (
        <SignatureModal
          onClose={() => setSigModal(false)}
          onPick={(s) => {
            setSignature(s);
            setSigModal(false);
            setTool('signature');
            notify('Cliquez sur la page pour placer la signature.');
          }}
        />
      )}
      {dragOver && <div className="drop-overlay">Déposez vos PDF ici</div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Welcome({ onOpen, onDemo }: { onOpen: () => void; onDemo: () => void }) {
  return (
    <div className="welcome">
      <div className="hero">
        <div className="logo-big">◆</div>
        <h1>Nova PDF</h1>
        <p>Le lecteur PDF libre, rapide et privé, avec une IA qui tourne sur votre appareil.</p>
        <div className="row center">
          <button className="primary big" onClick={onOpen}>
            Ouvrir un PDF
          </button>
          <button className="big" onClick={onDemo}>
            Essayer avec un exemple
          </button>
        </div>
        <p className="muted">ou glissez-déposez vos fichiers n'importe où dans la fenêtre</p>
      </div>
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
      <p className="muted small">100 % local · Open source (MIT) · Installable comme application</p>
    </div>
  );
}
