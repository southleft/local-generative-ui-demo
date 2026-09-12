/**
 * LiteRT-LM.js in the browser: model definitions, Cache Storage persistence
 * for the multi-gigabyte artifact, engine creation, and streamed generation.
 * The runtime itself is imported lazily so the page loads without it.
 */

export interface LiteRtModelDefinition {
  id: 'qwen3-0.6b' | 'gemma-4-e2b' | 'gemma-4-e4b';
  label: string;
  shortLabel: string;
  url: string;
  sizeBytes: number;
  /**
   * KV-cache budget passed to the engine as maxNumTokens (prompt plus output).
   * 4,096 is roughly the lower bound documented for Chrome's built-in Gemini
   * Nano session window, so one prompt budget serves both providers.
   * The runtime's greedy output depends on this value: the same prompt gives
   * different bytes at 4,096 and at 8,192, and every captured run in the
   * session log and in captured-runs.test.ts was produced at 4,096. Override
   * per load with loadLiteRtModel({ maxNumTokens }).
   */
  contextTokens: number;
  description: string;
  webSupported: boolean;
  unsupportedReason?: string;
}

export const LITERT_MODELS: LiteRtModelDefinition[] = [
  {
    id: 'qwen3-0.6b',
    label: 'Qwen 3 0.6B',
    shortLabel: 'Q3',
    url: 'https://huggingface.co/litert-community/Qwen3-0.6B/resolve/main/Qwen3-0.6B.litertlm',
    sizeBytes: 614_236_160,
    contextTokens: 4_096,
    description: 'Tested with LiteRT-LM.js 0.14; the browser runtime rejects its prefill/decode model format.',
    webSupported: false,
    unsupportedReason: 'Qwen 3 0.6B is not supported by LiteRT-LM.js 0.14. The current Web API supports only the web-optimized Gemma 4 E2B and E4B artifacts.',
  },
  {
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    shortLabel: 'G2',
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
    sizeBytes: 2_008_432_640,
    contextTokens: 4_096,
    description: 'Current balanced quality baseline using the web-optimized text model.',
    webSupported: true,
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    shortLabel: 'G4',
    url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm',
    sizeBytes: 2_969_059_328,
    contextTokens: 4_096,
    description: 'Larger web-optimized quality comparison with a substantially heavier download.',
    webSupported: true,
  },
];

export const DEFAULT_LITERT_MODEL = LITERT_MODELS.find((model) => model.id === 'gemma-4-e2b')!;

export interface LiteRtConversationLike {
  sendMessageStreaming(prompt: string): AsyncIterable<{ content: string | Array<{ type?: string; text?: string }> }>;
  cancel?: () => void;
  /** Releases the conversation's KV cache in the WASM runtime; without it every generation leaks a live session. */
  delete?: () => Promise<void> | void;
}

export interface LiteRtEngineLike {
  createConversation(config?: unknown): Promise<LiteRtConversationLike>;
  delete?: () => Promise<void>;
}

export type ModelLoadPhase = 'preparing' | 'downloading' | 'compiling' | 'ready';

export interface ModelLoadProgress {
  phase: ModelLoadPhase;
  loadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  /** True when the artifact bytes were served from the browser Cache Storage instead of the network. */
  fromCache?: boolean;
}

export interface ModelGenerationEvent {
  type: 'conversation-created' | 'prompt-sent' | 'chunk-received' | 'generation-cancelled' | 'generation-complete';
  /** Human-readable detail for the debug trace, e.g. the sampling a session actually got. */
  detail?: string;
  chunkIndex?: number;
  characters?: number;
  totalCharacters?: number;
  reason?: string;
}

export interface GenerateTextOptions {
  onEvent?: (event: ModelGenerationEvent) => void;
  /** Called with the full accumulated output after every streamed chunk. */
  onPartial?: (text: string) => void;
}

const MODEL_CACHE_NAME = 'litert-model-cache-v1';
// Greedy decoding can fall into a verbatim loop and burn the whole token
// budget re-emitting the same nodes; these bound the stream.
const REPETITION_WINDOW = 400;
const MAX_OUTPUT_CHARS = 24_000;

function cacheStorageOrUndefined(provided?: CacheStorage): CacheStorage | undefined {
  return provided ?? (typeof caches !== 'undefined' ? caches : undefined);
}

export interface CachedModelState {
  cached: boolean;
  persisted: boolean;
}

export async function getCachedModelState(model: LiteRtModelDefinition, cacheStorage?: CacheStorage): Promise<CachedModelState> {
  try {
    const storage = cacheStorageOrUndefined(cacheStorage);
    if (!storage) return { cached: false, persisted: false };
    const cache = await storage.open(MODEL_CACHE_NAME);
    const hit = await cache.match(model.url);
    const persisted = await (typeof navigator !== 'undefined' ? navigator.storage?.persisted?.() : undefined) ?? false;
    return { cached: Boolean(hit), persisted };
  } catch {
    return { cached: false, persisted: false };
  }
}

export async function clearCachedModel(model: LiteRtModelDefinition, cacheStorage?: CacheStorage): Promise<boolean> {
  try {
    const storage = cacheStorageOrUndefined(cacheStorage);
    if (!storage) return false;
    const cache = await storage.open(MODEL_CACHE_NAME);
    return await cache.delete(model.url);
  } catch {
    return false;
  }
}

interface LoadLiteRtModelOptions {
  model?: LiteRtModelDefinition;
  onProgress?: (progress: ModelLoadProgress) => void;
  fetcher?: typeof fetch;
  cacheStorage?: CacheStorage;
  engineFactory?: (settings: { model: Blob | ReadableStream<Uint8Array>; mainExecutorSettings: { maxNumTokens: number } }) => Promise<LiteRtEngineLike>;
  /** KV-cache budget for prompt plus output, in tokens. Defaults to the model definition's contextTokens. */
  maxNumTokens?: number;
}

function countingStream(body: ReadableStream<Uint8Array>, totalBytes: number | undefined, onProgress: (progress: ModelLoadProgress) => void, onDone?: () => void): ReadableStream<Uint8Array> {
  let loadedBytes = 0;
  onProgress({ phase: 'downloading', loadedBytes, totalBytes, percent: totalBytes ? 0 : undefined });
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loadedBytes += chunk.byteLength;
      onProgress({ phase: 'downloading', loadedBytes, totalBytes, percent: totalBytes ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : undefined });
      controller.enqueue(chunk);
    },
    flush() {
      onDone?.();
    },
  }));
}

async function fetchModelBody(fetcher: typeof fetch, model: LiteRtModelDefinition): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers; totalBytes: number }> {
  const response = await fetcher(model.url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Failed to download the local model (${response.status}).`);
  if (!response.body) throw new Error('The model download did not provide a readable response body.');
  const totalHeader = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : model.sizeBytes;
  return { body: response.body, headers: response.headers, totalBytes };
}

/**
 * Persist the artifact via Cache Storage (download → cache.put → cache.match →
 * Blob) so reloads skip the multi-gigabyte transfer. Returns undefined when
 * caching is unavailable or fails, in which case the caller streams directly.
 */
async function loadModelBlobThroughCache(model: LiteRtModelDefinition, fetcher: typeof fetch, storage: CacheStorage, onProgress: (progress: ModelLoadProgress) => void): Promise<{ blob: Blob; fromCache: boolean } | undefined> {
  try {
    const cache = await storage.open(MODEL_CACHE_NAME);
    const hit = await cache.match(model.url);
    if (hit) return { blob: await hit.blob(), fromCache: true };

    if (typeof navigator !== 'undefined' && navigator.storage) {
      await navigator.storage.persist?.().catch(() => false);
      const estimate = await navigator.storage.estimate?.().catch(() => undefined);
      if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < model.sizeBytes * 1.1) return undefined;
    }

    const { body, headers, totalBytes } = await fetchModelBody(fetcher, model);
    await cache.put(model.url, new Response(countingStream(body, totalBytes, onProgress), { headers }));
    const stored = await cache.match(model.url);
    return stored ? { blob: await stored.blob(), fromCache: false } : undefined;
  } catch {
    return undefined;
  }
}

export async function loadLiteRtModel(options: LoadLiteRtModelOptions = {}): Promise<LiteRtEngineLike> {
  const model = options.model ?? DEFAULT_LITERT_MODEL;
  if (!model.webSupported) throw new Error(model.unsupportedReason ?? `${model.label} is not supported by LiteRT-LM.js.`);
  const onProgress = options.onProgress ?? (() => undefined);
  const fetcher = options.fetcher ?? fetch;
  onProgress({ phase: 'preparing' });

  const storage = cacheStorageOrUndefined(options.cacheStorage);
  const cached = storage ? await loadModelBlobThroughCache(model, fetcher, storage, onProgress) : undefined;

  let compilingReported = false;
  const reportCompiling = () => {
    if (compilingReported) return;
    compilingReported = true;
    onProgress({ phase: 'compiling', fromCache: cached?.fromCache ?? false });
  };

  let artifact: Blob | ReadableStream<Uint8Array>;
  if (cached) {
    artifact = cached.blob;
    reportCompiling();
  } else {
    const { body, totalBytes } = await fetchModelBody(fetcher, model);
    artifact = countingStream(body, totalBytes, onProgress, reportCompiling);
  }

  const engineFactory = options.engineFactory ?? (async (settings) => {
    const { Engine } = await import('@litert-lm/core');
    return Engine.create(settings) as unknown as Promise<LiteRtEngineLike>;
  });
  const engine = await engineFactory({ model: artifact, mainExecutorSettings: { maxNumTokens: options.maxNumTokens ?? model.contextTokens } });
  reportCompiling();
  onProgress({ phase: 'ready', percent: 100, fromCache: cached?.fromCache ?? false });
  return engine;
}

/**
 * Stream one generation. LiteRT-LM 0.14 decodes greedily on WebGPU (its
 * runtime rejects top-k > 1 and aborts on top-p), so there is no sampler:
 * the same prompt reproduces the same output byte for byte.
 */
export async function generateModelText(engine: LiteRtEngineLike, prompt: string, options: GenerateTextOptions = {}): Promise<string> {
  const onEvent = options.onEvent ?? (() => undefined);
  const conversation = await engine.createConversation({
    preface: { messages: [{ role: 'system', content: 'Follow the output format exactly. Never emit executable code.' }] },
  });
  onEvent({ type: 'conversation-created' });

  let output = '';
  let chunkIndex = 0;
  onEvent({ type: 'prompt-sent', characters: prompt.length });

  // Detect a repeated tail (or a runaway length) and cancel; the salvage layer renders whatever arrived.
  const cancelReason = (): string | undefined => {
    if (output.length > MAX_OUTPUT_CHARS) return `output exceeded ${MAX_OUTPUT_CHARS.toLocaleString()} characters`;
    if (output.length < REPETITION_WINDOW * 3) return undefined;
    const tail = output.slice(-REPETITION_WINDOW);
    const firstIndex = output.indexOf(tail);
    return firstIndex !== -1 && firstIndex < output.length - REPETITION_WINDOW * 2 ? 'the model started repeating itself verbatim' : undefined;
  };

  try {
    for await (const chunk of conversation.sendMessageStreaming(prompt)) {
      const text = typeof chunk.content === 'string'
        ? chunk.content
        : chunk.content.filter((item) => item.type === 'text' || typeof item.text === 'string').map((item) => item.text ?? '').join('');
      output += text;
      chunkIndex += 1;
      onEvent({ type: 'chunk-received', chunkIndex, characters: text.length, totalCharacters: output.length });
      if (text) options.onPartial?.(output);
      if (chunkIndex % 20 === 0) {
        const reason = cancelReason();
        if (reason) {
          conversation.cancel?.();
          onEvent({ type: 'generation-cancelled', chunkIndex, totalCharacters: output.length, reason });
          break;
        }
      }
    }
  } finally {
    // Each generation is its own conversation; release it or the runtime keeps every KV cache alive
    // and generation slows down run after run (measured: 13 s median → 34 s after ~75 runs in one page).
    await Promise.resolve(conversation.delete?.()).catch(() => undefined);
  }
  onEvent({ type: 'generation-complete', chunkIndex, totalCharacters: output.length });
  return output;
}

export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
