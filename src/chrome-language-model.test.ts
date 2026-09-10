import { describe, expect, it, vi } from 'vitest';
import { ChromeLanguageModelAdapter, type ChromeLanguageModelApiLike, type ChromeLanguageModelCreateOptions } from './chrome-language-model';
import type { ModelLoadProgress } from './local-model';

describe('ChromeLanguageModelAdapter', () => {
  it('reports browser availability without triggering a model download', async () => {
    const languageModel: ChromeLanguageModelApiLike = {
      availability: vi.fn(async () => 'downloadable' as const),
      create: vi.fn(),
    };
    const adapter = new ChromeLanguageModelAdapter(languageModel);

    await expect(adapter.availability()).resolves.toBe('downloadable');
    expect(languageModel.create).not.toHaveBeenCalled();
  });

  it('maps browser-managed download progress and releases its readiness probe session', async () => {
    const progress: ModelLoadProgress[] = [];
    const session = { prompt: vi.fn(async () => '{}'), destroy: vi.fn() };
    const languageModel: ChromeLanguageModelApiLike = {
      availability: vi.fn(async () => 'downloadable' as const),
      create: vi.fn(async (options?: ChromeLanguageModelCreateOptions) => {
        const listeners: Record<string, (event: { loaded: number }) => void> = {};
        options?.monitor?.({ addEventListener: (name, listener) => { listeners[name] = listener; } });
        listeners.downloadprogress?.({ loaded: 0.4 });
        listeners.downloadprogress?.({ loaded: 1 });
        return session;
      }),
    };
    const adapter = new ChromeLanguageModelAdapter(languageModel);

    await adapter.load((event) => progress.push(event));
    expect(progress).toEqual([
      { phase: 'preparing' },
      { phase: 'downloading', percent: 40 },
      { phase: 'downloading', percent: 100 },
      { phase: 'ready', percent: 100 },
    ]);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('passes a JSON Schema response constraint to Chrome generation', async () => {
    const prompt = vi.fn(async () => '{"title":"Generated"}');
    const adapter = new ChromeLanguageModelAdapter({
      availability: vi.fn(async () => 'available' as const),
      create: vi.fn(async () => ({ prompt })),
    });
    await adapter.load();
    const responseConstraint = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

    await expect(adapter.generate('Compose a dashboard', { responseConstraint })).resolves.toBe('{"title":"Generated"}');
    expect(prompt).toHaveBeenCalledWith('Compose a dashboard', { responseConstraint });
  });

  it('prefers promptStreaming, accumulates delta chunks, and reports partial text', async () => {
    const partials: string[] = [];
    const promptStreaming = vi.fn(async function* () {
      yield '{"root"';
      yield ':"a",';
      yield '"nodes":[]}';
    });
    const adapter = new ChromeLanguageModelAdapter({
      availability: vi.fn(async () => 'available' as const),
      create: vi.fn(async () => ({ prompt: vi.fn(), promptStreaming, destroy: vi.fn() })),
    });
    await adapter.load();

    const output = await adapter.generate('Compose', { onPartial: (text) => partials.push(text) });
    expect(output).toBe('{"root":"a","nodes":[]}');
    expect(partials).toEqual(['{"root"', '{"root":"a",', '{"root":"a","nodes":[]}']);
  });

  it('detects legacy cumulative streaming chunks and does not double-append', async () => {
    const promptStreaming = vi.fn(async function* () {
      yield '{"root"';
      yield '{"root":"a"';
      yield '{"root":"a","nodes":[]}';
    });
    const adapter = new ChromeLanguageModelAdapter({
      availability: vi.fn(async () => 'available' as const),
      create: vi.fn(async () => ({ prompt: vi.fn(), promptStreaming, destroy: vi.fn() })),
    });
    await adapter.load();

    await expect(adapter.generate('Compose', {})).resolves.toBe('{"root":"a","nodes":[]}');
  });

  it('creates each generation session with clamped temperature and topK together', async () => {
    const create = vi.fn(async (_options?: unknown) => ({ prompt: vi.fn(async () => '{}'), destroy: vi.fn() }));
    const adapter = new ChromeLanguageModelAdapter({
      availability: vi.fn(async () => 'available' as const),
      create,
      params: vi.fn(async () => ({ defaultTemperature: 1, maxTemperature: 2, defaultTopK: 3, maxTopK: 8 })),
    });
    await adapter.load();

    await adapter.generate('Compose', { sampler: { temperature: 3.5, topK: 40 } });
    expect(create).toHaveBeenLastCalledWith({ temperature: 2, topK: 8 });

    await adapter.generate('Compose', { sampler: { temperature: 0.4, topK: 3 } });
    expect(create).toHaveBeenLastCalledWith({ temperature: 0.4, topK: 3 });
  });

  it('uses a fresh Prompt API session for each independent generation', async () => {
    const probeSession = { prompt: vi.fn(async () => { throw new Error('destroyed'); }), destroy: vi.fn() };
    const firstSession = { prompt: vi.fn(async () => '{"attempt":1}'), destroy: vi.fn() };
    const secondSession = { prompt: vi.fn(async () => '{"attempt":2}'), destroy: vi.fn() };
    const languageModel: ChromeLanguageModelApiLike = {
      availability: vi.fn(async () => 'available' as const),
      create: vi.fn()
        .mockResolvedValueOnce(probeSession)
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondSession),
    };
    const adapter = new ChromeLanguageModelAdapter(languageModel);
    await adapter.load();

    await expect(adapter.generate('Initial composition', {})).resolves.toBe('{"attempt":1}');
    await expect(adapter.generate('Repair composition', {})).resolves.toBe('{"attempt":2}');
    expect(languageModel.create).toHaveBeenCalledTimes(3);
    expect(probeSession.prompt).not.toHaveBeenCalled();
    expect(probeSession.destroy).toHaveBeenCalledTimes(1);
    expect(firstSession.destroy).toHaveBeenCalledTimes(1);
    expect(secondSession.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the browser does not expose the Prompt API', async () => {
    const adapter = new ChromeLanguageModelAdapter(undefined);

    await expect(adapter.load()).rejects.toThrow(/not available/i);
  });
});
