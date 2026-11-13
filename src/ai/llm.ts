/**
 * Moteurs d'IA 100 % locaux :
 *  - WebLLM : le modèle tourne dans le navigateur via WebGPU (rien ne sort de la machine) ;
 *  - Ollama : serveur local sur http://localhost:11434.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ProviderId = 'webllm' | 'ollama';

export interface AiSettings {
  provider: ProviderId;
  webllmModel: string;
  ollamaUrl: string;
  ollamaModel: string;
}

export const WEBLLM_MODELS: { id: string; label: string }[] = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 0,5B — très léger, petits PC (~0,4 Go)' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1,5B — léger, bon en français (~1 Go)' },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 3B — meilleur équilibre (~2 Go)' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B (~2 Go)' },
  { id: 'Phi-4-mini-instruct-q4f16_1-MLC', label: 'Phi-4 mini — raisonnement (~2,5 Go)' },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 7B — le plus précis (~5 Go)' },
];

export const DEFAULT_AI: AiSettings = {
  provider: 'webllm',
  webllmModel: WEBLLM_MODELS[1].id,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engine: any = null;
let engineModel = '';
let loading: Promise<unknown> | null = null;

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
    if (!engine) engine = await webllm.CreateMLCEngine(target, { appConfig, initProgressCallback: progress } as never);
    else engine.setInitProgressCallback?.(progress);
    engineModel = target;
  })();
  try {
    await loading;
  } catch (e) {
    engine = null;
    engineModel = '';
    const msg = String((e as Error)?.message ?? e);
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

function frenchProgress(t: string) {
  const m = t.match(/(\d+)%/);
  if (/Fetching|Loading model from cache/i.test(t)) return `Téléchargement du modèle (une seule fois)… ${m ? m[1] + ' %' : ''}`;
  if (/Loading GPU|shader/i.test(t)) return 'Chargement du modèle sur la carte graphique…';
  return t;
}

async function ollamaReachable(url: string) {
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function chat(
  settings: AiSettings,
  messages: ChatMessage[],
  onToken: (t: string) => void,
  onProgress: (text: string, ratio: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  let full = '';
  if (settings.provider === 'webllm') {
    // Pas de WebGPU mais Ollama installé : on bascule automatiquement.
    if (!(await gpuInfo()).ok && (await ollamaReachable(settings.ollamaUrl))) {
      return chat({ ...settings, provider: 'ollama' }, messages, onToken, onProgress, signal);
    }
    const generate = async () => {
      const eng = await ensureWebLLM(settings.webllmModel, onProgress);
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
      // Le modèle a été déchargé (carte graphique réinitialisée, mise en veille…) : on recharge une fois.
      if (/not loaded|ModelNotLoaded|device was lost|Device lost/i.test(String((e as Error)?.message ?? e)) && !full) {
        engine = null;
        engineModel = '';
        await generate();
      } else throw e;
    }
    return full;
  }

  // Modèle absent : on prend le premier modèle installé dans Ollama.
  let model = settings.ollamaModel;
  try {
    const installed = await listOllamaModels(settings.ollamaUrl);
    if (installed.length && !installed.some((m) => m === model || m.startsWith(model + ':'))) model = installed[0];
    if (!installed.length) throw new Error('Ollama ne contient aucun modèle : lancez « ollama pull qwen2.5:3b ».');
  } catch (e) {
    if ((e as Error).message.startsWith('Ollama ne contient')) throw e;
  }
  const res = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
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
  const r = await fetch(`${url.replace(/\/$/, '')}/api/tags`);
  const j = await r.json();
  return (j.models ?? []).map((m: { name: string }) => m.name);
}

/** Diagnostic affiché dans les réglages de l'IA. */
export async function aiDiagnostics(ollamaUrl: string) {
  const g = await gpuInfo();
  return { webgpu: g.ok, f16: g.f16, ollama: await ollamaReachable(ollamaUrl) };
}
