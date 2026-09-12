/**
 * Everything the model is told: the catalog guide (derived from the catalog
 * table), the transport-only response constraint, the pattern blueprints, and
 * the two prompt builders. Nothing here constrains topology, content, or style.
 */

import { CHILDREN_LIMIT, COMPONENT_LIMIT, catalog, componentNames } from './catalog';

/**
 * The model emits A2UI v0.9 component syntax directly: a flat array of
 * components whose props sit alongside `id` and `component`, with
 * `value: { path }` bindings and `action: { event: { name } }` actions. The
 * harness only supplies the message envelopes, which is what a transport does.
 *
 * Emitting the envelopes from the model was measured at ~147% of this output
 * size and requires multi-message serialization a 2B local model does not
 * survive; component syntax is ~92% of the bespoke format it replaced.
 */
export const RESPONSE_CONSTRAINT = {
  type: 'object',
  properties: {
    root: { type: 'string', description: 'The ID string of the root component. Never place a component object here.' },
    components: {
      type: 'array',
      minItems: 1,
      maxItems: COMPONENT_LIMIT,
      description: 'One flat array containing every A2UI component. Child relationships use ID strings.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          component: { type: 'string', enum: [...componentNames] },
          children: { type: 'array', items: { type: 'string' }, maxItems: CHILDREN_LIMIT },
          value: {
            type: 'object',
            description: 'A2UI data binding for TextField, TextArea, and Select.',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
          action: {
            type: 'object',
            description: 'A2UI event action for Button.',
            properties: {
              event: { type: 'object', properties: { name: { type: 'string' }, context: { type: 'object' } }, required: ['name'], additionalProperties: false },
            },
            required: ['event'],
            additionalProperties: false,
          },
        },
        required: ['id', 'component'],
        additionalProperties: true,
      },
    },
  },
  required: ['root', 'components'],
  additionalProperties: false,
} as const;

/*
 * The item schema stays open (additionalProperties: true) on purpose. A
 * closed key set was tried for Chrome's native responseConstraint on
 * 2026-09-10: Gemini Nano then emitted only the explicitly typed keys (id,
 * component, children, value, action), copied the "lowerCamelName" placeholder
 * into every action, and wrote no text or labels at all. Valid JSON, empty
 * interface. Corrupted keys are repaired in salvage instead.
 */

/** One aligned line per component; small models read aligned tables far better than schema prose. */
export const catalogGuide = componentNames
  .map((name) => `${name.padEnd(11)} ${catalog[name].kind === 'layout' ? 'children' : 'leaf'}; ${catalog[name].guide}`)
  .join('\n');

/* -------------------------------------------------------------------------
 * Pattern blueprints: compact structural recipes for the interactions this
 * demo should nail on the first try. Matched against the raw request only
 * and written in the same prop=value vocabulary as the catalog guide so
 * nothing leaks into output as a fake component name.
 * ---------------------------------------------------------------------- */

export const PATTERN_KEYS = ['form', 'chat', 'dashboard', 'settings', 'compare'] as const;
export type PatternKey = (typeof PATTERN_KEYS)[number];

export interface PatternDefinition {
  /** Plain keywords matched as whole words, case-insensitive. User-editable. */
  keywords: string[];
  blueprint: string;
}

export interface PatternLibrary {
  patterns: Record<PatternKey, PatternDefinition>;
  /** Single scaffold line used when no pattern matches. */
  generic: string;
}

export const DEFAULT_PATTERN_LIBRARY: PatternLibrary = {
  patterns: {
    form: {
      keywords: ['form', 'intake', 'survey', 'questionnaire', 'signup', 'sign up', 'sign-up', 'register', 'registration', 'onboard', 'onboarding', 'application', 'apply', 'contact', 'feedback', 'rsvp', 'booking', 'checkout', 'cart', 'invoice', 'receipt', 'billing', 'payment'],
      blueprint: 'Form: Page [Heading, Text short intro, one Card [3-6 labeled TextField or Select or TextArea fields, each with bind], Inline justify=end [Button tone=secondary, Button tone=primary]]',
    },
    chat: {
      keywords: ['chat', 'conversation', 'message', 'messages', 'messaging', 'reply', 'thread', 'assistant', 'agent', 'support'],
      blueprint: 'Chat: Page [Heading, Card [4-6 ChatBubble alternating from=other and from=user, each with name], Inline [TextField with bind, Button tone=primary]]',
    },
    dashboard: {
      keywords: ['dashboard', 'tracker', 'status', 'monitor', 'monitoring', 'metric', 'metrics', 'report', 'overview', 'health', 'analytics', 'stat', 'stats', 'standup', 'progress', 'control room', 'mission control'],
      blueprint: 'Dashboard: Page [Heading, Inline [StatusBadge, 1-3 Tag], Grid columns=3 [3-6 Metric], Card [Heading level=h3, 2-3 ProgressBar], Alert only if something needs attention, Inline [1-2 Button]]',
    },
    settings: {
      keywords: ['settings', 'preferences', 'configuration', 'profile', 'account', 'admin', 'notification'],
      blueprint: 'Settings: Page [Heading, 2-3 Card each [Heading level=h3, 2-4 TextField or Select with bind], Inline justify=end [Button tone=primary]]',
    },
    compare: {
      // 'decision' proved too weak a signal: a status board "with a go/no-go
      // decision" is not a comparison, and the mismatched blueprint confused
      // the composition badly (flagged raccoon-heist run).
      keywords: ['compare', 'comparison', 'versus', 'vs', 'options', 'choose', 'pricing', 'plans', 'tradeoff', 'tradeoffs'],
      blueprint: 'Compare: Page [Heading, Text intro, Grid columns=2 [one Card per option [Heading level=h3, Text, Tag]], Inline [Button tone=secondary, Button tone=primary]]',
    },
  },
  generic: 'Page [Heading, Card or Stack sections grouping related content, Inline with actions last]',
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Count whole-word keyword hits for one pattern in a request. */
function patternKeywordHits(request: string, definition: PatternDefinition): number {
  const keywords = definition.keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
  if (!keywords.length) return 0;
  const matcher = new RegExp(`\\b(?:${keywords.map(escapeRegExp).join('|')})\\b`, 'g');
  return request.toLowerCase().match(matcher)?.length ?? 0;
}

/** The pattern keys a request resolves to, strongest match first (at most two). */
export function selectPatternKeys(request: string, library: PatternLibrary = DEFAULT_PATTERN_LIBRARY): PatternKey[] {
  return PATTERN_KEYS
    .map((key) => ({ key, hits: patternKeywordHits(request, library.patterns[key]) }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 2)
    .map((entry) => entry.key);
}

/** The blueprint lines injected into the prompt for a request. */
export function selectPatternRecipes(request: string, library: PatternLibrary = DEFAULT_PATTERN_LIBRARY): string[] {
  const keys = selectPatternKeys(request, library);
  return keys.length ? keys.map((key) => library.patterns[key].blueprint) : [library.generic];
}

export interface PromptOptions {
  /** True when the runtime natively enforces the transport schema (Chrome responseConstraint). */
  schemaEnforced?: boolean;
  /** User-tweakable pattern blueprints and trigger keywords. */
  patternLibrary?: PatternLibrary;
}

export function buildCompositionPrompt(userRequest: string, options: PromptOptions = {}): string {
  const structuralRules = options.schemaEnforced
    ? ''
    : `
- Return one JSON object only: {"root":"<rootId>","components":[...]}. No prose, no markdown fences.
- components is one flat array. children holds child ID strings; never nest component objects.
- Every id is unique and every child ID names an existing component.`;
  const recipes = selectPatternRecipes(userRequest, options.patternLibrary);
  return `Design a user interface for this request: ${userRequest.trim()}

You are the UI designer and you have full creative control. Choose the components, layout, hierarchy, real content, semantic tones, and one Page accent that match the mood of the request. Compositions should differ between requests — not everything is a dashboard.

Component catalog (choose freely):
${catalogGuide}

A2UI component shape — props sit alongside id and component, never nested:
{"id":"uniqueId","component":"CatalogName","text":"...","children":["childId"]}

Rules:${structuralRules}
- component must be exactly one of the catalog names; layout components take children, leaf components do not.
- value={"path":"/state/path"} only on TextField, TextArea, and Select. action only on Button.
- Write concrete, believable content. Plain text only: no HTML, markdown, code, or URLs.
- Aim for roughly 8–20 components; go beyond only when the request truly needs it.

Blueprint for this shape of request — copy the STRUCTURE, never the words. Invent every heading, label, option, and sentence from the request itself; add or drop sections to fit:
${recipes.join('\n')}
Transport reminder: emit every component as its own entry in the flat "components" array with a unique id. The brackets above mean children ID references — never nest component objects, and never write "Name": {...} pairs inside children.`;
}

export function buildRepairPrompt(userRequest: string, rejectedOutput: string, errors: string[], options: PromptOptions = {}): string {
  return `${buildCompositionPrompt(userRequest, options)}

Your previous attempt could not be rendered. Compose a corrected interface for the same request — keep your creative choices where they were valid.
What went wrong:
${errors.slice(0, 8).join('\n')}
Start of the rejected output:
${rejectedOutput.slice(0, 800)}`;
}
