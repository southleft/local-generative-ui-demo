/**
 * Preview workbench section: tab chrome, rendered A2UI surface, live streaming
 * preview, harness transparency, component catalog, footer, and history strip.
 */

import { memo } from 'react';
import { A2uiSurface } from '@a2ui/react/v0_9';
import type { CompiledRunSurface, GenerationRun, PreviewTab } from './generation-types';
import { HarnessPanel } from './harness-panel';
import type { PatternLibrary } from './prompt';
import { ComponentLibrary } from './prototype-panels';
import type { StreamingSurface } from './streaming';
import { StreamingSurfacePreview } from './streaming-preview';

function runAccent(run: GenerationRun): string {
  const rootNode = run.composition?.nodes.find((node) => node.id === run.composition?.root);
  const accent = rootNode?.props?.accent;
  return typeof accent === 'string' ? accent : 'indigo';
}

export interface PreviewPanelProps {
  activeRun: GenerationRun | null;
  compiledSurface: CompiledRunSurface | null;
  isGenerating: boolean;
  lastAction: string;
  patternLibrary: PatternLibrary;
  previewTab: PreviewTab;
  prompt: string;
  runs: GenerationRun[];
  schemaEnforced: boolean;
  showStreaming: boolean;
  streamingPhase: string;
  streamingSurface: StreamingSurface | null;
  onChangePatternLibrary: (library: PatternLibrary) => void;
  onChangePreviewTab: (tab: PreviewTab) => void;
  onFlagActiveRun: () => void;
  onRestoreRun: (runId: number) => void;
}

export const PreviewPanel = memo(function PreviewPanel({
  activeRun,
  compiledSurface,
  isGenerating,
  lastAction,
  patternLibrary,
  previewTab,
  prompt,
  runs,
  schemaEnforced,
  showStreaming,
  streamingPhase,
  streamingSurface,
  onChangePatternLibrary,
  onChangePreviewTab,
  onFlagActiveRun,
  onRestoreRun,
}: PreviewPanelProps) {
  const hasSurface = compiledSurface !== null;

  return (
    <div className="preview-panel">
      <div className="panel-heading"><div><span className="step-number">02</span><h2>{previewTab === 'surface' ? 'Rendered surface' : previewTab === 'catalog' ? 'Component catalog' : 'Harness transparency'}</h2></div><span className="viewport-label">{previewTab === 'harness' ? 'MODEL VS. HARNESS' : 'SHARED REACT CATALOG'}</span></div>
      <div className="preview-tabs" role="tablist" aria-label="Preview views"><button type="button" role="tab" aria-selected={previewTab === 'surface'} className={previewTab === 'surface' ? 'is-active' : ''} onClick={() => onChangePreviewTab('surface')}>Surface preview</button><button type="button" role="tab" aria-selected={previewTab === 'catalog'} className={previewTab === 'catalog' ? 'is-active' : ''} onClick={() => onChangePreviewTab('catalog')}>Component library</button><button type="button" role="tab" aria-selected={previewTab === 'harness'} className={previewTab === 'harness' ? 'is-active' : ''} onClick={() => onChangePreviewTab('harness')}>Prompt &amp; guardrails</button></div>
      {previewTab === 'harness' ? <HarnessPanel request={prompt} schemaEnforced={schemaEnforced} library={patternLibrary} onChangeLibrary={onChangePatternLibrary} /> : null}
      {previewTab === 'catalog' ? <ComponentLibrary /> : null}
      {previewTab === 'surface' ? <>
        <div className="preview-frame"><div className="preview-chrome"><span /><span /><span /><small>a2ui://preview</small></div><div className={`surface-stage${isGenerating ? ' surface-stage--streaming' : ''}`}>
          {isGenerating ? <div className="streaming-shell"><div className="streaming-status" aria-live="polite"><i />{streamingPhase}</div>{showStreaming && streamingSurface ? <StreamingSurfacePreview surface={streamingSurface} /> : null}</div> : null}
          {!isGenerating && !hasSurface ? <div className="empty-state"><div className="empty-glyph"><span /><span /><span /></div><strong>No surface yet</strong><p>Load a browser-local model and describe anything — or run the deterministic integration check.</p></div> : null}
          {!isGenerating && compiledSurface ? <div className="a2ui-surface"><A2uiSurface key={compiledSurface.runId} surface={compiledSurface.surface} /></div> : null}
        </div></div>
        <div className="preview-footer"><span>{lastAction}</span>{activeRun?.warnings.length ? <span className="salvage-note" title={activeRun.warnings.join('\n')}>{activeRun.warnings.length} guardrail adjustment{activeRun.warnings.length === 1 ? '' : 's'}</span> : null}{activeRun && !isGenerating ? <button className="flag-run" type="button" title="Send this run, with a note, to the session log for review" onClick={onFlagActiveRun}>🚩 Flag for review</button> : null}<span>@a2ui/react v0.9</span></div>
      </> : null}
      {runs.length ? <div className="history-strip" aria-label="Generation history">
        {[...runs].reverse().map((run) => (
          <button key={run.id} type="button" className={`history-chip${run.id === activeRun?.id ? ' is-active' : ''}${run.status === 'failed' ? ' is-failed' : ''}`} disabled={isGenerating} onClick={() => onRestoreRun(run.id)} title={run.prompt}>
            <span className={`history-dot history-dot--${runAccent(run)}`} aria-hidden="true" />
            <span className="history-take">T{run.take}</span>
            <span className="history-prompt">{run.prompt.length > 42 ? `${run.prompt.slice(0, 42)}…` : run.prompt}</span>
          </button>
        ))}
      </div> : null}
    </div>
  );
});
