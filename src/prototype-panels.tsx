/**
 * Debug, exchange, loader, and catalog panels used by the workbench. These are
 * memoized because they are comparatively heavy during streaming updates.
 */

import { memo, useEffect, useState, type ReactNode } from 'react';
import { componentDefinitions, type ComponentName } from './catalog';
import { Alert, Button, Card, ChatBubble, Divider, Grid, Heading, Inline, Metric, Page, ProgressBar, Select, Stack, StatusBadge, Tag, Text, TextArea, TextField } from './design-system';
import type { GenerationExchange } from './generation-types';
import type { ModelLoadProgress } from './local-model';

export interface DebugEntry {
  id: number;
  time: string;
  source: 'system' | 'model' | 'a2ui';
  message: string;
  detail?: string;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return 'size unavailable';
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export const ModelLoader = memo(function ModelLoader({ progress, label: modelLabel }: { progress: ModelLoadProgress; label: string }) {
  const downloading = progress.phase === 'downloading';
  const compiling = progress.phase === 'compiling';
  const label = progress.phase === 'preparing'
    ? 'Preparing model download'
    : downloading
      ? `Downloading ${modelLabel} · ${progress.percent ?? '—'}%`
      : compiling
        ? 'Compiling for WebGPU'
        : `${modelLabel} is ready`;
  const progressLabel = downloading ? `Downloading ${modelLabel}` : compiling ? `Compiling ${modelLabel}` : label;

  return (
    <div className={`model-loader model-loader--${progress.phase}`} aria-live="polite">
      <div className="model-loader__copy">
        <span>{label}</span>
        {downloading && progress.loadedBytes !== undefined ? <small>{formatBytes(progress.loadedBytes)}{progress.totalBytes !== undefined ? ` / ${formatBytes(progress.totalBytes)}` : ''}</small> : null}
        {compiling ? <small>LiteRT does not expose compile percentage; this phase stays active until WebGPU initialization completes.</small> : null}
      </div>
      <div
        className="model-loader__track"
        role="progressbar"
        aria-label={progressLabel}
        aria-valuemin={downloading && progress.percent !== undefined ? 0 : undefined}
        aria-valuemax={downloading && progress.percent !== undefined ? 100 : undefined}
        aria-valuenow={downloading ? progress.percent : undefined}
      >
        <span style={downloading && progress.percent !== undefined ? { width: `${progress.percent}%` } : undefined} />
      </div>
    </div>
  );
});

export const DebugPanel = memo(function DebugPanel({ entries }: { entries: DebugEntry[] }) {
  return (
    <details className="debug-panel" open>
      <summary><span>Debug trace</span><small>{entries.length} events · live</small></summary>
      <ol aria-label="Model and framework debug events">
        {entries.map((entry) => (
          <li key={entry.id}>
            <time>{entry.time}</time>
            <span className={`debug-source debug-source--${entry.source}`}>{entry.source}</span>
            <div><strong>{entry.message}</strong>{entry.detail ? <small>{entry.detail}</small> : null}</div>
          </li>
        ))}
      </ol>
    </details>
  );
});

type ExchangeStage = 'request' | 'response' | 'renderer';

function prettyModelResponse(response?: string): string {
  if (!response) return '// Waiting for the model response.';
  const candidate = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.stringify(JSON.parse(candidate), null, 2);
  } catch {
    return response;
  }
}

export const GenerationExchangePanel = memo(function GenerationExchangePanel({ exchanges }: { exchanges: GenerationExchange[] }) {
  const [stage, setStage] = useState<ExchangeStage>('request');
  const [attemptIndex, setAttemptIndex] = useState(Math.max(0, exchanges.length - 1));
  useEffect(() => setAttemptIndex(Math.max(0, exchanges.length - 1)), [exchanges.length]);
  const exchange = exchanges[attemptIndex];
  const requestPayload = exchange ? {
    provider: exchange.provider,
    model: exchange.model,
    protocol: exchange.protocol,
    request: exchange.request,
    attemptType: exchange.attempt === 1 ? 'initial generation' : `repair attempt ${exchange.attempt - 1}`,
    prompt: exchange.prompt,
    constraintMode: exchange.nativeConstraint
      ? 'native responseConstraint'
      : exchange.responseConstraint ? 'prompt contract with post-generation validation' : 'no native response constraint; catalog map validated after generation',
    responseConstraint: exchange.responseConstraint ?? null,
  } : null;
  const content = !exchange
    ? '// Generate with a local model to inspect the exchange.'
    : stage === 'request'
      ? JSON.stringify(requestPayload, null, 2)
      : stage === 'response'
        ? exchange.error ? JSON.stringify({ error: exchange.error }, null, 2) : prettyModelResponse(exchange.response)
        : exchange.rendererPayload === undefined ? '// The harness has not produced a validated renderer payload.' : JSON.stringify(exchange.rendererPayload, null, 2);

  return (
    <details className="model-exchange">
      <summary><span>Inspect generation exchange</span><small>{exchanges.length ? `${exchanges.length} attempt${exchanges.length === 1 ? '' : 's'}` : 'NO MODEL RUN'}</small></summary>
      <div className="model-exchange__toolbar">
        <div className="model-exchange__tabs" role="tablist" aria-label="Generation exchange stages">
          {([['request', 'Harness → Model'], ['response', 'Model → Harness'], ['renderer', 'Harness → Renderer']] as const).map(([id, label]) => <button aria-selected={stage === id} className={stage === id ? 'is-active' : ''} disabled={!exchange} key={id} onClick={() => setStage(id)} role="tab" type="button">{label}</button>)}
        </div>
        {exchanges.length > 1 ? <label>Attempt <select aria-label="Generation attempt" value={attemptIndex} onChange={(event) => setAttemptIndex(Number(event.target.value))}>{exchanges.map((item, index) => <option key={item.id} value={index}>{item.attempt}</option>)}</select></label> : null}
      </div>
      <pre aria-label={stage === 'request' ? 'Harness to model JSON' : stage === 'response' ? 'Model to harness JSON' : 'Harness to renderer JSON'}>{content}</pre>
    </details>
  );
});

type DefinitionTab = 'preview' | 'overview' | 'code';

const componentExamples = {
  Page: { preview: <Page accent="teal"><Text text="Generated page canvas with a teal accent" /></Page>, code: '<Page accent="teal">\n  <Text text="Generated page canvas" />\n</Page>' },
  Stack: { preview: <Stack gap="sm"><Text text="First item" /><Text text="Second item" /></Stack>, code: '<Stack gap="sm">\n  <Text text="First item" />\n  <Text text="Second item" />\n</Stack>' },
  Inline: { preview: <Inline align="center"><StatusBadge label="Ready" tone="success" /><Button label="Review" /></Inline>, code: '<Inline align="center">\n  <StatusBadge label="Ready" tone="success" />\n  <Button label="Review" />\n</Inline>' },
  Grid: { preview: <Grid columns={2}><Metric label="Speed" value="98" /><Metric label="Uptime" value="99.9%" /></Grid>, code: '<Grid columns={2}>\n  <Metric label="Speed" value="98" />\n  <Metric label="Uptime" value="99.9%" />\n</Grid>' },
  Card: { preview: <Card tone="recommended"><Heading text="Recommended" level="h3" /><Text text="Grouped supporting content." /></Card>, code: '<Card tone="recommended">\n  <Heading text="Recommended" level="h3" />\n  <Text text="Grouped supporting content." />\n</Card>' },
  Heading: { preview: <Heading text="Account health" level="h2" />, code: '<Heading text="Account health" level="h2" />' },
  Text: { preview: <Text text="Safely rendered supporting copy." tone="muted" />, code: '<Text text="Safely rendered supporting copy." tone="muted" />' },
  Metric: { preview: <Metric label="Monthly revenue" value="$42,800" detail="Up 12%" tone="success" />, code: '<Metric label="Monthly revenue" value="$42,800" detail="Up 12%" tone="success" />' },
  StatusBadge: { preview: <StatusBadge label="Past due" tone="warning" />, code: '<StatusBadge label="Past due" tone="warning" />' },
  Tag: { preview: <Inline><Tag label="Local-first" tone="success" icon="🌱" /><Tag label="WebGPU" /></Inline>, code: '<Tag label="Local-first" tone="success" icon="🌱" />' },
  ProgressBar: { preview: <ProgressBar label="Model download" percent={72} />, code: '<ProgressBar label="Model download" percent={72} />' },
  Alert: { preview: <Alert title="Invoice overdue" message="Payment is 14 days late." tone="critical" icon="⚠️" />, code: '<Alert title="Invoice overdue" message="Payment is 14 days late." tone="critical" icon="⚠️" />' },
  Divider: { preview: <Stack gap="sm"><Text text="Above" /><Divider /><Text text="Below" /></Stack>, code: '<Divider />' },
  TextField: { preview: <TextField label="Contact email" placeholder="name@example.com" inputType="email" />, code: '<TextField label="Contact email" placeholder="name@example.com" inputType="email" />' },
  TextArea: { preview: <TextArea label="Visit notes" placeholder="Anything we should know…" />, code: '<TextArea label="Visit notes" placeholder="Anything we should know…" />' },
  ChatBubble: { preview: <Stack gap="sm"><ChatBubble text="My order is a week late." from="user" /><ChatBubble text="Sorry about that — checking now." from="other" name="Support" /></Stack>, code: '<ChatBubble text="My order is a week late." from="user" />\n<ChatBubble text="Sorry about that — checking now." from="other" name="Support" />' },
  Select: { preview: <Select label="Priority" value="high" options={[{ label: 'High', value: 'high' }, { label: 'Normal', value: 'normal' }]} />, code: '<Select label="Priority" value="high" options={[{ label: "High", value: "high" }, { label: "Normal", value: "normal" }]} />' },
  Button: { preview: <Button label="Approve recommendation" tone="primary" />, code: '<Button label="Approve recommendation" tone="primary" onPress={handleApprove} />' },
} satisfies Record<ComponentName, { preview: ReactNode; code: string }>;

const ComponentDefinitionCard = memo(function ComponentDefinitionCard({ definition }: { definition: (typeof componentDefinitions)[number] }) {
  const [tab, setTab] = useState<DefinitionTab>('preview');
  const example = componentExamples[definition.name];
  const componentId = definition.name.toLowerCase();
  return (
    <article className="component-definition" aria-label={`${definition.name} component`}>
      <div className="component-definition__header"><span className="component-definition__glyph">{definition.name.slice(0, 2)}</span><h3>{definition.name}</h3></div>
      <div className="component-definition__tabs" role="tablist" aria-label={`${definition.name} views`}>
        {(['preview', 'overview', 'code'] as DefinitionTab[]).map((item) => <button id={`${componentId}-${item}-tab`} aria-controls={`${componentId}-${item}-panel`} key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? 'is-active' : ''} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
      </div>
      {tab === 'preview' ? <div id={`${componentId}-preview-panel`} role="tabpanel" aria-labelledby={`${componentId}-preview-tab`} className="component-definition__preview">{example.preview}</div> : null}
      {tab === 'overview' ? <div id={`${componentId}-overview-panel`} role="tabpanel" aria-labelledby={`${componentId}-overview-tab`} className="component-definition__overview"><p>{definition.description}</p><code>{definition.props.length ? definition.props.join(' · ') : 'no props'}</code><small>{definition.acceptsChildren ? 'Accepts children' : 'Leaf component'}</small></div> : null}
      {tab === 'code' ? <pre id={`${componentId}-code-panel`} role="tabpanel" aria-labelledby={`${componentId}-code-tab`} className="component-definition__code"><code>{example.code}</code></pre> : null}
    </article>
  );
});

export const ComponentLibrary = memo(function ComponentLibrary() {
  return (
    <section className="component-library" aria-labelledby="component-library-title">
      <div className="component-library__intro">
        <div><span className="step-number">CATALOG</span><h2 id="component-library-title">Shared component library</h2></div>
        <p>Declared as a real A2UI <code>Catalog</code>, so these 18 components are the model's entire vocabulary and the official renderer's only implementations.</p>
      </div>
      <div className="component-grid">
        {componentDefinitions.map((definition) => <ComponentDefinitionCard definition={definition} key={definition.name} />)}
      </div>
    </section>
  );
});
