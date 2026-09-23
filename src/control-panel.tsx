/**
 * Presentational controls for prompt entry, provider/model selection,
 * guardrails, loading state, validation errors, and deterministic fixtures.
 */

import { memo } from 'react';
import type { AppStatus, GenerationRun, GuardrailsMode, InferenceProvider } from './generation-types';
import { SPARKS } from './sparks';
import { LITERT_MODELS, type LiteRtModelDefinition, type ModelLoadProgress } from './local-model';
import { ModelLoader } from './prototype-panels';


export interface ControlPanelProps {
  activeModelLabel: string;
  activeRun: GenerationRun | null;
  engineReady: boolean;
  errors: string[];
  guardrailsMode: GuardrailsMode;
  inferenceProvider: InferenceProvider;
  isGenerating: boolean;
  modelCached: boolean;
  modelProgress: ModelLoadProgress | null;
  prompt: string;
  selectedModel: LiteRtModelDefinition;
  selectedModelId: LiteRtModelDefinition['id'];
  selectedModelSize: string;
  status: AppStatus;
  statusLabel: string;
  onChangeGuardrailsMode: (mode: GuardrailsMode) => void;
  onChangeInferenceProvider: (provider: InferenceProvider) => void;
  onChangeLiteRtModel: (modelId: LiteRtModelDefinition['id']) => void;
  onChangePrompt: (prompt: string) => void;
  onClearModelCache: () => void;
  onGenerate: () => void;
  onLoadModel: () => void;
  onReroll: (prompt: string) => void;
  onRunSample: () => void;
}

export const ControlPanel = memo(function ControlPanel({
  activeModelLabel,
  activeRun,
  engineReady,
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
  statusLabel,
  onChangeGuardrailsMode,
  onChangeInferenceProvider,
  onChangeLiteRtModel,
  onChangePrompt,
  onClearModelCache,
  onGenerate,
  onLoadModel,
  onReroll,
  onRunSample,
}: ControlPanelProps) {
  // The model can't change under a load in progress; see isLoading in use-composer-workbench.ts.
  const modelLocked = status === 'loading' || isGenerating;
  return (
    <div className="control-panel">
      <div className="panel-heading"><div><span className="step-number">01</span><h2>Compose</h2></div><span className={`system-status system-status--${status}`}><i />{statusLabel}</span></div>
      <label className="field-label" htmlFor="request">WHAT SHOULD EXIST?</label>
      <textarea id="request" placeholder="Describe any interface — a tracker, a form, a decision, a control room…" value={prompt} onChange={(event) => onChangePrompt(event.target.value)} rows={4} disabled={isGenerating} />
      <div className="prompt-chips" aria-label="Prompt sparks">
        {SPARKS.map((spark) => { const active = prompt.trim() === spark.prompt; return <button key={spark.label} type="button" aria-pressed={active} className={active ? 'is-active' : ''} disabled={isGenerating} onClick={() => onChangePrompt(spark.prompt)}>{spark.label}</button>; })}
      </div>
      <span className="field-label">INFERENCE PROVIDER</span>
      <div className="segmented-control inference-provider-control">
        <button className={inferenceProvider === 'chrome' ? 'is-active' : ''} type="button" disabled={modelLocked} onClick={() => onChangeInferenceProvider('chrome')}>Chrome built-in</button>
        <button className={inferenceProvider === 'litert' ? 'is-active' : ''} type="button" disabled={modelLocked} onClick={() => onChangeInferenceProvider('litert')}>LiteRT</button>
      </div>
      {inferenceProvider === 'litert' ? <label className="model-select-label" htmlFor="litert-model"><span className="field-label">LITERT MODEL</span><select id="litert-model" value={selectedModelId} disabled={modelLocked} onChange={(event) => onChangeLiteRtModel(event.target.value as LiteRtModelDefinition['id'])}>{LITERT_MODELS.map((model) => <option disabled={!model.webSupported} key={model.id} value={model.id}>{model.label} · {model.webSupported ? `${(model.sizeBytes / 1_048_576).toFixed(0)} MiB` : 'unavailable in LiteRT-LM.js'}</option>)}</select></label> : null}
      <span className="field-label">GUARDRAILS</span>
      <div className="segmented-control">
        <button className={guardrailsMode === 'recover' ? 'is-active' : ''} type="button" disabled={isGenerating} title="Full salvage: repair, generous interpretation, reconstruction, and cleanup — every adjustment logged." onClick={() => onChangeGuardrailsMode('recover')}>Recover</button>
        <button className={guardrailsMode === 'strict' ? 'is-active' : ''} type="button" disabled={isGenerating} title="No repair, coercion, or salvage: raw output must survive plain JSON.parse and the strict schemas. Shows what the model does alone." onClick={() => onChangeGuardrailsMode('strict')}>Strict</button>
      </div>
      <div className="model-card">
        <div className="model-card__head"><div className="model-glyph">{inferenceProvider === 'chrome' ? 'AI' : selectedModel.shortLabel}</div><div><strong>{activeModelLabel}</strong><span>{inferenceProvider === 'chrome' ? 'Gemini Nano · browser managed' : `LiteRT-LM · WebGPU · ${selectedModel.contextTokens.toLocaleString()} context${selectedModel.loader === 'heap' ? ' · standard export, heap-resident' : ''}`}</span></div><span className="model-size">{inferenceProvider === 'chrome' ? 'Managed' : selectedModelSize}</span></div>
        {inferenceProvider === 'litert' ? <p className="model-cache-note">{modelCached ? '✓ Artifact cached in this browser — reloads skip the download.' : 'First load downloads once, then persists in browser cache for future sessions.'}{modelCached ? <button className="model-cache-clear" type="button" onClick={onClearModelCache}>Clear</button> : null}</p> : <p className="model-cache-note">Chrome owns eligibility, download, update, and storage for the built-in model.</p>}
        {status === 'loading' && modelProgress ? <ModelLoader progress={modelProgress} label={activeModelLabel} /> : null}
        <div className="model-actions">
          <button className="button button--primary" type="button" onClick={engineReady ? onGenerate : onLoadModel} disabled={status === 'loading' || isGenerating || (engineReady && !prompt.trim())}>{engineReady ? 'Generate' : inferenceProvider === 'chrome' ? 'Use Chrome built-in AI' : `Load ${selectedModel.label} locally`}</button>
          {engineReady && inferenceProvider === 'chrome' && activeRun && activeRun.status === 'done' && activeRun.providerLabel !== 'Deterministic fixture' ? <button className="button button--ghost" type="button" disabled={isGenerating} onClick={() => onReroll(activeRun.prompt)} title="Same prompt, new take">↺ Reroll</button> : null}
        </div>
      </div>
      {errors.length ? <div className="error-box" role="alert"><strong>Validation stopped the surface</strong>{errors.map((error) => <p key={error}>{error}</p>)}</div> : null}
      <div className="guardrails"><div><strong>18</strong><span>shared components</span></div><div><strong>60</strong><span>element ceiling</span></div><div><strong>0</strong><span>executable outputs</span></div></div>
      <button className="sample-link" type="button" onClick={onRunSample} disabled={isGenerating}>Run deterministic integration check →</button>
    </div>
  );
});
