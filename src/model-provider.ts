/**
 * The two inference providers behind one interface: LiteRT-LM.js running a
 * Gemma artifact on WebGPU, and Chrome's built-in Prompt API. The app only
 * ever sees this interface; the engine handle is opaque and is handed back to
 * the provider that produced it.
 */

import { ChromeLanguageModelAdapter, type ChromeLanguageModelSessionLike, type ChromeSamplingMode, type ChromeSessionInfo } from './chrome-language-model';
import { generateModelText, hasWebGpu, loadLiteRtModel, type LiteRtEngineLike, type LiteRtModelDefinition, type ModelGenerationEvent, type ModelLoadProgress } from './local-model';

/**
 * Sampling requested from the Chrome Prompt API. Web pages only honour the
 * samplingMode preset (and only inside the sampling origin trial); the numeric
 * temperature/topK apply inside extensions. LiteRT-LM 0.14 decodes greedily
 * on WebGPU and takes no sampler.
 */
export interface SamplerSettings {
  temperature: number;
  topK: number;
  samplingMode?: ChromeSamplingMode;
}

/** One line for the debug trace saying what a Chrome session actually got. */
export function describeChromeSession(info: ChromeSessionInfo): string {
  const parts: string[] = [];
  const requested = info.requested;
  if (info.samplingMode) {
    parts.push(`sampling ${info.samplingMode}${requested?.samplingMode && requested.samplingMode !== info.samplingMode ? ` (requested ${requested.samplingMode})` : ''}`);
  } else if (info.temperature !== undefined) {
    parts.push(`temperature ${info.temperature} · topK ${info.topK}`);
  } else if (requested?.samplingMode) {
    parts.push(`requested sampling ${requested.samplingMode}; Chrome reports none, so the sampling origin trial is not active on this origin`);
  } else if (requested?.temperature !== undefined) {
    parts.push(`temperature ${requested.temperature} requested; Chrome ignores it on web pages`);
  } else {
    parts.push('Chrome default sampling');
  }
  if (info.contextWindow !== undefined) parts.push(`context window ${info.contextWindow.toLocaleString()} tokens${info.contextUsage !== undefined ? ` (${info.contextUsage.toLocaleString()} used)` : ''}`);
  return parts.join(' · ');
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
    const output = await chromeAdapter.generate(prompt, {
      responseConstraint: options.responseConstraint,
      onPartial: options.onPartial,
      sampler: options.sampler,
      onSession: (info) => {
        options.onEvent?.({ type: 'conversation-created', detail: describeChromeSession(info) });
        options.onEvent?.({ type: 'prompt-sent', characters: prompt.length });
      },
    });
    options.onEvent?.({ type: 'chunk-received', chunkIndex: 1, characters: output.length, totalCharacters: output.length });
    options.onEvent?.({ type: 'generation-complete', chunkIndex: 1, totalCharacters: output.length });
    return output;
  },
};
