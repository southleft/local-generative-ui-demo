import type { ModelLoadProgress } from './local-model';

export type ChromeModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** Chrome's web-page sampling presets; the numeric temperature/topK options only apply inside extensions. */
export type ChromeSamplingMode = 'most-predictable' | 'predictable' | 'slightly-predictable' | 'balanced' | 'slightly-creative' | 'creative' | 'most-creative';

export interface ChromeLanguageModelSessionLike {
  prompt(prompt: string, options?: { responseConstraint?: object }): Promise<string>;
  promptStreaming?(prompt: string, options?: { responseConstraint?: object }): AsyncIterable<string> | ReadableStream<string>;
  destroy?: () => void;
  /** Read-backs Chrome exposes on a session; which ones exist depends on the Chrome version and context. */
  samplingMode?: string;
  temperature?: number;
  topK?: number;
  contextWindow?: number;
  contextUsage?: number;
  inputQuota?: number;
}

/** What a generation session actually got, so the workbench can show it instead of assuming. */
export interface ChromeSessionInfo {
  requested: ChromeLanguageModelCreateOptions | undefined;
  samplingMode?: string;
  temperature?: number;
  topK?: number;
  contextWindow?: number;
  contextUsage?: number;
}

interface ChromeDownloadMonitorLike {
  addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
}

export interface ChromeLanguageModelParamsLike {
  defaultTemperature?: number;
  maxTemperature?: number;
  defaultTopK?: number;
  maxTopK?: number;
}

export interface ChromeLanguageModelCreateOptions {
  monitor?: (monitor: ChromeDownloadMonitorLike) => void;
  temperature?: number;
  topK?: number;
  samplingMode?: ChromeSamplingMode;
}

export interface ChromeLanguageModelApiLike {
  availability(options?: unknown): Promise<ChromeModelAvailability>;
  create(options?: ChromeLanguageModelCreateOptions): Promise<ChromeLanguageModelSessionLike>;
  params?(): Promise<ChromeLanguageModelParamsLike | null>;
}

export interface ChromeGenerateOptions {
  responseConstraint?: object;
  /** Called with the full accumulated output after each streamed chunk. */
  onPartial?: (text: string) => void;
  sampler?: { temperature: number; topK: number; samplingMode?: ChromeSamplingMode };
  /** Called once the generation session exists, with the settings Chrome reports for it. */
  onSession?: (info: ChromeSessionInfo) => void;
}

function browserLanguageModel(): ChromeLanguageModelApiLike | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  return (globalThis as typeof globalThis & { LanguageModel?: ChromeLanguageModelApiLike }).LanguageModel;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function collectStream(stream: AsyncIterable<string> | ReadableStream<string>, onPartial?: (text: string) => void): Promise<string> {
  let output = '';
  const iterable = stream as AsyncIterable<string>;
  for await (const chunk of iterable) {
    // Current Chrome streams deltas; early builds streamed the cumulative
    // text. Detect the cumulative shape defensively and replace instead of
    // appending, so neither convention corrupts the output.
    if (output && chunk.length >= output.length && chunk.startsWith(output)) output = chunk;
    else output += chunk;
    onPartial?.(output);
  }
  return output;
}

export class ChromeLanguageModelAdapter {
  constructor(private readonly languageModel: ChromeLanguageModelApiLike | undefined = browserLanguageModel()) {}

  async availability(): Promise<ChromeModelAvailability> {
    if (!this.languageModel) return 'unavailable';
    return this.languageModel.availability();
  }

  async load(onProgress: (progress: ModelLoadProgress) => void = () => undefined): Promise<ChromeLanguageModelSessionLike> {
    if (!this.languageModel) throw new Error('Chrome built-in AI is not available in this browser. Use Chrome 148+ on an eligible desktop, or select LiteRT.');
    const availability = await this.languageModel.availability();
    if (availability === 'unavailable') throw new Error('Chrome built-in AI is unavailable on this device or browser profile. Select LiteRT instead.');

    onProgress({ phase: 'preparing' });
    const session = await this.languageModel.create({
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          const loaded = Math.max(0, Math.min(1, event.loaded));
          onProgress({ phase: 'downloading', percent: Math.round(loaded * 100) });
        });
      },
    });
    onProgress({ phase: 'ready', percent: 100 });
    session.destroy?.();
    return session;
  }

  /**
   * Translate the requested sampling into what this context accepts. Web
   * pages: Chrome ignores the deprecated temperature/topK options and takes a
   * samplingMode preset instead (origin trial). Extensions, recognisable by
   * the params() method still being exposed, take the clamped numbers. The
   * two must never be sent together, which Chrome rejects with a TypeError.
   */
  private async sessionOptions(sampler?: ChromeGenerateOptions['sampler']): Promise<ChromeLanguageModelCreateOptions | undefined> {
    if (!sampler) return undefined;
    if (typeof this.languageModel?.params !== 'function') return sampler.samplingMode ? { samplingMode: sampler.samplingMode } : undefined;
    const params = await this.languageModel.params().catch(() => null);
    const maxTemperature = params?.maxTemperature ?? 2;
    const maxTopK = params?.maxTopK ?? 8;
    // The Prompt API requires temperature and topK to be supplied together.
    return {
      temperature: clamp(sampler.temperature, 0, maxTemperature),
      topK: clamp(Math.round(sampler.topK), 1, maxTopK),
    };
  }

  /** Each generation gets a fresh session so no prior prompt leaks into the next one. */
  async generate(prompt: string, options: ChromeGenerateOptions = {}): Promise<string> {
    if (!this.languageModel) throw new Error('Chrome built-in AI is not available for a new generation session.');
    const createOptions = await this.sessionOptions(options.sampler);
    const activeSession = await this.languageModel.create(createOptions);
    options.onSession?.({
      requested: createOptions,
      samplingMode: activeSession.samplingMode,
      temperature: activeSession.temperature,
      topK: activeSession.topK,
      contextWindow: activeSession.contextWindow ?? activeSession.inputQuota,
      contextUsage: activeSession.contextUsage,
    });
    try {
      const promptOptions = options.responseConstraint ? { responseConstraint: options.responseConstraint } : undefined;
      if (activeSession.promptStreaming) {
        const stream = promptOptions ? activeSession.promptStreaming(prompt, promptOptions) : activeSession.promptStreaming(prompt);
        return await collectStream(stream, options.onPartial);
      }
      const output = promptOptions ? await activeSession.prompt(prompt, promptOptions) : await activeSession.prompt(prompt);
      options.onPartial?.(output);
      return output;
    } finally {
      activeSession.destroy?.();
    }
  }
}
