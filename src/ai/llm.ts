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
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B — léger, bon en français (~1 Go)' },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 3B — meilleur équilibre (~2 Go)' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B (~2 Go)' },
  { id: 'Phi-4-mini-instruct-q4f16_1-MLC', label: 'Phi-4 mini — raisonnement (~2,5 Go)' },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 7B — le plus précis (~5 Go)' },
];

export const DEFAULT_AI: AiSettings = {
  provider: 'webllm',
  webllmModel: WEBLLM_MODELS[0].id,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engine: any = null;
let engineModel = '';

export function webGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export async function ensureWebLLM(model: string, onProgress: (text: string, ratio: number) => void) {
  if (engine && engineModel === model) return engine;
  if (!webGpuAvailable()) throw new Error("WebGPU n'est pas disponible dans ce navigateur (essayez Chrome ou Edge récents), ou utilisez Ollama.");
  const webllm = await import('@mlc-ai/web-llm');
  if (engine) await engine.unload?.();
  engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (r: { text: string; progress: number }) => onProgress(r.text, r.progress),
  });
  engineModel = model;
  return engine;
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
    return full;
  }

  const res = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings.ollamaModel, messages, stream: true, options: { temperature: 0.3 } }),
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
