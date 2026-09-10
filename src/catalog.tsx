/**
 * The catalog: each of the eighteen design-system components is declared
 * exactly once here, and everything that needs to agree about a component is
 * derived from this table:
 *
 *  - the A2UI v0.9 `Catalog` the official processor and renderer consume,
 *  - the strict prop schemas the salvage layer validates against,
 *  - the model-facing prompt guide and response-constraint allowlist,
 *  - the coercion rules that read the model's wording generously,
 *  - the library tab's definitions, and
 *  - the live streaming preview, which renders through the same functions.
 *
 * Adding a component means adding one entry; nothing else has to be told.
 */

import { Fragment, type ReactNode } from 'react';
import { z } from 'zod';
import { ActionSchema, Catalog, ChildListSchema, DynamicStringSchema, type ResolveA2uiProps } from '@a2ui/web_core/v0_9';
import { createComponentImplementation, type ReactComponentImplementation } from '@a2ui/react/v0_9';
import * as ds from './design-system';
import { accentSynonyms, buttonToneSynonyms, componentSynonyms, inputTypeSynonyms, semanticToneSynonyms, senderSynonyms } from './vocabulary';

export const COMPONENT_LIMIT = 60;
export const CHILDREN_LIMIT = 20;
export const TEXT_LIMIT = 2_000;
export const A2UI_CATALOG_ID = 'https://southleft.com/catalogs/local-generative-ui/v1';

/* -------------------------------------------------------------------------
 * Readers: interpret one raw prop value generously. Strictness lives in the
 * schemas below, so a reader may accept synonyms, strings for numbers, and
 * single-element arrays, but it never invents a value that was not written.
 * ---------------------------------------------------------------------- */

type Reader = (raw: unknown) => unknown;

export function coerceText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.slice(0, TEXT_LIMIT);
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return undefined;
}

export function coerceNumber(raw: unknown): number | undefined {
  // "columns":[2] is a real emission; a one-element array reads as its element.
  if (Array.isArray(raw) && raw.length === 1) return coerceNumber(raw[0]);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw.trim().replace(/%$/, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Keep at most `maxGraphemes` user-perceived characters (an emoji with modifiers is one), never splitting a cluster. */
function truncateGraphemes(value: string, maxGraphemes: number, maxUnits = 16): string {
  if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) return value.slice(0, maxUnits);
  let result = '';
  let count = 0;
  for (const { segment } of new Intl.Segmenter().segment(value)) {
    if (count >= maxGraphemes || result.length + segment.length > maxUnits) break;
    result += segment;
    count += 1;
  }
  return result;
}

function coerceIcon(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return truncateGraphemes(raw.trim(), 2) || undefined;
}

function enumOf(allowed: readonly string[], synonyms: Record<string, string> = {}): Reader {
  return (raw) => {
    if (typeof raw !== 'string') return undefined;
    const cleaned = raw.trim().toLowerCase();
    if (allowed.includes(cleaned)) return cleaned;
    const synonym = synonyms[cleaned];
    return synonym && allowed.includes(synonym) ? synonym : undefined;
  };
}

const toneOf = (allowed: readonly string[]) => enumOf(allowed, semanticToneSynonyms);

function selectOptions(raw: unknown): ds.SelectOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options = raw.slice(0, 12).flatMap((option): ds.SelectOption[] => {
    if (typeof option === 'string') return [{ label: option.slice(0, TEXT_LIMIT), value: option.slice(0, TEXT_LIMIT) }];
    if (!isRecord(option)) return [];
    const label = coerceText(option.label ?? option.text ?? option.name ?? option.value);
    const value = coerceText(option.value ?? option.label ?? option.text);
    return label !== undefined && value !== undefined ? [{ label, value }] : [];
  });
  return options.length ? options : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* -------------------------------------------------------------------------
 * Entry shape.
 * ---------------------------------------------------------------------- */

/** How one prop is read: the canonical key is implied, `aliases` are the other keys the model uses for it. */
interface PropRule {
  aliases: readonly string[];
  read: Reader;
  /** Used when nothing readable was written; lets a field render without a label instead of vanishing. */
  fallback?: unknown;
}

const prop = (read: Reader, ...aliases: string[]): PropRule => ({ aliases, read });
const propOr = (fallback: unknown, read: Reader, ...aliases: string[]): PropRule => ({ aliases, read, fallback });

type PropsSchema = z.ZodObject<z.ZodRawShape>;
/** Props as the A2UI binder hands them to a renderer: bindings resolved to values, actions to callbacks. */
export type RenderProps<S extends PropsSchema> = ResolveA2uiProps<z.infer<S>>;

interface CatalogEntry<S extends PropsSchema> {
  /** Layout components take children; input components bind `value` into the surface data model. */
  kind: 'layout' | 'leaf' | 'input';
  /** Documentation for the model and the library tab; becomes the A2UI schema description. */
  description: string;
  /** The prop line of the model-facing catalog guide, after "children; " or "leaf; ". */
  guide: string;
  /** The A2UI prop schema, built from the library's own primitives so bindings and actions resolve. */
  schema: S;
  /** Coercion rules in order; the first rule is the component's main text slot. */
  props: Record<string, PropRule>;
  /** Cross-prop adjustment after every rule has run. */
  finalize?: (props: Record<string, unknown>) => void;
  render(props: RenderProps<S>, children: ReactNode): ReactNode;
}

const define = <S extends PropsSchema>(entry: CatalogEntry<S>) => entry;
const layout = <Shape extends z.ZodRawShape>(shape: Shape) => z.object({ children: ChildListSchema, ...shape }).strict();
const icon = z.string().min(1).max(16).optional();
const tone = z.enum(ds.semanticTones);
const text = z.string().max(TEXT_LIMIT);

/* -------------------------------------------------------------------------
 * The table.
 * ---------------------------------------------------------------------- */

export const catalog = {
  Page: define({
    kind: 'layout',
    description: 'Root canvas for one generated surface; its accent hue themes the whole surface.',
    guide: 'props: accent=indigo|violet|sky|teal|emerald|amber|rose|slate (sets the surface mood)',
    schema: layout({ accent: z.enum(ds.pageAccents).optional() }),
    props: { accent: prop(enumOf(ds.pageAccents, accentSynonyms), 'theme', 'color') },
    render: (props, children) => <ds.Page accent={props.accent}>{children}</ds.Page>,
  }),
  Stack: define({
    kind: 'layout',
    description: 'Vertical layout with semantic spacing.',
    guide: 'props: gap=sm|md|lg',
    schema: layout({ gap: z.enum(ds.stackGaps).optional() }),
    props: { gap: prop(enumOf(ds.stackGaps, { small: 'sm', medium: 'md', large: 'lg', tight: 'sm', loose: 'lg' }), 'spacing') },
    render: (props, children) => <ds.Stack gap={props.gap}>{children}</ds.Stack>,
  }),
  Inline: define({
    kind: 'layout',
    description: 'Wrapping horizontal row; use for action rows and badge runs.',
    guide: 'props: align=start|center|end|stretch, justify=start|center|end|spaceBetween',
    schema: layout({ align: z.enum(ds.inlineAligns).optional(), justify: z.enum(ds.inlineJustifies).optional() }),
    props: {
      align: prop(enumOf(ds.inlineAligns, { left: 'start', right: 'end', middle: 'center', top: 'start', bottom: 'end' })),
      justify: prop(enumOf(ds.inlineJustifies, { left: 'start', right: 'end', middle: 'center', between: 'spaceBetween', 'space-between': 'spaceBetween', spacebetween: 'spaceBetween' })),
    },
    render: (props, children) => <ds.Inline align={props.align} justify={props.justify}>{children}</ds.Inline>,
  }),
  Grid: define({
    kind: 'layout',
    description: 'Responsive multi-column layout; put a run of Metrics in one Grid.',
    guide: 'props: columns=2|3|4',
    schema: layout({ columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional() }),
    props: {
      columns: prop((raw) => {
        const columns = coerceNumber(raw);
        return columns === undefined ? undefined : Math.min(4, Math.max(2, Math.round(columns)));
      }, 'cols'),
    },
    render: (props, children) => <ds.Grid columns={props.columns}>{children}</ds.Grid>,
  }),
  Card: define({
    kind: 'layout',
    description: 'Grouped content with an optional semantic tone.',
    guide: 'props: tone=default|recommended|muted|success|warning|critical',
    schema: layout({ tone: z.enum(ds.cardTones).optional() }),
    props: { tone: prop(toneOf(ds.cardTones), 'variant') },
    render: (props, children) => <ds.Card tone={props.tone}>{children}</ds.Card>,
  }),
  Heading: define({
    kind: 'leaf',
    description: 'Accessible section heading with an optional emoji icon.',
    guide: 'props: text, level=h1|h2|h3, icon (emoji)',
    schema: z.object({ text: DynamicStringSchema, level: z.enum(ds.headingLevels).optional(), icon }).strict(),
    props: {
      text: prop(coerceText, 'title', 'content', 'label'),
      level: prop((raw) => enumOf(ds.headingLevels, { '1': 'h1', '2': 'h2', '3': 'h3', h4: 'h3', h5: 'h3', h6: 'h3' })(typeof raw === 'number' ? `h${raw}` : raw)),
      icon: prop(coerceIcon, 'emoji'),
    },
    // An icon-only heading keeps its emoji instead of losing the node.
    finalize: (props) => {
      if (props.text === undefined && props.icon !== undefined) props.text = '';
    },
    render: (props) => <ds.Heading text={props.text} level={props.level} icon={props.icon} />,
  }),
  Text: define({
    kind: 'leaf',
    description: 'Plain, safely rendered supporting copy.',
    guide: 'props: text, tone=default|muted|success|warning|critical',
    schema: z.object({ text: DynamicStringSchema, tone: z.enum(ds.textTones).optional() }).strict(),
    props: { text: prop(coerceText, 'content', 'value', 'label'), tone: prop(toneOf(ds.textTones), 'variant') },
    render: (props) => <ds.Text text={props.text} tone={props.tone} />,
  }),
  ChatBubble: define({
    kind: 'leaf',
    description: 'One conversation message, aligned by sender.',
    guide: 'props: text, from=user|other, name (speaker)',
    schema: z.object({ text: DynamicStringSchema, from: z.enum(ds.bubbleSenders).optional(), name: z.string().max(120).optional() }).strict(),
    props: {
      text: prop(coerceText, 'message', 'content'),
      from: prop(enumOf(ds.bubbleSenders, senderSynonyms), 'role', 'sender', 'speaker'),
      name: prop((raw) => coerceText(raw)?.slice(0, 120), 'author'),
    },
    render: (props) => <ds.ChatBubble text={props.text} from={props.from} name={props.name} />,
  }),
  Metric: define({
    kind: 'leaf',
    description: 'Labelled value with detail, status tone, and optional emoji icon.',
    guide: 'props: label, value, detail, tone=neutral|success|warning|critical, icon (emoji); put several in one Grid',
    schema: z.object({ label: DynamicStringSchema, value: DynamicStringSchema, detail: DynamicStringSchema.optional(), tone: tone.optional(), icon }).strict(),
    props: {
      label: prop(coerceText, 'title', 'name'),
      value: prop(coerceText, 'metric', 'amount'),
      detail: prop(coerceText, 'trend', 'description', 'subtext'),
      tone: prop(toneOf(ds.semanticTones), 'variant'),
      icon: prop(coerceIcon, 'emoji'),
    },
    render: (props) => <ds.Metric label={props.label} value={props.value} detail={props.detail} tone={props.tone} icon={props.icon} />,
  }),
  StatusBadge: define({
    kind: 'leaf',
    description: 'Compact semantic status indicator.',
    guide: 'props: label, tone=neutral|success|warning|critical',
    schema: z.object({ label: DynamicStringSchema, tone }).strict(),
    props: { label: prop(coerceText, 'text', 'status'), tone: propOr('neutral', toneOf(ds.semanticTones), 'variant') },
    render: (props) => <ds.StatusBadge label={props.label} tone={props.tone} />,
  }),
  Tag: define({
    kind: 'leaf',
    description: 'Small labelled chip with tone and optional emoji icon.',
    guide: 'props: label, tone=neutral|success|warning|critical, icon (emoji)',
    schema: z.object({ label: DynamicStringSchema, tone: tone.optional(), icon }).strict(),
    props: { label: prop(coerceText, 'text', 'name'), tone: prop(toneOf(ds.semanticTones), 'variant'), icon: prop(coerceIcon, 'emoji') },
    render: (props) => <ds.Tag label={props.label} tone={props.tone} icon={props.icon} />,
  }),
  ProgressBar: define({
    kind: 'leaf',
    description: 'Labelled progress toward a goal, 0–100 percent.',
    guide: 'props: label, percent=0-100, tone=neutral|success|warning|critical',
    schema: z.object({ label: DynamicStringSchema, percent: z.number().min(0).max(100), tone: tone.optional() }).strict(),
    props: {
      // The percent is the content; a missing label must not cost the whole component.
      label: propOr('', coerceText, 'title', 'name'),
      percent: prop((raw) => {
        let percent = coerceNumber(raw);
        if (percent === undefined) return undefined;
        if (percent > 0 && percent < 1) percent *= 100;
        return Math.min(100, Math.max(0, percent));
      }, 'value', 'progress'),
      tone: prop(toneOf(ds.semanticTones), 'variant'),
    },
    render: (props) => <ds.ProgressBar label={props.label} percent={props.percent} tone={props.tone} />,
  }),
  Alert: define({
    kind: 'leaf',
    description: 'Prominent message for risk or status with optional emoji icon.',
    guide: 'props: title, message, tone=neutral|success|warning|critical, icon (emoji)',
    schema: z.object({ title: DynamicStringSchema, message: DynamicStringSchema, tone: tone.optional(), icon }).strict(),
    props: {
      title: prop(coerceText, 'heading', 'label'),
      message: prop(coerceText, 'text', 'description', 'content'),
      tone: prop(toneOf(ds.semanticTones), 'variant', 'severity'),
      icon: prop(coerceIcon, 'emoji'),
    },
    render: (props) => <ds.Alert title={props.title} message={props.message} tone={props.tone} icon={props.icon} />,
  }),
  Divider: define({
    kind: 'leaf',
    description: 'Horizontal separator between sections.',
    guide: 'no props',
    schema: z.object({}).strict(),
    props: {},
    render: () => <ds.Divider />,
  }),
  TextField: define({
    kind: 'input',
    description: 'Bound single-line input for text, email, URL, number, date, or phone; bind its value to a /state path.',
    guide: 'props: label, placeholder, inputType=text|email|url|number|date|tel; value={"path":"/state/path"}',
    schema: z.object({ label: text, value: DynamicStringSchema.optional(), placeholder: text.optional(), inputType: z.enum(ds.inputTypes).optional() }).strict(),
    props: {
      // A field missing its label should render label-less, not vanish.
      label: propOr('', coerceText, 'title', 'name'),
      placeholder: prop(coerceText, 'hint'),
      inputType: prop(enumOf(ds.inputTypes, inputTypeSynonyms), 'type'),
    },
    render: (props) => <ds.TextField label={props.label} value={props.value ?? ''} placeholder={props.placeholder} inputType={props.inputType} onChange={props.setValue} />,
  }),
  TextArea: define({
    kind: 'input',
    description: 'Bound multi-line text input; bind its value to a /state path.',
    guide: 'props: label, placeholder (multi-line); value={"path":"/state/path"}',
    schema: z.object({ label: text, value: DynamicStringSchema.optional(), placeholder: text.optional() }).strict(),
    props: { label: propOr('', coerceText, 'title', 'name'), placeholder: prop(coerceText, 'hint') },
    render: (props) => <ds.TextArea label={props.label} value={props.value ?? ''} placeholder={props.placeholder} onChange={props.setValue} />,
  }),
  Select: define({
    kind: 'input',
    description: 'Bound selection from an allowlisted option set.',
    guide: 'props: label, options=[{label,value}]; value={"path":"/state/path"}',
    schema: z.object({ label: text, value: DynamicStringSchema.optional(), options: z.array(z.object({ label: text, value: text }).strict()).min(1).max(12) }).strict(),
    props: { label: prop(coerceText, 'title', 'name'), options: prop(selectOptions, 'choices') },
    render: (props) => <ds.Select label={props.label} value={props.value ?? ''} options={props.options} onChange={props.setValue} />,
  }),
  Button: define({
    kind: 'leaf',
    description: 'Semantic action with optional emoji icon, dispatched through the host.',
    guide: 'props: label, tone=primary|secondary|danger, icon (emoji); action={"event":{"name":"lowerCamelName"}}',
    // `action` uses the library's ActionSchema so the binder turns the declaration into a callback.
    schema: z.object({ label: text, tone: z.enum(ds.buttonTones).optional(), icon, action: ActionSchema.optional() }).strict(),
    props: { label: prop(coerceText, 'text', 'title'), tone: prop(enumOf(ds.buttonTones, buttonToneSynonyms), 'variant'), icon: prop(coerceIcon, 'emoji') },
    render: (props) => <ds.Button label={props.label} tone={props.tone} icon={props.icon} onPress={props.action} />,
  }),
};

export type ComponentName = keyof typeof catalog;
export const componentNames = Object.keys(catalog) as [ComponentName, ...ComponentName[]];
export const componentNameSet: ReadonlySet<string> = new Set(componentNames);
export const layoutComponents: ReadonlySet<string> = new Set(componentNames.filter((name) => catalog[name].kind === 'layout'));
export const inputComponents: ReadonlySet<string> = new Set(componentNames.filter((name) => catalog[name].kind === 'input'));

/* -------------------------------------------------------------------------
 * Derived views.
 * ---------------------------------------------------------------------- */

function entryOf(component: ComponentName): CatalogEntry<PropsSchema> {
  return catalog[component];
}

/**
 * The binder hands a static child list through as ids and expands a
 * `{ componentId, path }` template into `{ id, basePath }` refs; render both
 * exactly as the library's own catalog does.
 */
type ChildRef = string | { id: string; basePath?: string };
function renderChildren(children: unknown, buildChild: (id: string, basePath?: string) => ReactNode): ReactNode {
  if (!Array.isArray(children)) return null;
  return (children as ChildRef[]).map((child, index) => typeof child === 'string'
    ? <Fragment key={`${child}-${index}`}>{buildChild(child)}</Fragment>
    : <Fragment key={`${child.id}-${child.basePath}`}>{buildChild(child.id, child.basePath)}</Fragment>);
}

function implement(name: ComponentName): ReactComponentImplementation {
  const entry = entryOf(name);
  return createComponentImplementation({ name, schema: entry.schema.describe(entry.description) }, ({ props, buildChild }) =>
    entry.render(props, entry.kind === 'layout' ? renderChildren((props as { children?: unknown }).children, buildChild) : null));
}

/** The design system as a real A2UI v0.9 catalog: the model's entire vocabulary and the renderer's only implementations. */
export const a2uiCatalog = new Catalog<ReactComponentImplementation>(A2UI_CATALOG_ID, componentNames.map(implement));

/** Render a component outside the A2UI runtime (the streaming preview): coerced props in, inert output out. */
export function renderComponent(component: ComponentName, props: Record<string, unknown>, children: ReactNode): ReactNode {
  const entry = entryOf(component);
  const main = mainPropKey(component);
  const filled = main !== undefined && props[main] === undefined ? { ...props, [main]: '…' } : props;
  return entry.render(filled as RenderProps<PropsSchema>, children);
}

export function coerceComponentName(raw: unknown): ComponentName | undefined {
  if (typeof raw !== 'string') return undefined;
  if (componentNameSet.has(raw)) return raw as ComponentName;
  return componentSynonyms[raw.trim().toLowerCase().replace(/[\s_-]/g, '')];
}

/** Interpret a raw props record: unknown props are dropped, values are read into the catalog vocabulary. */
export function coerceProps(component: ComponentName, raw: Record<string, unknown>): Record<string, unknown> {
  const entry = entryOf(component);
  const props: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(entry.props)) {
    const written = [key, ...rule.aliases].map((alias) => raw[alias]).find((value) => value != null);
    const value = rule.read(written) ?? rule.fallback;
    if (value !== undefined) props[key] = value;
  }
  entry.finalize?.(props);
  return props;
}

/**
 * `value` is A2UI's binding slot on the input components and is lifted
 * separately there; on every other component (Metric.value, for one) it is an
 * ordinary prop and must survive as one.
 */
const reservedNodeKeys = new Set(['id', 'component', 'type', 'props', 'children', 'bind', 'action', 'on']);
export function isReservedNodeKey(key: string, component: ComponentName): boolean {
  return reservedNodeKeys.has(key) || (key === 'value' && inputComponents.has(component));
}

/** Every prop key any component reads, plus the binding slots: the tokens that act as keys in an inlined child. */
export const inlinePropKeys: ReadonlySet<string> = new Set([...componentNames.flatMap((name) => Object.keys(catalog[name].props)), 'value', 'bind']);

/** The main text or label slot of a leaf component, if it has one. */
export function mainPropKey(component: ComponentName): string | undefined {
  const entry = entryOf(component);
  return entry.kind === 'layout' ? undefined : Object.keys(entry.props)[0];
}

/** Props the schema requires; a node that cannot satisfy them is dropped rather than rendered hollow. */
export function requiredProps(component: ComponentName): string[] {
  return Object.entries(entryOf(component).schema.shape).filter(([key, field]) => key !== 'children' && !field.isOptional()).map(([key]) => key);
}

/** Library-tab definitions, straight from the table. */
export const componentDefinitions = componentNames.map((name) => ({
  name,
  description: catalog[name].description,
  props: Object.keys(catalog[name].schema.shape).filter((key) => key !== 'children'),
  acceptsChildren: catalog[name].kind === 'layout',
}));
