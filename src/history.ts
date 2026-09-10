/**
 * Browser persistence for completed generation history, the editable prompt
 * blueprints, and the guardrails mode. Stored JSON is validated entry by
 * entry, so one stale record cannot take the rest of the history with it.
 */

import { z } from 'zod';
import { A2uiMessageSchema } from '@a2ui/web_core/v0_9';
import { hasRenderableArtifact, type GenerationRun, type GuardrailsMode } from './generation-types';
import { DEFAULT_PATTERN_LIBRARY, PATTERN_KEYS, type PatternKey, type PatternLibrary } from './prompt';
import { rawOutputForMessages } from './run-surface';
import { compositionSchema } from './salvage';

export const HISTORY_STORAGE_KEY = 'local-ui-composer-history-v1';
export const PATTERN_LIBRARY_STORAGE_KEY = 'local-ui-composer-pattern-library-v1';
export const GUARDRAILS_STORAGE_KEY = 'local-ui-composer-guardrails-v1';
export const HISTORY_LIMIT = 20;

const guardrailsModeSchema = z.enum(['recover', 'strict']);
const patternDefinitionSchema = z.object({ keywords: z.array(z.string()), blueprint: z.string() }).strict();
const patternShape = Object.fromEntries(PATTERN_KEYS.map((key) => [key, patternDefinitionSchema])) as { [Key in PatternKey]: typeof patternDefinitionSchema };
const patternLibrarySchema: z.ZodType<PatternLibrary> = z.object({ generic: z.string(), patterns: z.object(patternShape).strict() }).strict();

/**
 * Only runs that rendered are stored: a model run keeps its validated
 * composition, a fixture run keeps the official message stream. Unknown keys
 * are stripped rather than rejected so records written by earlier versions of
 * the app keep loading.
 */
const persistedRunSchema = z.object({
  prompt: z.string(),
  take: z.number().int().positive(),
  providerLabel: z.string(),
  composition: compositionSchema.optional(),
  a2uiMessages: z.array(A2uiMessageSchema).min(1).max(4).optional(),
  warnings: z.array(z.string()).default([]),
  rawOutput: z.string().optional(),
}).refine((run) => run.composition !== undefined || run.a2uiMessages !== undefined, 'a stored run needs a composition or a message stream');

type PersistedRun = z.infer<typeof persistedRunSchema>;

function readJsonFromStorage(key: string): unknown {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Browser storage is best-effort; quota or privacy settings must not break the app.
  }
}

function fallbackRawOutput(entry: PersistedRun): string {
  if (entry.composition) return JSON.stringify({ root: entry.composition.root, nodes: entry.composition.nodes }, null, 2);
  return entry.a2uiMessages ? rawOutputForMessages(entry.a2uiMessages) : '';
}

export function loadPatternLibrary(): PatternLibrary {
  const parsed = patternLibrarySchema.safeParse(readJsonFromStorage(PATTERN_LIBRARY_STORAGE_KEY));
  return parsed.success ? parsed.data : DEFAULT_PATTERN_LIBRARY;
}

export function persistPatternLibrary(library: PatternLibrary): void {
  writeStorage(PATTERN_LIBRARY_STORAGE_KEY, JSON.stringify(library));
}

export function loadGuardrailsMode(): GuardrailsMode {
  try {
    const parsed = guardrailsModeSchema.safeParse(typeof localStorage === 'undefined' ? undefined : localStorage.getItem(GUARDRAILS_STORAGE_KEY));
    return parsed.success ? parsed.data : 'recover';
  } catch {
    return 'recover';
  }
}

export function persistGuardrailsMode(mode: GuardrailsMode): void {
  writeStorage(GUARDRAILS_STORAGE_KEY, mode);
}

/** Restore stored runs as completed history; the surface is compiled lazily when a run is activated. */
export function loadPersistedRuns(): GenerationRun[] {
  const stored = z.array(z.unknown()).safeParse(readJsonFromStorage(HISTORY_STORAGE_KEY));
  if (!stored.success) return [];
  return stored.data
    .flatMap((entry) => {
      const parsed = persistedRunSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(-HISTORY_LIMIT)
    .map((entry, index) => ({
      id: index + 1,
      prompt: entry.prompt,
      take: entry.take,
      providerLabel: entry.providerLabel,
      status: 'done' as const,
      composition: entry.composition,
      a2uiMessages: entry.a2uiMessages,
      warnings: entry.warnings,
      errors: [],
      exchanges: [],
      rawOutput: entry.rawOutput ?? fallbackRawOutput(entry),
    }));
}

/** Persist the runs that rendered. Failed runs stay in the session log only, so they can never evict a good take. */
export function persistCompletedRuns(runs: GenerationRun[]): void {
  const persisted: PersistedRun[] = runs
    .filter((run) => run.status === 'done' && hasRenderableArtifact(run))
    .slice(-HISTORY_LIMIT)
    .map((run) => ({
      prompt: run.prompt,
      take: run.take,
      providerLabel: run.providerLabel,
      composition: run.composition,
      a2uiMessages: run.a2uiMessages,
      warnings: run.warnings,
      rawOutput: run.rawOutput,
    }));
  writeStorage(HISTORY_STORAGE_KEY, JSON.stringify(persisted));
}
