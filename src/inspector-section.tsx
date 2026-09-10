/**
 * Inspector section for debug events, generation exchange payloads, and the
 * latest raw model or fixture output.
 */

import { memo } from 'react';
import type { GenerationExchange } from './generation-types';
import { DebugPanel, GenerationExchangePanel, type DebugEntry } from './prototype-panels';

export interface InspectorSectionProps {
  debugEntries: DebugEntry[];
  exchanges: GenerationExchange[];
  rawOutput: string;
}

export const InspectorSection = memo(function InspectorSection({ debugEntries, exchanges, rawOutput }: InspectorSectionProps) {
  return (
    <section className="inspector">
      <div className="inspector-copy">
        <span className="step-number">03</span>
        <h2>See every choice<br />the model made.</h2>
        <p>Inspect the free-form catalog prompt, the streamed graph, salvage decisions, and the validated protocol payload. The transport schema constrains shape and component names — never topology, content, or style.</p>
        <ul>
          <li><i />Transport-only schema; no fixed content slots</li>
          <li><i />Model chooses components, layout, accent, and actions</li>
          <li><i />Guardrails recover instead of reject; every adjustment is logged</li>
          <li><i />Locked focused decoding: established patterns over creative drift</li>
        </ul>
      </div>
      <div className="inspector-tools">
        <DebugPanel entries={debugEntries} />
        <GenerationExchangePanel exchanges={exchanges} />
        <details className="raw-output"><summary>Inspect latest raw output <span>CATALOG MAP</span></summary><pre>{rawOutput || '// Run a composition to inspect the model or sample output.'}</pre></details>
      </div>
    </section>
  );
});
