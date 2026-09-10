/**
 * The two inference providers behind one interface: LiteRT-LM.js running a
 * Gemma artifact on WebGPU, and Chrome's built-in Prompt API. The app only
 * ever sees this interface; the engine handle is opaque and is handed back to
 * the provider that produced it.
 */

import { ChromeLanguageModelAdapter, type ChromeLanguageModelSessionLike } from './chrome-language-model';
import { generateModelText, hasWebGpu, loadLiteRtModel, type LiteRtEngineLike, type LiteRtModelDefinition, type ModelGenerationEvent, type ModelLoadProgress } from './local-model';

/** Sampling the Chrome Prompt API accepts. LiteRT-LM 0.14 decodes greedily on WebGPU and takes no sampler. */
export interface SamplerSettings {
  temperature: number;
  topK: number;
}

export interface GenerateOptions {
  onEvent?: (event: ModelGenerationEvent) => void;
  /** Called with the full accumulated output after every streamed chunk. */
  onPartial?: (text: string) => void;
  /** JSON Schema the runtime enforces natively when it can (Chrome); LiteRT receives it as prompt text. */
  responseConstraint?: object;
  sampler?: SamplerSettings;
}

export type ModelEngine = LiteRtEngineLike | ChromeLanguageModelSessionLike;

export interface ModelProvider {
  hasWebGpu(): boolean;
  load(onProgress: (progress: ModelLoadProgress) => void, model?: LiteRtModelDefinition): Promise<ModelEngine>;
  generate(engine: ModelEngine, prompt: string, options: GenerateOptions): Promise<string>;
}

export const liteRtProvider: ModelProvider = {
  hasWebGpu,
  load: (onProgress, model) => loadLiteRtModel({ onProgress, model }),
  generate: (engine, prompt, options) => generateModelText(engine as LiteRtEngineLike, prompt, options),
};

const chromeAdapter = new ChromeLanguageModelAdapter();

export const chromeProvider: ModelProvider = {
  hasWebGpu: () => true,
  load: (onProgress) => chromeAdapter.load(onProgress),
  generate: async (_engine, prompt, options) => {
    options.onEvent?.({ type: 'conversation-created' });
    options.onEvent?.({ type: 'prompt-sent', characters: prompt.length });
    const output = await chromeAdapter.generate(prompt, { responseConstraint: options.responseConstraint, onPartial: options.onPartial, sampler: options.sampler });
    options.onEvent?.({ type: 'chunk-received', chunkIndex: 1, characters: output.length, totalCharacters: output.length });
    options.onEvent?.({ type: 'generation-complete', chunkIndex: 1, totalCharacters: output.length });
    return output;
  },
};
