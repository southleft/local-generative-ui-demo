/**
 * Shared UI-layer types for runs, provider selection, preview tabs, and the
 * lazily compiled A2UI surface shown by the workbench.
 */

import type { A2uiMessage, A2uiSurfaceHandle } from './a2ui-protocol';
import type { LiteRtModelDefinition } from './local-model';
import type { CatalogComposition } from './salvage';

export type InferenceProvider = 'litert' | 'chrome';
export type AppStatus = 'idle' | 'loading' | 'ready' | 'generating' | 'rendered' | 'error';
export type PreviewTab = 'surface' | 'catalog' | 'harness';
export type GuardrailsMode = 'recover' | 'strict';
export type EngineKey = 'chrome' | LiteRtModelDefinition['id'];

export interface GenerationExchange {
  id: number;
  attempt: number;
  provider: string;
  model: string;
  protocol: string;
  request: string;
  prompt: string;
  responseConstraint?: object;
  nativeConstraint: boolean;
  response?: string;
  rendererPayload?: unknown;
  error?: string;
}

export interface GenerationRun {
  id: number;
  prompt: string;
  take: number;
  providerLabel: string;
  status: 'streaming' | 'refining' | 'done' | 'failed';
  composition?: CatalogComposition;
  a2uiMessages?: A2uiMessage[];
  warnings: string[];
  errors: string[];
  exchanges: GenerationExchange[];
  rawOutput: string;
}

/** A run materialized through the official processor, plus what the debug trace reports about it. */
export interface CompiledRunSurface extends A2uiSurfaceHandle {
  runId: number;
  messageCount: number;
  messageKinds: string[];
}

export function hasRenderableArtifact(run: GenerationRun | null | undefined): boolean {
  return Boolean(run?.composition ?? run?.a2uiMessages);
}
