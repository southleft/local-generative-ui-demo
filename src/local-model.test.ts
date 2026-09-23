import { describe, expect, it, vi } from 'vitest';
import { clearCachedModel, DEFAULT_LITERT_MODEL, generateModelText, getCachedModelState, HOSTED_TUNED_MODEL_URL, LITERT_MODELS, loadLiteRtModel, type EngineFactorySettings, type LiteRtEngineLike, type ModelLoadProgress } from './local-model';

function fakeCacheStorage() {
  const store = new Map<string, { body: ArrayBuffer; headers: Headers }>();
  const cache = {
    match: async (key: string) => {
      const entry = store.get(key);
      return entry ? new Response(entry.body.slice(0), { headers: entry.headers }) : undefined;
    },
    put: async (key: string, response: Response) => {
      store.set(key, { body: await response.arrayBuffer(), headers: response.headers });
    },
    delete: async (key: string) => store.delete(key),
  };
  return { storage: { open: async () => cache } as unknown as CacheStorage, store };
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(model: Blob | ReadableStream<Uint8Array>): Promise<number> {
  // instanceof Blob is unreliable across the jsdom/undici realm boundary.
  if (typeof (model as Blob).size === 'number' && typeof (model as Blob).arrayBuffer === 'function') return (model as Blob).size;
  const reader = (model as ReadableStream<Uint8Array>).getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return size;
    size += value?.byteLength ?? 0;
  }
}

describe('loadLiteRtModel', () => {
  it('offers stock Gemma 4 E2B and the catalog-tuned E2B, defaulting to stock', () => {
    expect(LITERT_MODELS.map(({ id }) => id)).toEqual(['gemma-4-e2b', 'gemma-4-e2b-catalog']);
    expect(DEFAULT_LITERT_MODEL.id).toBe('gemma-4-e2b');
  });

  it('lists the catalog-tuned Gemma as a standard export that takes the heap-resident path', () => {
    const tuned = LITERT_MODELS.find((model) => model.id === 'gemma-4-e2b-catalog')!;
    expect(tuned).toMatchObject({ label: 'Gemma 4 E2B · catalog-tuned', sizeBytes: 2_293_258_112, contextTokens: 4_096, webSupported: true, loader: 'heap' });
    expect(tuned.url).toBe(HOSTED_TUNED_MODEL_URL);
    expect(LITERT_MODELS.filter((model) => model.id !== 'gemma-4-e2b-catalog').every((model) => model.loader === undefined)).toBe(true);
  });

  it('hands the tuned artifact to the engine factory with the heap loader and its exact size', async () => {
    const tuned = LITERT_MODELS.find((model) => model.id === 'gemma-4-e2b-catalog')!;
    const fetcher = vi.fn(async () => new Response(streamOf(new Uint8Array(12)), { headers: { 'content-length': '12' } }));
    const engineFactory = vi.fn<(settings: EngineFactorySettings) => Promise<LiteRtEngineLike>>(async () => ({ createConversation: vi.fn() }) as unknown as LiteRtEngineLike);

    await loadLiteRtModel({ model: tuned, fetcher, engineFactory, cacheStorage: { open: async () => { throw new Error('no cache'); } } as unknown as CacheStorage });

    expect(engineFactory).toHaveBeenCalledTimes(1);
    expect(engineFactory.mock.calls[0][0]).toMatchObject({ loader: 'heap', totalBytes: 12, url: tuned.url, mainExecutorSettings: { maxNumTokens: 4_096 } });
  });

  it('keeps the web artifacts on the streaming path and passes the cached size through', async () => {
    const { storage } = fakeCacheStorage();
    const fetcher = vi.fn(async () => new Response(streamOf(new Uint8Array(5)), { headers: { 'content-length': '5' } }));
    const engineFactory = vi.fn<(settings: EngineFactorySettings) => Promise<LiteRtEngineLike>>(async () => ({ createConversation: vi.fn() }) as unknown as LiteRtEngineLike);

    await loadLiteRtModel({ model: DEFAULT_LITERT_MODEL, fetcher, engineFactory, cacheStorage: storage });
    await loadLiteRtModel({ model: DEFAULT_LITERT_MODEL, fetcher, engineFactory, cacheStorage: storage });

    expect(engineFactory.mock.calls.map(([settings]) => settings.loader)).toEqual(['streaming', 'streaming']);
    expect(engineFactory.mock.calls[1][0].totalBytes).toBe(5);
  });

  it('refuses a definition marked unsupported before downloading it', async () => {
    const fetcher = vi.fn();
    const unsupported = { ...DEFAULT_LITERT_MODEL, webSupported: false, unsupportedReason: 'This artifact is not loadable by LiteRT-LM.js 0.14.' };
    await expect(loadLiteRtModel({ model: unsupported, fetcher })).rejects.toThrow(/not loadable by litert-lm\.js/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads the selected LiteRT artifact instead of a hard-coded model', async () => {
    const fetcher = vi.fn(async () => new Response(streamOf()));
    const engine = { createConversation: vi.fn() } as unknown as LiteRtEngineLike;

    await loadLiteRtModel({
      model: LITERT_MODELS.find((model) => model.id === 'gemma-4-e2b-catalog')!,
      fetcher,
      engineFactory: vi.fn(async ({ model }) => {
        await drain(model);
        return engine;
      }),
    });

    expect(fetcher).toHaveBeenCalledWith(LITERT_MODELS.find((model) => model.id === 'gemma-4-e2b-catalog')!.url, { credentials: 'same-origin' });
  });

  it('reports real download bytes before the indeterminate compile phase', async () => {
    const progress: ModelLoadProgress[] = [];
    const engine = { createConversation: vi.fn() } as unknown as LiteRtEngineLike;

    await loadLiteRtModel({
      onProgress: (event) => progress.push(event),
      fetcher: vi.fn(async () => new Response(streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4])), { headers: { 'content-length': '4' } })),
      engineFactory: vi.fn(async ({ model }) => {
        await drain(model);
        expect(progress.at(-1)?.phase).toBe('compiling');
        return engine;
      }),
    });

    const phases = progress.map(({ phase }) => phase);
    expect(phases[0]).toBe('preparing');
    expect(phases).toContain('downloading');
    expect(phases).toContain('compiling');
    expect(phases.at(-1)).toBe('ready');
    expect(progress.find((event) => event.percent === 50)).toMatchObject({ loadedBytes: 2, totalBytes: 4 });
    expect(progress.find((event) => event.phase === 'compiling')?.percent).toBeUndefined();
  });

  it('stores the downloaded artifact in Cache Storage and reuses it on the next load', async () => {
    const { storage } = fakeCacheStorage();
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const fetcher = vi.fn(async () => new Response(streamOf(bytes), { headers: { 'content-length': '4' } }));
    const sizes: number[] = [];
    const engineFactory = vi.fn(async ({ model }: { model: Blob | ReadableStream<Uint8Array> }) => {
      sizes.push(await drain(model));
      return { createConversation: vi.fn() } as unknown as LiteRtEngineLike;
    });

    await loadLiteRtModel({ fetcher, cacheStorage: storage, engineFactory });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sizes).toEqual([4]);

    const cachedProgress: ModelLoadProgress[] = [];
    await loadLiteRtModel({ fetcher, cacheStorage: storage, engineFactory, onProgress: (event) => cachedProgress.push(event) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sizes).toEqual([4, 4]);
    expect(cachedProgress.some((event) => event.phase === 'downloading')).toBe(false);
    expect(cachedProgress.find((event) => event.phase === 'compiling')).toMatchObject({ fromCache: true });
    expect(cachedProgress.at(-1)).toMatchObject({ phase: 'ready', fromCache: true });
  });

  it('reports and clears the cached artifact state', async () => {
    const { storage } = fakeCacheStorage();
    const fetcher = vi.fn(async () => new Response(streamOf(new Uint8Array([1])), { headers: { 'content-length': '1' } }));
    const engineFactory = vi.fn(async ({ model }: { model: Blob | ReadableStream<Uint8Array> }) => {
      await drain(model);
      return { createConversation: vi.fn() } as unknown as LiteRtEngineLike;
    });

    await expect(getCachedModelState(DEFAULT_LITERT_MODEL, storage)).resolves.toMatchObject({ cached: false });
    await loadLiteRtModel({ fetcher, cacheStorage: storage, engineFactory });
    await expect(getCachedModelState(DEFAULT_LITERT_MODEL, storage)).resolves.toMatchObject({ cached: true });
    await expect(clearCachedModel(DEFAULT_LITERT_MODEL, storage)).resolves.toBe(true);
    await expect(getCachedModelState(DEFAULT_LITERT_MODEL, storage)).resolves.toMatchObject({ cached: false });
  });

  it('falls back to direct streaming when Cache Storage fails', async () => {
    const brokenStorage = { open: async () => { throw new Error('quota'); } } as unknown as CacheStorage;
    const fetcher = vi.fn(async () => new Response(streamOf(new Uint8Array([5, 5])), { headers: { 'content-length': '2' } }));
    const engine = { createConversation: vi.fn() } as unknown as LiteRtEngineLike;
    const engineFactory = vi.fn(async ({ model }: { model: Blob | ReadableStream<Uint8Array> }) => {
      await drain(model);
      return engine;
    });

    await expect(loadLiteRtModel({ fetcher, cacheStorage: brokenStorage, engineFactory })).resolves.toBe(engine);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('generateModelText', () => {
  it('collects streamed text chunks from a LiteRT-LM conversation', async () => {
    const sendMessageStreaming = vi.fn(async function* () {
      yield { content: [{ type: 'text', text: '{"version":"v0.9"}\n' }] };
      yield { content: [{ type: 'text', text: '{"createSurface":{}}' }] };
    });
    const engine: LiteRtEngineLike = {
      createConversation: vi.fn(async () => ({ sendMessageStreaming })),
    };

    const output = await generateModelText(engine, 'compose a dashboard');

    expect(output).toBe('{"version":"v0.9"}\n{"createSurface":{}}');
    expect(sendMessageStreaming).toHaveBeenCalledWith('compose a dashboard');
  });

  it('reports the model conversation and every streamed chunk', async () => {
    const events: string[] = [];
    const engine: LiteRtEngineLike = {
      createConversation: vi.fn(async () => ({
        sendMessageStreaming: async function* () {
          yield { content: [{ type: 'text', text: 'one' }] };
          yield { content: [{ type: 'text', text: 'two' }] };
        },
      })),
    };

    await generateModelText(engine, 'prompt', { onEvent: (event) => events.push(event.type) });

    expect(events).toEqual(['conversation-created', 'prompt-sent', 'chunk-received', 'chunk-received', 'generation-complete']);
  });

  it('handles plain string message content and reports accumulated partial text', async () => {
    const partials: string[] = [];
    const engine: LiteRtEngineLike = {
      createConversation: vi.fn(async () => ({
        sendMessageStreaming: async function* () {
          yield { content: '{"root":' };
          yield { content: [{ type: 'text', text: '"a"}' }] };
        },
      })),
    };

    const output = await generateModelText(engine, 'prompt', { onPartial: (text) => partials.push(text) });

    expect(output).toBe('{"root":"a"}');
    expect(partials).toEqual(['{"root":', '{"root":"a"}']);
  });

  it('cancels a stream that repeats itself verbatim and returns what arrived', async () => {
    const cancel = vi.fn();
    const block = '{"id":"loop","component":"Text","props":{"text":"the same node again and again"}},';
    const engine: LiteRtEngineLike = {
      createConversation: vi.fn(async () => ({
        cancel,
        sendMessageStreaming: async function* () {
          for (let index = 0; index < 200; index += 1) yield { content: [{ type: 'text', text: block }] };
        },
      })),
    };
    const events: string[] = [];

    const output = await generateModelText(engine, 'prompt', { onEvent: (event) => events.push(event.type) });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(events).toContain('generation-cancelled');
    expect(events.at(-1)).toBe('generation-complete');
    expect(output.length).toBeLessThan(200 * block.length);
    expect(output.length).toBeGreaterThan(0);
  });
});
