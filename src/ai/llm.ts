/**
 * Moteurs d'IA 100 % locaux :
 *  - WebLLM : le modèle tourne dans le navigateur via WebGPU (rien ne sort de la machine) ;
 *  - Ollama : serveur local sur http://localhost:11434.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ProviderId = 'auto' | 'webllm' | 'cpu' | 'ollama';

export interface AiSettings {
  provider: ProviderId;
  webllmModel: string;
  cpuModel: string;
  ollamaUrl: string;
  ollamaModel: string;
}

/** Modèles pour le processeur (llama.cpp en WebAssembly) : fonctionnent sur tous les ordinateurs. */
export const CPU_MODELS: { id: string; repo: string; file: string; label: string }[] = [
  { id: 'qwen2.5-0.5b', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', label: 'Qwen 2.5 0,5B — rapide (~0,4 Go)' },
  { id: 'qwen2.5-1.5b', repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', label: 'Qwen 2.5 1,5B — meilleure qualité, plus lent (~1 Go)' },
  { id: 'llama3.2-1b', repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', label: 'Llama 3.2 1B (~0,8 Go)' },
];

export const WEBLLM_MODELS: { id: string; label: string }[] = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 0,5B — très léger, petits PC (~0,4 Go)' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1,5B — léger, bon en français (~1 Go)' },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 3B — meilleur équilibre (~2 Go)' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B (~2 Go)' },
  { id: 'Phi-4-mini-instruct-q4f16_1-MLC', label: 'Phi-4 mini — raisonnement (~2,5 Go)' },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 7B — le plus précis (~5 Go)' },
];

export const DEFAULT_AI: AiSettings = {
  provider: 'auto',
  webllmModel: WEBLLM_MODELS[1].id,
  cpuModel: CPU_MODELS[0].id,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engine: any = null;
let engineModel = '';
let loading: Promise<unknown> | null = null;

/** Mémorise qu'une carte graphique a planté (pilote réinitialisé) pour ne plus l'utiliser automatiquement. */
const GPU_KEY = 'nova:gpu-failed';
export const gpuMarkedBroken = () => {
  try {
    return localStorage.getItem(GPU_KEY) === '1';
  } catch {
    return false;
  }
};
const markGpu = (broken: boolean) => {
  try {
    if (broken) localStorage.setItem(GPU_KEY, '1');
    else localStorage.removeItem(GPU_KEY);
  } catch {
    /* rien */
  }
};
export const resetGpuFlag = () => markGpu(false);
const isGpuCrash = (e: unknown) =>
  /DEVICE_REMOVED|DEVICE_HUNG|device (was )?lost|requestDevice|GPUAdapter|D3D12|Vulkan|out of memory|OOM|DXGI|createComputePipeline|GPUBuffer/i.test(
    String((e as Error)?.message ?? e),
  );

export function webGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/** Vérifie que la carte graphique est utilisable et si elle gère les nombres 16 bits (shader-f16). */
async function gpuInfo(): Promise<{ ok: boolean; f16: boolean }> {
  if (!webGpuAvailable()) return { ok: false, f16: false };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = await (navigator as any).gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, f16: false };
    return { ok: true, f16: adapter.features.has('shader-f16') };
  } catch {
    return { ok: false, f16: false };
  }
}

/** Sans shader-f16, on prend la variante 32 bits du même modèle (sinon le chargement échoue). */
async function resolveModel(model: string): Promise<string> {
  const g = await gpuInfo();
  if (!g.ok)
    throw new Error(
      "Votre carte graphique n'est pas accessible par WebGPU (navigateur ou pilote trop ancien). " +
        'Utilisez Chrome ou Edge à jour, ou choisissez le moteur « Ollama » dans ⚙.',
    );
  return g.f16 ? model : model.replace('q4f16_1', 'q4f32_1');
}

export async function ensureWebLLM(model: string, onProgress: (text: string, ratio: number) => void) {
  const target = await resolveModel(model);
  if (engine && engineModel === target) return engine;
  if (loading) await loading.catch(() => {});
  if (engine && engineModel === target) return engine;
  const webllm = await import('@mlc-ai/web-llm');
  const { isTauri } = await import('../platform');
  // Les applications de bureau n'ont pas toujours l'API Cache : on stocke le modèle dans IndexedDB.
  const appConfig = { ...webllm.prebuiltAppConfig, cacheBackend: isTauri || !('caches' in window) ? 'indexeddb' : 'cache' };
  const progress = (r: { text: string; progress: number }) => onProgress(frenchProgress(r.text), r.progress);
  loading = (async () => {
    if (engine) {
      try {
        await engine.reload(target);
      } catch {
        engine = null;
      }
    }
    // Petits morceaux de calcul : évite que Windows réinitialise une carte graphique modeste (délai TDR).
    const chatOpts = { context_window_size: 4096, prefill_chunk_size: 256 };
    if (!engine) engine = await webllm.CreateMLCEngine(target, { appConfig, initProgressCallback: progress } as never, chatOpts as never);
    else engine.setInitProgressCallback?.(progress);
    engineModel = target;
  })();
  try {
    await loading;
  } catch (e) {
    engine = null;
    engineModel = '';
    const msg = String((e as Error)?.message ?? e);
    if (isGpuCrash(e)) {
      markGpu(true);
      throw new GpuCrashError(msg);
    }
    if (/memory|OOM|device.*lost|allocation/i.test(msg))
      throw new Error('Mémoire graphique insuffisante pour ce modèle : choisissez un modèle plus petit (⚙ → Qwen 2.5 0,5B ou 1,5B).');
    if (/fetch|network|Failed to fetch|NetworkError/i.test(msg))
      throw new Error('Téléchargement du modèle impossible : vérifiez la connexion Internet (nécessaire une seule fois).');
    throw new Error(`Chargement du modèle impossible : ${msg}`);
  } finally {
    loading = null;
  }
  return engine;
}

export class GpuCrashError extends Error {
  constructor(detail: string) {
    super(`La carte graphique a été réinitialisée par le système (${detail.slice(0, 80)}…).`);
  }
}

/* ----- Moteur processeur (llama.cpp WebAssembly) ------------------------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cpu: any = null;
let cpuModelId = '';
let cpuLoading: Promise<void> | null = null;

/** Charge un modèle GGUF pour le processeur : depuis Hugging Face, ou depuis un fichier choisi par l'utilisateur. */
export async function ensureCpu(modelId: string, onProgress: (text: string, ratio: number) => void, file?: Blob) {
  const key = file ? `file:${(file as File).name ?? 'modele'}:${file.size}` : modelId;
  if (cpu && cpuModelId === key) return cpu;
  if (cpuLoading) await cpuLoading.catch(() => {});
  if (cpu && cpuModelId === key) return cpu;
  const { Wllama } = await import('@wllama/wllama');
  const wasmUrl = (await import('@wllama/wllama/esm/wasm/wllama.wasm?url')).default;
  cpuLoading = (async () => {
    if (cpu) await cpu.exit?.().catch(() => {});
    cpu = new Wllama({ default: wasmUrl }, { allowOffline: true } as never);
    const threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    const params = { n_ctx: 4096, n_batch: 256, n_gpu_layers: 0, n_threads: threads };
    const progressCallback = ({ loaded, total }: { loaded: number; total: number }) =>
      onProgress(`Téléchargement du modèle (une seule fois)… ${total ? Math.round((loaded / total) * 100) : 0} %`, total ? loaded / total : 0);
    if (file) {
      onProgress('Chargement du modèle depuis le fichier…', 0.5);
      await cpu.loadModel([file], params);
    } else {
      const m = CPU_MODELS.find((x) => x.id === modelId) ?? CPU_MODELS[0];
      await cpu.loadModelFromHF({ repo: m.repo, file: m.file }, { ...params, progressCallback });
    }
    cpuModelId = key;
    onProgress('Prêt', 1);
  })();
  try {
    await cpuLoading;
  } catch (e) {
    cpu = null;
    cpuModelId = '';
    const msg = String((e as Error)?.message ?? e);
    if (/fetch|network|Failed to fetch/i.test(msg)) throw new Error('Téléchargement du modèle impossible : vérifiez la connexion Internet (nécessaire une seule fois).');
    throw new Error(`Chargement du modèle (processeur) impossible : ${msg}`);
  } finally {
    cpuLoading = null;
  }
  return cpu;
}

/** Modèle choisi par l'utilisateur sur son disque (fichier .gguf), conservé pour la session. */
let customModel: Blob | undefined;
export const setCustomCpuModel = (f: Blob | undefined) => {
  customModel = f;
};
export const customCpuModelName = () => (customModel as File | undefined)?.name;

async function cpuChat(settings: AiSettings, messages: ChatMessage[], onToken: (t: string) => void, onProgress: (text: string, ratio: number) => void, signal?: AbortSignal) {
  const w = await ensureCpu(settings.cpuModel, onProgress, customModel);
  engineLabel = `processeur (${customModel ? (customModel as File).name : CPU_MODELS.find((m) => m.id === settings.cpuModel)?.label.split(' —')[0] ?? settings.cpuModel})`;
  onProgress('Lecture du texte par le processeur… (plus lent que la carte graphique)', 0.99);
  let full = '';
  let first = true;
  const stream = await w.createChatCompletion({ messages, stream: true, max_tokens: 900, temperature: 0.3 });
  for await (const chunk of stream) {
    if (first) {
      onProgress('', 1);
      first = false;
    }
    if (signal?.aborted) break;
    const t = chunk.choices?.[0]?.delta?.content ?? '';
    if (t) {
      full += t;
      onToken(t);
    }
  }
  return full;
}

function frenchProgress(t: string) {
  const m = t.match(/(\d+)%/);
  if (/Fetching|Loading model from cache/i.test(t)) return `Téléchargement du modèle (une seule fois)… ${m ? m[1] + ' %' : ''}`;
  if (/Loading GPU|shader/i.test(t)) return 'Chargement du modèle sur la carte graphique…';
  return t;
}

/**
 * Requêtes vers Ollama. Dans l'application de bureau, elles passent par la partie native
 * (pas de restriction CORS : sous Windows, l'origine « http://tauri.localhost » est refusée par Ollama).
 */
async function ollamaFetch(url: string, init?: RequestInit): Promise<Response> {
  const { isTauri } = await import('../platform');
  if (isTauri) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

async function ollamaReachable(url: string) {
  try {
    const r = await ollamaFetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** « ok », « blocked » (Ollama tourne mais refuse cette origine) ou « absent ». */
export async function ollamaStatus(url: string): Promise<'ok' | 'blocked' | 'absent'> {
  if (await ollamaReachable(url)) return 'ok';
  try {
    await fetch(`${url.replace(/\/$/, '')}/api/tags`, { mode: 'no-cors', signal: AbortSignal.timeout(1500) });
    return 'blocked';
  } catch {
    return 'absent';
  }
}

let engineLabel = '';
/** Moteur réellement utilisé pour la dernière réponse (affiché sous la zone de saisie). */
export const lastEngine = () => engineLabel;

export async function chat(
  settings: AiSettings,
  messages: ChatMessage[],
  onToken: (t: string) => void,
  onProgress: (text: string, ratio: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const provider = settings.provider ?? 'auto';
  if (provider === 'cpu') return cpuChat(settings, messages, onToken, onProgress, signal);
  if (provider === 'ollama') return ollamaChat(settings, messages, onToken, signal);
  if (provider === 'auto') {
    // 1) Ollama s'il est installé (le plus rapide et le plus fiable)
    if (await ollamaReachable(settings.ollamaUrl)) return ollamaChat(settings, messages, onToken, signal);
    // 2) carte graphique, si elle fonctionne ; 3) sinon processeur
    if (gpuMarkedBroken() || !(await gpuInfo()).ok) return cpuChat(settings, messages, onToken, onProgress, signal);
  }
  let full = '';
  const generate = async () => {
    const eng = await ensureWebLLM(settings.webllmModel, onProgress);
    engineLabel = `carte graphique (${engineModel.replace(/-Instruct.*$/, '')})`;
    const stream = await eng.chat.completions.create({ messages, stream: true, temperature: 0.3 });
    for await (const part of stream) {
      if (signal?.aborted) {
        eng.interruptGenerate?.();
        break;
      }
      const t = part.choices?.[0]?.delta?.content ?? '';
      if (t) {
        full += t;
        onToken(t);
      }
    }
  };
  try {
    await generate();
  } catch (e) {
    if (full) throw e;
    if (/not loaded|ModelNotLoaded/i.test(String((e as Error)?.message ?? e)) && !isGpuCrash(e)) {
      engine = null;
      engineModel = '';
      try {
        await generate();
        return full;
      } catch (e2) {
        e = e2;
      }
    }
    if (isGpuCrash(e) || e instanceof GpuCrashError) {
      markGpu(true);
      engine = null;
      engineModel = '';
      if (provider === 'auto') {
        onProgress('Carte graphique indisponible : passage au processeur…', 0);
        return cpuChat(settings, messages, onToken, onProgress, signal);
      }
      throw new Error(
        'La carte graphique a été réinitialisée par Windows (pilote ou mémoire insuffisante). ' +
          'Choisissez le moteur « Automatique » ou « Processeur » dans ⚙, ou redémarrez l’application.',
      );
    }
    throw e;
  }
  return full;
}

async function ollamaChat(settings: AiSettings, messages: ChatMessage[], onToken: (t: string) => void, signal?: AbortSignal): Promise<string> {
  let full = '';
  // Modèle absent : on prend le premier modèle installé dans Ollama.
  let model = settings.ollamaModel;
  try {
    const installed = await listOllamaModels(settings.ollamaUrl);
    if (installed.length && !installed.some((m) => m === model || m.startsWith(model + ':'))) model = installed[0];
    if (!installed.length) throw new Error('Ollama ne contient aucun modèle : lancez « ollama pull qwen2.5:3b ».');
  } catch (e) {
    if ((e as Error).message.startsWith('Ollama ne contient')) throw e;
  }
  engineLabel = `Ollama (${model})`;
  const res = await ollamaFetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { temperature: 0.3 } }),
    signal,
  }).catch(() => {
    throw new Error(
      `Ollama injoignable sur ${settings.ollamaUrl}. Lancez « ollama serve » avec OLLAMA_ORIGINS=* (voir README).`,
    );
  });
  if (!res.ok || !res.body) throw new Error(`Ollama a répondu ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      const t = j.message?.content ?? '';
      if (t) {
        full += t;
        onToken(t);
      }
    }
  }
  return full;
}

export async function listOllamaModels(url: string): Promise<string[]> {
  const r = await ollamaFetch(`${url.replace(/\/$/, '')}/api/tags`);
  const j = await r.json();
  return (j.models ?? []).map((m: { name: string }) => m.name);
}

/** Diagnostic affiché dans les réglages de l'IA. */
export async function aiDiagnostics(ollamaUrl: string) {
  const g = await gpuInfo();
  const st = await ollamaStatus(ollamaUrl);
  let models: string[] = [];
  if (st === 'ok') models = await listOllamaModels(ollamaUrl).catch(() => []);
  return { webgpu: g.ok, f16: g.f16, ollama: st === 'ok', ollamaBlocked: st === 'blocked', ollamaModels: models };
}
