/**
 * Harness transparency panel for the prompt, editable pattern blueprints,
 * coercion vocabulary, and salvage playbook used around the model.
 */

import { memo } from 'react';
import { DEFAULT_PATTERN_LIBRARY, PATTERN_KEYS, buildCompositionPrompt, selectPatternKeys, type PatternKey, type PatternLibrary } from './prompt';
import { SALVAGE_PLAYBOOK } from './salvage';
import { COERCION_VOCABULARY } from './vocabulary';

const FALLBACK_REQUEST = 'A patient intake form for a family clinic.';

const ATTRIBUTION: Array<{ owner: string; items: string[] }> = [
  {
    owner: 'The model authors',
    items: [
      'Every word on the surface: headings, copy, field labels, options, chat dialogue, metric values.',
      'Which of the 18 components appear, how many, and in what order (emission order is treated as design intent).',
      'Grouping intent, semantic tones, the accent hue, emoji icons, and action names.',
      'Structure beyond the blueprint — unmatched creative requests get only a one-line scaffold, so their layout is predominantly the model\'s.',
    ],
  },
  {
    owner: 'The harness contributes',
    items: [
      'The component vocabulary and all visual design: spacing, color, typography come from the design system, never the model.',
      'The transport schema, JSON repair, and the salvage passes below — reconstruction of what the model implied, never invented content. Every adjustment is logged on the run.',
      'Pattern blueprints that bias macro-structure when a request matches a known interaction — for those, layout is substantially harness-guided.',
      'A locked focused decoding profile: established patterns beat creative drift, and on LiteRT the same prompt reproduces the same surface. Plus the repair loop, repetition cut-off, semantic dedup, and synonym coercion.',
    ],
  },
];

/** The end-to-end path from prompt to pixels, in execution order. */
const GENERATION_PIPELINE: Array<{ stage: string; detail: string }> = [
  { stage: 'Prompt assembly', detail: 'The raw request is matched against the trigger keywords below. The prompt = request + catalog guide + rules + the matched blueprint(s), ending with "copy the STRUCTURE, never the words".' },
  { stage: 'Transport constraint', detail: 'Chrome enforces the outer JSON shape natively (responseConstraint); LiteRT receives the same schema appended as text. Neither constrains topology, content, or style.' },
  { stage: 'Locked focused decoding', detail: 'Chrome samples at temperature 0.4 / topK 3. LiteRT-LM 0.14 decodes greedily — its WebGPU runtime rejects non-greedy sampling — so the same prompt reproduces the same surface.' },
  { stage: 'Streaming + live preview', detail: 'Every ~140ms the partial output is repaired (jsonrepair) and re-parsed; nodes render append-only under stable IDs with single parenthood enforced mid-stream (first parent claims a child, the root yields to a more specific container, type-name annotations are skipped; duplicate references drop), so nothing appears twice or pops back out.' },
  { stage: 'Repetition cut-off', detail: 'If a 400-character block repeats verbatim, or output passes 24,000 characters, the stream is cancelled and the pipeline continues with what arrived.' },
  { stage: 'Salvage', detail: 'The completed output runs the playbook below — repair, generous interpretation, reconstruction, dedup, adoption, cleanup. Reconstruction of intent, never invention of content; every adjustment is logged. The workbench Guardrails toggle can switch to Strict — no repair, coercion, or salvage — to A/B what the model produces alone.' },
  { stage: 'Strict validation + compile', detail: 'The salvaged graph must pass the per-component Zod schemas and graph integrity checks, then is wrapped in the A2UI v0.9 message envelopes and handed to the official processor and renderer. No generated HTML, CSS, or JS ever executes.' },
  { stage: 'Repair loop (rare)', detail: 'Only when salvage cannot reach a renderable floor — a root plus visible content — is the model asked again, at most twice, with the concrete errors quoted. The previous partial surface stays visible while it retries.' },
];

function VocabularyTable({ title, entries }: { title: string; entries: Record<string, string> }) {
  return (
    <details className="harness-vocab">
      <summary>{title}<small>{Object.keys(entries).length} mappings</small></summary>
      <div className="harness-vocab__grid">
        {Object.entries(entries).map(([from, to]) => <span key={from}><code>{from}</code> → <code>{to}</code></span>)}
      </div>
    </details>
  );
}

export interface HarnessPanelProps {
  request: string;
  schemaEnforced: boolean;
  library: PatternLibrary;
  onChangeLibrary: (library: PatternLibrary) => void;
}

export const HarnessPanel = memo(function HarnessPanel({ request, schemaEnforced, library, onChangeLibrary }: HarnessPanelProps) {
  const effectiveRequest = request.trim() || FALLBACK_REQUEST;
  const matchedKeys = selectPatternKeys(effectiveRequest, library);
  const prompt = buildCompositionPrompt(effectiveRequest, { schemaEnforced, patternLibrary: library });
  const isDefaultLibrary = JSON.stringify(library) === JSON.stringify(DEFAULT_PATTERN_LIBRARY);

  const updatePattern = (key: PatternKey, update: Partial<{ keywords: string; blueprint: string }>) => {
    onChangeLibrary({
      ...library,
      patterns: {
        ...library.patterns,
        [key]: {
          keywords: update.keywords !== undefined ? update.keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean) : library.patterns[key].keywords,
          blueprint: update.blueprint !== undefined ? update.blueprint : library.patterns[key].blueprint,
        },
      },
    });
  };

  return (
    <section className="harness-panel" aria-labelledby="harness-panel-title">
      <div className="harness-panel__intro">
        <div><span className="step-number">HARNESS</span><h2 id="harness-panel-title">What the model does — and what it doesn't</h2></div>
        <p>The instructions, blueprints, and interpretation rules below are the entire non-model half of this system. Blueprints and keywords are editable and persist in this browser.</p>
      </div>

      <div className="harness-attribution">
        {ATTRIBUTION.map((column) => (
          <div key={column.owner}>
            <h3>{column.owner}</h3>
            <ul>{column.items.map((item) => <li key={item}><i />{item}</li>)}</ul>
          </div>
        ))}
      </div>

      <div className="harness-section">
        <div className="harness-section__head">
          <h3>Generation pipeline</h3>
          <span className="harness-hint">every stage between your prompt and the rendered surface</span>
        </div>
        <ol className="harness-pipeline">
          {GENERATION_PIPELINE.map((step) => <li key={step.stage}><strong>{step.stage}</strong><span>{step.detail}</span></li>)}
        </ol>
      </div>

      <div className="harness-section">
        <div className="harness-section__head">
          <h3>Pattern blueprints</h3>
          {!isDefaultLibrary ? <button type="button" className="harness-reset" onClick={() => onChangeLibrary(DEFAULT_PATTERN_LIBRARY)}>Reset to defaults</button> : <span className="harness-hint">matched blueprints are injected into the prompt</span>}
        </div>
        {PATTERN_KEYS.map((key) => {
          const definition = library.patterns[key];
          const matched = matchedKeys.includes(key);
          return (
            <div key={key} className={`harness-pattern${matched ? ' is-matched' : ''}`}>
              <div className="harness-pattern__head">
                <strong>{key}</strong>
                {matched ? <span className="harness-match">matches current prompt</span> : null}
              </div>
              <label>Trigger keywords
                <input value={definition.keywords.join(', ')} onChange={(event) => updatePattern(key, { keywords: event.target.value })} spellCheck={false} />
              </label>
              <label>Blueprint sent to the model
                <textarea rows={2} value={definition.blueprint} onChange={(event) => updatePattern(key, { blueprint: event.target.value })} spellCheck={false} />
              </label>
            </div>
          );
        })}
        <div className="harness-pattern">
          <div className="harness-pattern__head"><strong>no match</strong>{!matchedKeys.length ? <span className="harness-match">matches current prompt</span> : null}</div>
          <label>Generic scaffold
            <textarea rows={2} value={library.generic} onChange={(event) => onChangeLibrary({ ...library, generic: event.target.value })} spellCheck={false} />
          </label>
        </div>
      </div>

      <div className="harness-section">
        <div className="harness-section__head">
          <h3>Live prompt</h3>
          <span className="harness-hint">{prompt.length.toLocaleString()} characters · {schemaEnforced ? 'Chrome: transport schema enforced natively' : 'LiteRT: transport schema appended as text after this prompt'}</span>
        </div>
        <pre className="harness-prompt">{prompt}</pre>
      </div>

      <div className="harness-section">
        <div className="harness-section__head">
          <h3>Interpretation vocabulary</h3>
          <span className="harness-hint">how off-catalog wording is read generously before strict validation</span>
        </div>
        <VocabularyTable title="Component synonyms" entries={COERCION_VOCABULARY.components} />
        <VocabularyTable title="Semantic tone synonyms" entries={COERCION_VOCABULARY.semanticTones} />
        <VocabularyTable title="Button tone synonyms" entries={COERCION_VOCABULARY.buttonTones} />
        <VocabularyTable title="Accent synonyms" entries={COERCION_VOCABULARY.accents} />
        <VocabularyTable title="Input type synonyms" entries={COERCION_VOCABULARY.inputTypes} />
      </div>

      <div className="harness-section">
        <div className="harness-section__head">
          <h3>Salvage playbook</h3>
          <span className="harness-hint">runs in this order; every adjustment is logged on the run</span>
        </div>
        <ol className="harness-playbook">
          {SALVAGE_PLAYBOOK.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </div>
    </section>
  );
});
