/**
 * State controller for the workbench. It owns model loading, generation,
 * streaming preview updates, salvage/repair, lazy A2UI surface compilation,
 * and the prop bundles consumed by presentational sections.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compileToA2ui } from './a2ui-protocol';
import type { ControlPanelProps } from './control-panel';
import type { AppStatus, CompiledRunSurface, EngineKey, GenerationExchange, GenerationRun, GuardrailsMode, InferenceProvider, PreviewTab } from './generation-types';
import { hasRenderableArtifact } from './generation-types';
import { HISTORY_LIMIT, loadGuardrailsMode, loadPatternLibrary, loadPersistedRuns, persistGuardrailsMode, persistPatternLibrary, persistCompletedRuns } from './history';
import type { InspectorSectionProps } from './inspector-section';
import { DEFAULT_LITERT_MODEL, LITERT_MODELS, clearCachedModel, getCachedModelState, type LiteRtModelDefinition, type ModelGenerationEvent, type ModelLoadProgress } from './local-model';
import { chromeProvider, liteRtProvider, type ModelEngine, type ModelProvider, type SamplerSettings } from './model-provider';
import type { PreviewPanelProps } from './preview-panel';
import { RESPONSE_CONSTRAINT, buildCompositionPrompt, buildRepairPrompt, type PatternLibrary } from './prompt';
import type { DebugEntry } from './prototype-panels';
import { compileRunSurface, rawOutputForMessages, validateA2uiMessages } from './run-surface';
import { parseComposition, parseCompositionStrict } from './salvage';
import { getA2uiSample, SCENARIOS, type ScenarioId } from './sample-messages';
import { postSessionLog } from './session-log';
import { createStreamingComposer, type StreamingComposer, type StreamingSurface } from './streaming';

const PROTOCOL_LABEL = 'A2UI v0.9';
const CHROME_FOCUSED_SAMPLER: SamplerSettings = { temperature: 0.4, topK: 3 };
const CHROME_REPAIR_SAMPLER: SamplerSettings = { temperature: 0.2, topK: 3 };
const FIXTURE_SCENARIOS: ScenarioId[] = ['dashboard', 'audit', 'decision'];
const EMPTY_EXCHANGES: GenerationExchange[] = [];

type RunUpdate = Partial<GenerationRun> | ((run: GenerationRun) => Partial<GenerationRun>);
type SurfaceResult = { status: 'ready'; surface: CompiledRunSurface } | { status: 'error'; runId: number; message: string } | null;

export interface ComposerWorkbenchOptions {
  modelApi?: ModelProvider;
  chromeModelApi?: ModelProvider;
}

export interface ComposerWorkbench {
  controlPanel: ControlPanelProps;
  previewPanel: PreviewPanelProps;
  inspectorSection: InspectorSectionProps;
}

function applyRunUpdate(run: GenerationRun, update: RunUpdate): GenerationRun {
  return { ...run, ...(typeof update === 'function' ? update(run) : update) };
}

export function useComposerWorkbench({ modelApi = liteRtProvider, chromeModelApi = chromeProvider }: ComposerWorkbenchOptions): ComposerWorkbench {
  const [inferenceProvider, setInferenceProvider] = useState<InferenceProvider>('litert');
  const [selectedModelId, setSelectedModelId] = useState<LiteRtModelDefinition['id']>(DEFAULT_LITERT_MODEL.id);
  const [prompt, setPrompt] = useState('');
  const [runs, setRuns] = useState<GenerationRun[]>(() => loadPersistedRuns());
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [engines, setEngines] = useState<Partial<Record<EngineKey, ModelEngine>>>({});
  const [modelProgress, setModelProgress] = useState<ModelLoadProgress | null>(null);
  const [modelCached, setModelCached] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [lastAction, setLastAction] = useState('No interaction yet');
  const [previewTab, setPreviewTab] = useState<PreviewTab>('surface');
  const [streamingSurface, setStreamingSurface] = useState<StreamingSurface | null>(null);
  const [streamTicker, setStreamTicker] = useState<string[]>([]);
  const [patternLibrary, setPatternLibrary] = useState<PatternLibrary>(() => loadPatternLibrary());
  const [fixtureIndex, setFixtureIndex] = useState(0);
  const [guardrailsMode, setGuardrailsMode] = useState<GuardrailsMode>(() => loadGuardrailsMode());
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([
    { id: 0, time: '00:00.000', source: 'system', message: 'Prototype ready', detail: 'Describe any interface, or run the deterministic integration check.' },
  ]);
  const debugSequence = useRef(1);
  const debugStart = useRef(performance.now());
  const lastProgressLog = useRef('');
  const runSequence = useRef(Math.max(0, ...runs.map((run) => run.id)) + 1);
  const exchangeSequence = useRef(1);
  const activeGenerationRef = useRef<number | null>(null);
  const composerRef = useRef<StreamingComposer | null>(null);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptForensics = useRef<Record<number, Array<{ attempt: number; prompt: string; response?: string; error?: string }>>>({});
  const loggedSurfaceRuns = useRef<Set<number>>(new Set());

  const selectedModel = LITERT_MODELS.find((model) => model.id === selectedModelId) ?? DEFAULT_LITERT_MODEL;
  const activeEngineKey: EngineKey = inferenceProvider === 'chrome' ? 'chrome' : selectedModel.id;
  const engine = engines[activeEngineKey] ?? null;
  const activeModelApi = inferenceProvider === 'chrome' ? chromeModelApi : modelApi;
  const activeModelLabel = inferenceProvider === 'chrome' ? 'Chrome built-in AI' : selectedModel.label;
  const selectedModelSize = `${(selectedModel.sizeBytes / 1_000_000_000).toFixed(selectedModel.sizeBytes < 1_000_000_000 ? 2 : 1)} GB`;
  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;
  const isGenerating = status === 'generating';

  const log = useCallback((source: DebugEntry['source'], message: string, detail?: string) => {
    const elapsed = performance.now() - debugStart.current;
    const minutes = Math.floor(elapsed / 60_000).toString().padStart(2, '0');
    const seconds = ((elapsed % 60_000) / 1_000).toFixed(3).padStart(6, '0');
    const entry: DebugEntry = { id: debugSequence.current++, time: `${minutes}:${seconds}`, source, message, detail };
    setDebugEntries((entries) => [...entries.slice(-199), entry]);
  }, []);

  const updateRun = useCallback((runId: number, update: RunUpdate) => {
    setRuns((current) => current.map((run) => run.id === runId ? applyRunUpdate(run, update) : run));
  }, []);

  const updateTerminalRun = useCallback((runId: number, update: RunUpdate) => {
    setRuns((current) => {
      const next = current.map((run) => run.id === runId ? applyRunUpdate(run, update) : run);
      persistCompletedRuns(next);
      return next;
    });
  }, []);

  const appendRun = useCallback((run: GenerationRun, persist: boolean) => {
    setRuns((current) => {
      const next = [...current.slice(-HISTORY_LIMIT + 1), run];
      if (persist) persistCompletedRuns(next);
      return next;
    });
  }, []);

  const handleA2uiAction = useCallback((event: { name: string }) => {
    setLastAction(`Action received: ${event.name}`);
    log('a2ui', `Action received: ${event.name}`);
  }, [log]);

  const activeSurfaceKey = activeRun && hasRenderableArtifact(activeRun) ? activeRun.id : null;
  const activeSurfaceResult = useMemo<SurfaceResult>(() => {
    if (!activeRun || activeSurfaceKey === null) return null;
    try {
      const surface = compileRunSurface(activeRun, handleA2uiAction);
      return surface ? { status: 'ready', surface } : null;
    } catch (error) {
      return { status: 'error', runId: activeRun.id, message: error instanceof Error ? error.message : 'The A2UI processor rejected the message stream.' };
    }
  }, [activeSurfaceKey, handleA2uiAction]);
  const compiledSurface = activeSurfaceResult?.status === 'ready' ? activeSurfaceResult.surface : null;

  useEffect(() => {
    let cancelled = false;
    if (inferenceProvider !== 'litert') {
      setModelCached(false);
      return;
    }
    getCachedModelState(selectedModel).then((state) => {
      if (!cancelled) setModelCached(state.cached);
    });
    return () => {
      cancelled = true;
    };
  }, [inferenceProvider, selectedModel, status]);

  useEffect(() => {
    if (!activeSurfaceResult) return;
    if (activeSurfaceResult.status === 'error') {
      setErrors([activeSurfaceResult.message]);
      setStatus('error');
      log('a2ui', 'A2UI processor rejected the stored run', activeSurfaceResult.message);
      return;
    }
    if (loggedSurfaceRuns.current.has(activeSurfaceResult.surface.runId)) return;
    loggedSurfaceRuns.current.add(activeSurfaceResult.surface.runId);
    log('a2ui', 'Sending A2UI v0.9 message stream to the official processor', `${activeSurfaceResult.surface.messageCount} messages · ${activeSurfaceResult.surface.messageKinds.join(' → ')}`);
    log('a2ui', `@a2ui/web_core built surface ${activeSurfaceResult.surface.surfaceId}`, `${activeSurfaceResult.surface.componentCount} components accepted by the catalog`);
  }, [activeSurfaceResult, log]);

  const changePatternLibrary = useCallback((next: PatternLibrary) => {
    setPatternLibrary(next);
    persistPatternLibrary(next);
  }, []);

  const chooseGuardrailsMode = useCallback((next: GuardrailsMode) => {
    if (next === guardrailsMode || isGenerating) return;
    setGuardrailsMode(next);
    persistGuardrailsMode(next);
    log('system', next === 'strict' ? 'Guardrails set to strict' : 'Guardrails set to recover', next === 'strict'
      ? 'Raw model output must survive plain JSON.parse and the strict schemas — no repair, coercion, or salvage. The live preview is off because it is itself a salvage product.'
      : 'Full salvage restored: repair, generous interpretation, reconstruction, and cleanup, with every adjustment logged.');
  }, [guardrailsMode, isGenerating, log]);

  const chooseInferenceProvider = useCallback((nextProvider: InferenceProvider) => {
    if (nextProvider === inferenceProvider || isGenerating) return;
    const nextEngineKey: EngineKey = nextProvider === 'chrome' ? 'chrome' : selectedModel.id;
    const nextEngine = engines[nextEngineKey];
    setInferenceProvider(nextProvider);
    setModelProgress(null);
    setStatus(nextEngine ? 'ready' : hasRenderableArtifact(activeRun) ? 'rendered' : 'idle');
    setErrors([]);
    log('system', `Selected ${nextProvider === 'chrome' ? 'Chrome built-in AI' : 'LiteRT-LM'}`, nextEngine ? 'Reusing the model already loaded in this page.' : 'Load the selected local model before generating.');
  }, [activeRun, engines, inferenceProvider, isGenerating, log, selectedModel.id]);

  const chooseLiteRtModel = useCallback((nextModelId: LiteRtModelDefinition['id']) => {
    if (isGenerating) return;
    const nextEngine = engines[nextModelId];
    setSelectedModelId(nextModelId);
    setModelProgress(null);
    setStatus(nextEngine ? 'ready' : hasRenderableArtifact(activeRun) ? 'rendered' : 'idle');
    setErrors([]);
    const nextModel = LITERT_MODELS.find((model) => model.id === nextModelId);
    log('model', `Selected ${nextModel?.label ?? nextModelId}`, nextEngine ? 'Reusing the model already loaded in this page.' : 'The artifact remains lazy until you explicitly load it.');
  }, [activeRun, engines, isGenerating, log]);

  const restoreRun = useCallback((runId: number) => {
    if (isGenerating) return;
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    setActiveRunId(runId);
    setPrompt(run.prompt);
    setPreviewTab('surface');
    setStatus(run.status === 'failed' ? 'error' : hasRenderableArtifact(run) ? 'rendered' : engine ? 'ready' : 'idle');
    setErrors(run.errors);
    log('system', `Restored take ${run.take}`, run.prompt.slice(0, 120));
  }, [engine, isGenerating, log, runs]);

  const handleLoadProgress = useCallback((progress: ModelLoadProgress) => {
    setModelProgress(progress);
    const bucket = progress.phase === 'downloading' ? Math.floor((progress.percent ?? 0) / 10) * 10 : progress.phase;
    const signature = `${progress.phase}:${bucket}`;
    if (signature === lastProgressLog.current) return;
    lastProgressLog.current = signature;
    const detail = progress.phase === 'downloading'
      ? progress.percent === undefined ? `${progress.loadedBytes ?? 0} bytes received` : `${progress.percent}% downloaded`
      : progress.phase === 'compiling' ? (progress.fromCache ? 'Artifact served from browser cache; initializing LiteRT and WebGPU.' : 'Download complete; initializing LiteRT and WebGPU.') : undefined;
    log('model', progress.phase === 'compiling' ? `Compiling ${activeModelLabel} for WebGPU` : `${activeModelLabel} ${progress.phase}`, detail);
  }, [activeModelLabel, log]);

  const loadModel = useCallback(async () => {
    if (!activeModelApi.hasWebGpu()) {
      const message = 'WebGPU is not available in this browser. Use deterministic mode or a WebGPU-capable Chrome browser.';
      setErrors([message]);
      setStatus('error');
      log('model', 'Model load blocked', message);
      return;
    }
    setErrors([]);
    setStatus('loading');
    log('model', `Starting ${activeModelLabel} load`, inferenceProvider === 'chrome' ? 'Chrome manages model eligibility, download, and storage.' : `${selectedModelSize} LiteRT artifact · ${modelCached ? 'cached in this browser' : 'network download'} · ${selectedModel.contextTokens.toLocaleString()} token context`);
    try {
      const loadedEngine = await activeModelApi.load(handleLoadProgress, inferenceProvider === 'litert' ? selectedModel : undefined);
      setEngines((current) => ({ ...current, [activeEngineKey]: loadedEngine }));
      setStatus('ready');
      log('model', `${activeModelLabel} loaded and ready`, 'Inference remains in this browser.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The local model could not be loaded.';
      setErrors([message]);
      setStatus('error');
      log('model', 'Model load failed', message);
    }
  }, [activeEngineKey, activeModelApi, activeModelLabel, handleLoadProgress, inferenceProvider, log, modelCached, selectedModel, selectedModelSize]);

  const clearModelCache = useCallback(async () => {
    const cleared = await clearCachedModel(selectedModel);
    setModelCached(false);
    log('model', cleared ? `Cleared cached ${selectedModel.label} artifact` : 'No cached artifact to clear', cleared ? 'The next load downloads from the network again.' : undefined);
  }, [log, selectedModel]);

  const runSample = useCallback(() => {
    if (isGenerating) return;
    setErrors([]);
    const scenario = FIXTURE_SCENARIOS[fixtureIndex % FIXTURE_SCENARIOS.length];
    setFixtureIndex((index) => index + 1);
    log('system', 'Running deterministic integration check', `${SCENARIOS[scenario].label} fixture · bypasses the model entirely.`);
    try {
      const messages = getA2uiSample(scenario);
      validateA2uiMessages(messages);
      const runId = runSequence.current++;
      const rawOutput = rawOutputForMessages(messages);
      appendRun({
        id: runId,
        prompt: `Deterministic integration fixture · ${SCENARIOS[scenario].label}`,
        take: 1,
        providerLabel: 'Deterministic fixture',
        status: 'done',
        a2uiMessages: messages,
        warnings: [],
        errors: [],
        exchanges: [],
        rawOutput,
      }, true);
      setActiveRunId(runId);
      setPreviewTab('surface');
      setStatus('rendered');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The deterministic sample failed.';
      log('system', 'Deterministic sample failed', message);
      setErrors([message]);
      setStatus('error');
    }
  }, [appendRun, fixtureIndex, isGenerating, log]);

  const flagActiveRun = useCallback(() => {
    if (!activeRun) return;
    const note = window.prompt('What looks wrong (or interesting) about this run? The note and full run go to the session log for review.') ?? '';
    postSessionLog({
      type: 'flag',
      origin: typeof location !== 'undefined' ? location.origin : 'unknown',
      runId: activeRun.id,
      note,
      prompt: activeRun.prompt,
      take: activeRun.take,
      provider: activeRun.providerLabel,
      status: activeRun.status,
      warnings: activeRun.warnings,
      errors: activeRun.errors,
      composition: activeRun.composition ?? null,
      rawOutput: activeRun.rawOutput,
    });
    log('system', 'Run flagged for review', note || 'No note added.');
    setLastAction('Run flagged for review');
  }, [activeRun, log]);

  function logGenerationEvent(event: ModelGenerationEvent) {
    if (event.type === 'conversation-created') log('model', `Created ${inferenceProvider === 'chrome' ? 'Chrome Prompt API session' : 'LiteRT conversation'}`);
    if (event.type === 'prompt-sent') log('model', `Sent framework prompt to ${activeModelLabel}`, `${event.characters ?? 0} characters`);
    if (event.type === 'generation-cancelled') log('model', 'Stopped the model stream early', `${event.reason ?? 'runaway output'} · rendering what arrived`);
    if (event.type === 'generation-complete') {
      const chunkCount = event.chunkIndex ?? 0;
      log('model', 'Model stream complete', `${chunkCount} ${chunkCount === 1 ? 'chunk' : 'chunks'} · ${event.totalCharacters ?? 0} characters`);
    }
  }

  function handlePartialOutput(runId: number, text: string) {
    if (activeGenerationRef.current !== runId || !composerRef.current || throttleTimer.current) return;
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null;
      if (activeGenerationRef.current !== runId || !composerRef.current) return;
      const { surface, added } = composerRef.current.update(text);
      if (surface.nodes.size) setStreamingSurface(surface);
      if (added.length) setStreamTicker((current) => [...current, ...added.map((node) => node.component)].slice(-6));
    }, 140);
  }

  function flushStreaming(runId: number, text: string) {
    if (throttleTimer.current) {
      clearTimeout(throttleTimer.current);
      throttleTimer.current = null;
    }
    if (activeGenerationRef.current !== runId || !composerRef.current) return;
    const { surface } = composerRef.current.update(text);
    if (surface.nodes.size) setStreamingSurface(surface);
  }

  async function generateAttempt(runId: number, request: string, generationPrompt: string, sampler: SamplerSettings | undefined, attempt: number, loadedEngine: ModelEngine): Promise<string> {
    const adaptedPrompt = inferenceProvider === 'litert'
      ? `${generationPrompt}\n\nTransport-only JSON Schema (follow this exact outer shape; you still choose every node and relationship):\n${JSON.stringify(RESPONSE_CONSTRAINT)}`
      : generationPrompt;
    const exchange: GenerationExchange = {
      id: exchangeSequence.current++,
      attempt,
      provider: inferenceProvider === 'chrome' ? 'Chrome Prompt API' : 'LiteRT-LM.js',
      model: activeModelLabel,
      protocol: `${PROTOCOL_LABEL} from a free-form request`,
      request: request.slice(0, 200),
      prompt: adaptedPrompt,
      responseConstraint: RESPONSE_CONSTRAINT,
      nativeConstraint: inferenceProvider === 'chrome',
    };
    updateRun(runId, (run) => ({ exchanges: [...run.exchanges, exchange] }));
    const forensics = attemptForensics.current[runId] ??= [];
    try {
      const output = await activeModelApi.generate(loadedEngine, adaptedPrompt, {
        onEvent: logGenerationEvent,
        onPartial: (text) => handlePartialOutput(runId, text),
        responseConstraint: RESPONSE_CONSTRAINT,
        sampler,
      });
      flushStreaming(runId, output);
      updateRun(runId, (run) => ({ exchanges: run.exchanges.map((item) => item.id === exchange.id ? { ...item, response: output } : item) }));
      forensics.push({ attempt, prompt: adaptedPrompt, response: output });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model generation failed.';
      updateRun(runId, (run) => ({ exchanges: run.exchanges.map((item) => item.id === exchange.id ? { ...item, error: message } : item) }));
      forensics.push({ attempt, prompt: adaptedPrompt, error: message });
      throw error;
    }
  }

  const generate = useCallback(async (requestOverride?: string) => {
    const request = (requestOverride ?? prompt).trim();
    const loadedEngine = engine;
    if (!loadedEngine || !request || isGenerating) return;
    if (requestOverride) setPrompt(requestOverride);
    const runId = runSequence.current++;
    const take = runs.filter((run) => run.prompt.trim() === request).length + 1;
    const run: GenerationRun = {
      id: runId,
      prompt: request,
      take,
      providerLabel: activeModelLabel,
      status: 'streaming',
      warnings: [],
      errors: [],
      exchanges: [],
      rawOutput: '',
    };
    appendRun(run, false);
    setActiveRunId(runId);
    activeGenerationRef.current = runId;
    const startedAt = performance.now();
    const mode = guardrailsMode;
    const runContext = { type: 'run', origin: typeof location !== 'undefined' ? location.origin : 'unknown', runId, prompt: request, take, provider: activeModelLabel, protocol: 'a2ui-v0.9', guardrails: mode };
    composerRef.current = mode === 'strict' ? null : createStreamingComposer();
    setStreamingSurface(null);
    setStreamTicker([]);
    setErrors([]);
    setStatus('generating');
    setPreviewTab('surface');
    log('system', `Starting ${PROTOCOL_LABEL} generation${take > 1 ? ` · take ${take}` : ''}${mode === 'strict' ? ' · strict guardrails' : ''}`, request);

    const sampler = inferenceProvider === 'chrome' ? CHROME_FOCUSED_SAMPLER : undefined;
    const generationPrompt = buildCompositionPrompt(request, { schemaEnforced: inferenceProvider === 'chrome', patternLibrary });
    log('a2ui', 'Built free-form catalog prompt', `${generationPrompt.length} characters · focused decoding, established patterns preferred · model chooses content and composition`);

    const acceptComposition = (output: string, repaired: boolean) => {
      const { composition, warnings } = (mode === 'strict' ? parseCompositionStrict : parseComposition)(output);
      const selection = [...new Set(composition.nodes.map((node) => node.component))].join(', ');
      const messages = compileToA2ui(composition);
      validateA2uiMessages(messages);
      log('a2ui', `Compiled ${repaired ? 'repaired ' : ''}model-selected components into A2UI v0.9`, `${composition.nodes.length} components · ${selection}`);
      if (warnings.length) log('a2ui', `Salvage adjusted the composition (${warnings.length})`, warnings.slice(0, 5).join(' · '));
      updateTerminalRun(runId, (current) => ({
        status: 'done',
        composition,
        warnings,
        errors: [],
        rawOutput: output,
        exchanges: current.exchanges.map((exchange, index) => index === current.exchanges.length - 1 ? { ...exchange, rendererPayload: messages } : exchange),
      }));
      postSessionLog({
        ...runContext,
        status: 'done',
        durationMs: Math.round(performance.now() - startedAt),
        warnings,
        nodeCount: composition.nodes.length,
        componentsUsed: [...new Set(composition.nodes.map((node) => node.component))],
        composition,
        attempts: attemptForensics.current[runId] ?? [],
      });
    };

    try {
      let output = await generateAttempt(runId, request, generationPrompt, sampler, 1, loadedEngine);
      updateRun(runId, { rawOutput: output });
      let repairCount = 0;
      while (true) {
        try {
          acceptComposition(output, repairCount > 0);
          break;
        } catch (validationError) {
          if (repairCount >= 2) throw validationError;
          const message = validationError instanceof Error ? validationError.message : 'Unknown validation error';
          repairCount += 1;
          updateRun(runId, { status: 'refining' });
          log('a2ui', `Requesting graph repair ${repairCount}/2`, message);
          composerRef.current = createStreamingComposer();
          output = await generateAttempt(runId, request, buildRepairPrompt(request, output, message.split('\n'), { schemaEnforced: inferenceProvider === 'chrome', patternLibrary }), inferenceProvider === 'chrome' ? CHROME_REPAIR_SAMPLER : undefined, repairCount + 1, loadedEngine);
          updateRun(runId, { rawOutput: output });
        }
      }
      setStatus('rendered');
      log('system', `${PROTOCOL_LABEL} generation complete`, 'Validated surface is visible and saved to history.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The model output was rejected.';
      updateTerminalRun(runId, { status: 'failed', errors: [message] });
      setErrors([message]);
      setStatus('error');
      log('system', `${PROTOCOL_LABEL} generation failed`, message);
      postSessionLog({ ...runContext, status: 'failed', durationMs: Math.round(performance.now() - startedAt), error: message, attempts: attemptForensics.current[runId] ?? [] });
    } finally {
      delete attemptForensics.current[runId];
      if (activeGenerationRef.current === runId) {
        activeGenerationRef.current = null;
        composerRef.current = null;
        setStreamingSurface(null);
        setStreamTicker([]);
      }
    }
  }, [activeModelApi, activeModelLabel, appendRun, engine, guardrailsMode, inferenceProvider, isGenerating, log, patternLibrary, prompt, runs, updateRun, updateTerminalRun]);

  const currentStatusLabel = useMemo(() => {
    if (status === 'idle') return 'Describe an interface to begin';
    if (status === 'ready') return `${activeModelLabel} loaded in this browser`;
    if (status === 'generating') return activeRun?.status === 'refining' ? 'Refining the composition…' : `Composing with ${activeModelLabel}…`;
    if (status === 'rendered') return activeRun ? `Take ${activeRun.take} · ${PROTOCOL_LABEL} surface` : 'Surface ready';
    if (status === 'error') return 'Generation needs attention';
    return modelProgress?.phase === 'compiling'
      ? `Compiling ${activeModelLabel} for WebGPU…`
      : modelProgress?.phase === 'downloading'
        ? `Downloading ${activeModelLabel}…`
        : `Preparing ${activeModelLabel}…`;
  }, [activeModelLabel, activeRun, modelProgress, status]);
  const showStreaming = isGenerating && streamingSurface !== null && streamingSurface.nodes.size > 0;
  const streamingPhase = activeRun?.status === 'refining'
    ? `Refining composition · attempt ${activeRun.exchanges.length}`
    : guardrailsMode === 'strict' && isGenerating ? 'Strict mode · streaming raw output, no salvage preview'
    : streamTicker.length ? `Composing · ${streamTicker.join(' → ')}` : 'The model is choosing components…';
  const activeExchanges = activeRun?.exchanges ?? EMPTY_EXCHANGES;

  const requestLoadModel = useCallback(() => { void loadModel(); }, [loadModel]);
  const requestGenerate = useCallback(() => { void generate(); }, [generate]);
  const requestReroll = useCallback((request: string) => { void generate(request); }, [generate]);
  const requestClearModelCache = useCallback(() => { void clearModelCache(); }, [clearModelCache]);

  const controlPanel = useMemo<ControlPanelProps>(() => ({
    activeModelLabel,
    activeRun,
    engineReady: Boolean(engine),
    errors,
    guardrailsMode,
    inferenceProvider,
    isGenerating,
    modelCached,
    modelProgress,
    prompt,
    selectedModel,
    selectedModelId,
    selectedModelSize,
    status,
    statusLabel: currentStatusLabel,
    onChangeGuardrailsMode: chooseGuardrailsMode,
    onChangeInferenceProvider: chooseInferenceProvider,
    onChangeLiteRtModel: chooseLiteRtModel,
    onChangePrompt: setPrompt,
    onClearModelCache: requestClearModelCache,
    onGenerate: requestGenerate,
    onLoadModel: requestLoadModel,
    onReroll: requestReroll,
    onRunSample: runSample,
  }), [activeModelLabel, activeRun, currentStatusLabel, engine, errors, guardrailsMode, inferenceProvider, isGenerating, modelCached, modelProgress, prompt, selectedModel, selectedModelId, selectedModelSize, status, chooseGuardrailsMode, chooseInferenceProvider, chooseLiteRtModel, requestClearModelCache, requestGenerate, requestLoadModel, requestReroll, runSample]);

  const previewPanel = useMemo<PreviewPanelProps>(() => ({
    activeRun,
    compiledSurface,
    isGenerating,
    lastAction,
    patternLibrary,
    previewTab,
    prompt,
    runs,
    schemaEnforced: inferenceProvider === 'chrome',
    showStreaming,
    streamingPhase,
    streamingSurface,
    onChangePatternLibrary: changePatternLibrary,
    onChangePreviewTab: setPreviewTab,
    onFlagActiveRun: flagActiveRun,
    onRestoreRun: restoreRun,
  }), [activeRun, changePatternLibrary, compiledSurface, flagActiveRun, inferenceProvider, isGenerating, lastAction, patternLibrary, previewTab, prompt, restoreRun, runs, showStreaming, streamingPhase, streamingSurface]);

  const inspectorSection = useMemo<InspectorSectionProps>(() => ({
    debugEntries,
    exchanges: activeExchanges,
    rawOutput: activeRun?.rawOutput ?? '',
  }), [activeExchanges, activeRun?.rawOutput, debugEntries]);

  return { controlPanel, previewPanel, inspectorSection };
}
