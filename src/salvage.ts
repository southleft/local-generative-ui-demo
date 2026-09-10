/**
 * Salvage: rebuild a renderable composition from whatever the model emitted.
 *
 * The layer is prompt-blind (it sees parsed output, never the request), it
 * only reattaches content the model wrote, and it never invents any. Every
 * pass interprets generously and then the strict schemas gate the result;
 * every adjustment is reported as a warning so the run stays inspectable.
 */

import { z } from 'zod';
import {
  CHILDREN_LIMIT, COMPONENT_LIMIT, TEXT_LIMIT, catalog, coerceComponentName, coerceProps, componentNames, inlinePropKeys,
  inputComponents, isRecord, isReservedNodeKey, layoutComponents, mainPropKey, requiredProps, type ComponentName,
} from './catalog';
import { isSafeJsonPointer } from './json-pointer';
import { repairModelJson } from './repair';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ACTION_NAME = /^[a-z][A-Za-z0-9]{0,99}$/;

const identifier = z.string().min(1).max(120).regex(IDENTIFIER);
const contextValue = z.union([z.string().max(TEXT_LIMIT), z.number(), z.boolean(), z.null()]);
const actionSchema = z.object({
  name: z.string().min(1).max(100).regex(ACTION_NAME),
  context: z.record(z.string(), contextValue).refine((context) => Object.keys(context).length <= CHILDREN_LIMIT, `at most ${CHILDREN_LIMIT} context values`).optional(),
}).strict();
const nodeSchema = z.object({
  id: identifier,
  component: z.enum(componentNames),
  props: z.record(z.string(), z.unknown()).optional(),
  children: z.array(identifier).max(CHILDREN_LIMIT).optional(),
  bind: z.string().startsWith('/').max(200).refine(isSafeJsonPointer, 'unsafe JSON Pointer path').optional(),
  action: actionSchema.optional(),
}).strict();

/** The neutral graph every surface passes through before it is compiled to A2UI messages. */
export const compositionSchema = z.object({
  root: identifier,
  nodes: z.array(nodeSchema).min(1).max(COMPONENT_LIMIT),
}).strict();

export type CatalogComposition = z.infer<typeof compositionSchema>;
export type CatalogNode = CatalogComposition['nodes'][number];
type NodeAction = NonNullable<CatalogNode['action']>;

export interface ParsedComposition {
  composition: CatalogComposition;
  /** Human-readable salvage decisions: coercions, dropped nodes, pruned references. */
  warnings: string[];
}

/** What salvage may do to model output, in execution order. Documentation for the harness panel. */
export const SALVAGE_PLAYBOOK = [
  'Split fused "key:value" strings back into pairs, balance mismatched JSON delimiters, and repair truncated output (jsonrepair).',
  'Merge fragments when a truncated stream splits into an envelope plus stray top-level nodes.',
  'Re-split run-on emissions where no node object was ever closed and repeated "id" keys would overwrite each other; when whole-document repair fails outright, repair each "id"-delimited fragment on its own.',
  'Interpret component and prop synonyms into the catalog vocabulary; drop unknown props.',
  'Reconstruct child components the model inlined into a children array instead of emitting nodes.',
  'Keep the first occurrence of duplicate node IDs when the repeat is identical (greedy models repeat themselves); a leaf that reuses its container\'s id is a parent pointer and is re-homed under it, and a leaf that reuses another leaf\'s id with different content is renamed and kept.',
  'Ignore component type names written into children arrays; the real child follows by id.',
  'Validate every node against its strict schema; strip invalid optional props before giving up on a node.',
  'Remove semantic duplicates: repeated fields, buttons, headings, metrics, and alerts with identical content keep only their first occurrence.',
  'Derive a missing Button label from its action name; keep icon-only Headings; render label-less fields.',
  'Prune references to missing nodes, enforce single parenthood (a node listed under two parents renders once; the root yields to the more specific container), and break reference cycles.',
  'Adopt disconnected nodes into the nearest preceding layout container (flat depth-first recovery).',
  'Remove empty layout containers; group runs of Buttons, Tags, and badges into an Inline row and runs of Metrics into a Grid.',
  'Require a renderable floor (a root plus visible content) — otherwise request one of at most two model repairs.',
] as const;

/* -------------------------------------------------------------------------
 * Node-level interpretation.
 * ---------------------------------------------------------------------- */

export function deriveActionName(label: unknown): string {
  if (typeof label === 'string') {
    const words = label.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
    const name = words.length ? words[0] + words.slice(1).map((word) => word[0].toUpperCase() + word.slice(1)).join('') : '';
    if (ACTION_NAME.test(name)) return name;
  }
  return 'activate';
}

function coerceAction(raw: unknown, label: unknown): NodeAction {
  // A2UI wraps actions as { event: { name, context } }; earlier drafts and
  // sloppy models emit a bare { name } or even a string.
  const outer = isRecord(raw) ? raw : {};
  const candidate = isRecord(outer.event) ? outer.event : outer;
  let name = typeof candidate.name === 'string' ? candidate.name : typeof candidate.event === 'string' ? candidate.event : typeof raw === 'string' ? raw : undefined;
  if (name && !ACTION_NAME.test(name)) {
    const camel = name
      .replace(/[^A-Za-z0-9_-]/g, '')
      .replace(/[-_]+([A-Za-z0-9])/g, (_, character: string) => character.toUpperCase())
      .replace(/^[A-Z]/, (character) => character.toLowerCase());
    name = ACTION_NAME.test(camel) ? camel : undefined;
  }
  const context: NonNullable<NodeAction['context']> = {};
  if (isRecord(candidate.context)) {
    for (const [key, value] of Object.entries(candidate.context).slice(0, CHILDREN_LIMIT)) {
      // Nested objects and arrays are dropped: action context stays scalar-only.
      if (value === null || typeof value === 'number' || typeof value === 'boolean') context[key] = value;
      else if (typeof value === 'string') context[key] = value.slice(0, TEXT_LIMIT);
    }
  }
  return { name: name ?? deriveActionName(label), ...(Object.keys(context).length ? { context } : {}) };
}

function coerceNodeId(raw: unknown, fallback: string): string {
  const candidate = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? `node${raw}` : '';
  if (IDENTIFIER.test(candidate) && candidate.length <= 120) return candidate;
  const sanitized = candidate.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : fallback;
}

type InlineToken = string | number | Record<string, unknown>;

/**
 * Small models sometimes inline a whole child component into a children array
 * ("children":["TextField","label":"Full Name",...]). jsonrepair flattens that
 * into a token stream of names, keys, ":" separators, and values. Rebuild the
 * intended child nodes from that stream so form fields survive.
 */
function parseInlineChildTokens(tokens: InlineToken[]): Array<Record<string, unknown> | string> | undefined {
  if (!tokens.some((token) => token === ':')) return undefined;
  const children: Array<Record<string, unknown> | string> = [];
  let current: Record<string, unknown> | undefined;
  let pendingKey: string | undefined;
  let lastKey: string | undefined;
  for (const token of tokens) {
    if (token === ':') continue;
    // "Name": {…} inlines arrive as a name token followed by an object token.
    if (isRecord(token)) {
      if (token.component !== undefined) {
        children.push(token);
        current = token;
      } else if (current) {
        Object.assign(current, token);
      } else if (token.id !== undefined) {
        children.push(token);
      }
      pendingKey = undefined;
      lastKey = undefined;
      continue;
    }
    if (typeof token !== 'string') continue;
    if (pendingKey === undefined && !inlinePropKeys.has(token)) {
      const component = coerceComponentName(token);
      if (component) {
        // "Heading","h2",… — a level token right after a bare Heading is its
        // level, not a second Heading (which would be empty and dropped).
        if (current?.component === 'Heading' && component === 'Heading' && /^h[1-3]$/i.test(token) && Object.keys(current).length === 1) {
          current.level = token.toLowerCase();
          continue;
        }
        current = { component };
        children.push(current);
        lastKey = undefined;
        continue;
      }
    }
    if (pendingKey === undefined) {
      if (inlinePropKeys.has(token) && current) {
        pendingKey = token;
        continue;
      }
      // A value split mid-stream (e.g. a bind path broken at "/") continues
      // the previous value; nothing else may glue onto it — that corrupted
      // heading text with sibling IDs in a flagged run.
      if (current && lastKey !== undefined && typeof current[lastKey] === 'string' && String(current[lastKey]).endsWith('/')) {
        current[lastKey] = `${current[lastKey]}${token}`;
        continue;
      }
      // Bare identifier tokens are sibling child ID references, not text.
      if (IDENTIFIER.test(token)) {
        children.push(token);
        lastKey = undefined;
        continue;
      }
      // A bare phrase right after a component is its main text/label.
      if (current) {
        const key = mainPropKey(current.component as ComponentName);
        if (key && current[key] === undefined) {
          current[key] = token;
          lastKey = key;
        }
      }
      continue;
    }
    if (current) {
      current[pendingKey] = token;
      lastKey = pendingKey;
    }
    pendingKey = undefined;
  }
  return children.length ? children : undefined;
}

interface InterpretedNode {
  node: CatalogNode;
  childRefs: Array<string | Record<string, unknown>>;
}

/**
 * Interpret one raw node object: coerce the component name, merge stray
 * top-level props, coerce all prop values, and lift bind/action. Returns
 * undefined when no catalog component can be recovered.
 */
function interpretNode(raw: Record<string, unknown>, fallbackId: string, warnings: string[]): InterpretedNode | undefined {
  const component = coerceComponentName(raw.component ?? raw.type);
  if (!component) {
    warnings.push(`Dropped node "${String(raw.id ?? fallbackId)}": component "${String(raw.component ?? raw.type ?? 'missing')}" is not in the catalog.`);
    return undefined;
  }
  if (component !== raw.component) warnings.push(`Interpreted component "${String(raw.component ?? raw.type)}" as ${component}.`);
  const id = coerceNodeId(raw.id, fallbackId);
  const strayProps = Object.fromEntries(Object.entries(raw).filter(([key]) => !isReservedNodeKey(key, component)));
  const rawProps = { ...strayProps, ...(isRecord(raw.props) ? raw.props : {}) };
  const props = coerceProps(component, rawProps);

  // A2UI binds via value: { path: "/..." }; a bare bind:"/..." string is also
  // tolerated because models drift between the two.
  const rawValue = raw.value ?? rawProps.value;
  const rawBind = raw.bind ?? rawProps.bind ?? (isRecord(rawValue) && typeof rawValue.path === 'string' ? rawValue.path : rawValue);
  const bind = inputComponents.has(component) && typeof rawBind === 'string' && rawBind.startsWith('/') && isSafeJsonPointer(rawBind) ? rawBind : undefined;

  let action: NodeAction | undefined;
  if (component === 'Button') {
    action = coerceAction(raw.action ?? rawProps.action ?? raw.on, props.label);
    // A Button that arrived without a label but with a semantic action can
    // recover its label from the action name ("submitIntake" -> "Submit intake").
    if (props.label === undefined && action.name !== 'activate') {
      const words = action.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
      props.label = words[0].toUpperCase() + words.slice(1);
    }
  }

  // Small models sometimes tuck children inside props; lift them like bind/action.
  const rawChildren = Array.isArray(raw.children) ? raw.children : Array.isArray(rawProps.children) ? rawProps.children : [];
  let childRefs: Array<string | Record<string, unknown>> = rawChildren
    .filter((child): child is InlineToken => typeof child === 'string' || typeof child === 'number' || isRecord(child))
    .map((child) => typeof child === 'number' ? `node${child}` : child);
  const inlineChildren = parseInlineChildTokens(childRefs);
  if (inlineChildren) {
    warnings.push(`Reconstructed ${inlineChildren.length} inline child component${inlineChildren.length === 1 ? '' : 's'} declared inside "${id}".children.`);
    childRefs = inlineChildren;
  }

  return {
    node: {
      id,
      component,
      ...(Object.keys(props).length ? { props } : {}),
      ...(bind ? { bind } : {}),
      ...(action ? { action } : {}),
    },
    childRefs,
  };
}

/* -------------------------------------------------------------------------
 * Graph-level passes, in execution order. Each takes the working node map and
 * appends to the shared warning list.
 * ---------------------------------------------------------------------- */

type NodeMap = Map<string, CatalogNode>;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const isLayout = (node: CatalogNode) => layoutComponents.has(node.component);
const removeChildEverywhere = (nodes: NodeMap, id: string) => {
  for (const parent of nodes.values()) if (parent.children?.includes(id)) parent.children = parent.children.filter((child) => child !== id);
};

/** Flatten every raw node (including inlined children) into interpreted nodes in emission order. */
function collectNodes(input: Record<string, unknown>, warnings: string[]): { interpreted: InterpretedNode[]; declaredRoot?: string } {
  const interpreted: InterpretedNode[] = [];
  let generatedId = 0;
  const flatten = (value: Record<string, unknown>, fallbackId?: string): string | undefined => {
    const entry = interpretNode(value, fallbackId ?? `generatedNode${++generatedId}`, warnings);
    if (!entry) return undefined;
    interpreted.push(entry);
    entry.node.children = entry.childRefs
      .map((child) => typeof child === 'string' ? child : flatten(child))
      .filter((child): child is string => typeof child === 'string');
    if (!entry.node.children.length && !isLayout(entry.node)) delete entry.node.children;
    return entry.node.id;
  };

  let declaredRoot = typeof input.root === 'string' ? input.root : undefined;
  if (isRecord(input.root)) declaredRoot = flatten(input.root, 'root');
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : Array.isArray(input.components) ? input.components : [];
  for (const raw of rawNodes.slice(0, COMPONENT_LIMIT)) if (isRecord(raw)) flatten(raw);
  if (rawNodes.length > COMPONENT_LIMIT) warnings.push(`Kept the first ${COMPONENT_LIMIT} of ${rawNodes.length} nodes.`);
  if (!interpreted.length && typeof input.component === 'string') flatten(input, 'root');
  if (!interpreted.length) throw new Error('No catalog components could be recovered from the model output.');
  return { interpreted, declaredRoot };
}

/**
 * First occurrence wins for duplicate IDs, with two readings. A leaf that
 * reuses an earlier *container's* id is the model pointing at its parent (a
 * captured run listed a Card's children as type names, then emitted each leaf
 * under the Card's own id): re-home it under a fresh id. Two leaves under one
 * id with *different* content are distinct nodes the model failed to name
 * apart (one checkout emitted four fields all as "shippingAddressField"):
 * rename and keep. Identical repeats are the greedy loop and drop.
 */
function resolveDuplicateIds(interpreted: InterpretedNode[], warnings: string[]): NodeMap {
  const nodes: NodeMap = new Map();
  const rehomed = new Map<string, string[]>();
  const renamed = new Map<string, string[]>();
  const describeLeaf = (node: CatalogNode) => {
    const label = node.props?.label ?? node.props?.text ?? node.props?.title;
    return typeof label === 'string' && label ? `${node.component} "${label.slice(0, 32)}"` : node.component;
  };
  const signature = (node: CatalogNode) => `${node.component}|${JSON.stringify(node.props ?? {})}`;
  const freshId = (base: string, start: number) => {
    let sequence = start;
    while (nodes.has(`${base}${sequence}`)) sequence += 1;
    return `${base}${sequence}`;
  };
  for (const { node } of interpreted) {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      continue;
    }
    if (isLayout(existing) && !isLayout(node) && (existing.children?.length ?? 0) < CHILDREN_LIMIT) {
      node.id = freshId(`${node.id}-${node.component.toLowerCase()}`, 1);
      nodes.set(node.id, node);
      existing.children = [...(existing.children ?? []), node.id];
      rehomed.set(existing.id, [...(rehomed.get(existing.id) ?? []), node.component]);
      continue;
    }
    const base = node.id;
    const holders = [existing, ...(renamed.has(base) ? [...nodes.values()].filter((candidate) => candidate.id.startsWith(`${base}-`)) : [])];
    const sameContent = holders.some((holder) => signature(holder) === signature(node));
    if (!isLayout(existing) && !isLayout(node) && !sameContent) {
      node.id = freshId(`${base}-`, 2);
      nodes.set(node.id, node);
      renamed.set(base, [...(renamed.get(base) ?? []), describeLeaf(node)]);
      continue;
    }
    warnings.push(`Dropped duplicate node ID "${node.id}".`);
  }
  for (const [id, leaves] of renamed) {
    warnings.push(`Renamed ${plural(leaves.length, 'component')} that reused the id "${id}" with different content: ${leaves.slice(0, 4).join(', ')}${leaves.length > 4 ? ', …' : ''}.`);
  }
  for (const [containerId, components] of rehomed) {
    warnings.push(`Re-homed ${plural(components.length, 'component')} that reused their container's id "${containerId}" as their own: ${components.join(', ')}.`);
  }
  return nodes;
}

/**
 * Children written as component type names ("Heading", "TextField") that
 * name no node are annotations of the child that follows by id, not
 * dangling references; drop them without counting them as pruning.
 */
function ignoreTypeNameAnnotations(nodes: NodeMap, warnings: string[]): void {
  let count = 0;
  for (const node of nodes.values()) {
    if (!node.children) continue;
    node.children = node.children.filter((child) => {
      if (nodes.has(child) || !coerceComponentName(child)) return true;
      count += 1;
      return false;
    });
  }
  if (count) warnings.push(`Ignored ${plural(count, 'component type name')} written as child references; the real children follow by id.`);
}

/**
 * Per-node strict validation with generous recovery: validate the A2UI-flat
 * shape against the catalog schema; on failure drop optional offenders, then
 * drop the node.
 */
function validateNodes(nodes: NodeMap, warnings: string[]): void {
  for (const [id, node] of [...nodes]) {
    const validate = () => catalog[node.component].schema.safeParse({
      ...node.props,
      ...(node.children ? { children: node.children } : {}),
      ...(node.bind ? { value: { path: node.bind } } : {}),
      ...(node.action ? { action: { event: { name: node.action.name, ...(node.action.context ? { context: node.action.context } : {}) } } } : {}),
    });
    let result = validate();
    if (result.success) continue;
    const required = new Set(requiredProps(node.component));
    const offenders = new Set<string>();
    for (const issue of result.error.issues) {
      // Zod reports stray keys via issue.keys with an empty path.
      if (issue.code === 'unrecognized_keys') for (const key of issue.keys) offenders.add(key);
      else offenders.add(String(issue.path[0] ?? ''));
    }
    let droppedRequired = false;
    for (const key of offenders) {
      if (!key) continue;
      if (required.has(key)) {
        droppedRequired = true;
        break;
      }
      if (key === 'children') {
        if (isLayout(node)) node.children = [];
        else delete node.children;
      } else if (key === 'value') delete node.bind;
      else if (key === 'action') node.action = { name: deriveActionName(node.props?.label) };
      else if (node.props) delete node.props[key];
    }
    result = droppedRequired ? result : validate();
    if (droppedRequired || !result.success) {
      const detail = result.success ? 'missing required content' : result.error.issues.map((issue) => `${issue.path.join('.') || 'node'} ${issue.message}`).slice(0, 3).join('; ');
      warnings.push(`Dropped ${node.component} "${id}": ${detail}`);
      nodes.delete(id);
      continue;
    }
    warnings.push(`Recovered ${node.component} "${id}" by dropping invalid optional props.`);
  }
  if (!nodes.size) throw new Error('Every generated node failed catalog validation.');
}

/**
 * Greedy models repeat themselves semantically too: the same field, button,
 * heading, or metric emitted twice under different IDs. Keep the first
 * occurrence of any component whose identifying content is an exact repeat.
 * Tags, badges, dividers, and layout containers are exempt; short repeats of
 * those are legitimate.
 */
function removeRepeatedContent(nodes: NodeMap, warnings: string[]): void {
  const text = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const contentKey = (node: CatalogNode): string | undefined => {
    const props = node.props ?? {};
    switch (node.component) {
      case 'Heading': return text(props.text) ? `Heading|${text(props.text)}` : undefined;
      case 'Text': return text(props.text).length > 12 ? `Text|${text(props.text)}` : undefined;
      case 'ChatBubble': return text(props.text).length > 12 ? `ChatBubble|${text(props.text)}|${text(props.from)}` : undefined;
      case 'Metric': return text(props.label) ? `Metric|${text(props.label)}|${text(props.value)}` : undefined;
      case 'ProgressBar': return text(props.label) ? `ProgressBar|${text(props.label)}|${String(props.percent)}` : undefined;
      case 'Alert': return text(props.title) ? `Alert|${text(props.title)}|${text(props.message)}` : undefined;
      case 'TextField':
      case 'TextArea':
      case 'Select': return text(props.label) ? `${node.component}|${text(props.label)}` : undefined;
      case 'Button': return text(props.label) ? `Button|${text(props.label)}|${node.action?.name ?? ''}` : undefined;
      default: return undefined;
    }
  };
  const seen = new Set<string>();
  const removed: string[] = [];
  for (const [id, node] of [...nodes]) {
    const key = contentKey(node);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    nodes.delete(id);
    removeChildEverywhere(nodes, id);
    const label = typeof node.props?.label === 'string' ? node.props.label : typeof node.props?.text === 'string' ? node.props.text.slice(0, 24) : id;
    removed.push(`${node.component} "${label}"`);
  }
  if (removed.length) {
    const samples = [...new Set(removed)].slice(0, 5);
    warnings.push(`Removed ${plural(removed.length, 'component')} repeating identical content: ${samples.join(', ')}${removed.length > samples.length ? ', …' : ''}.`);
  }
}

/**
 * Prune references to dropped nodes, then enforce single parenthood: models
 * sometimes list the same node under two parents (or twice in one children
 * array), which renders it once per reference. Among ordinary parents the
 * first claim in emission order wins, but the declared root is settled last,
 * so it yields to any other claimant. Small models habitually list everything
 * they are about to emit under the root and *then* nest a subset properly;
 * honoring the root's flat catch-all strands the real container empty.
 */
function settleParents(nodes: NodeMap, declaredRoot: string | undefined, warnings: string[]): void {
  for (const node of nodes.values()) {
    if (!node.children) continue;
    const kept = node.children.filter((child) => nodes.has(child) && child !== node.id);
    const pruned = node.children.length - kept.length;
    if (pruned) warnings.push(`Pruned ${plural(pruned, 'missing child reference')} from "${node.id}".`);
    node.children = kept;
  }
  const rootId = declaredRoot && nodes.has(declaredRoot) ? declaredRoot : undefined;
  const claimOrder = [...nodes.values()].sort((a, b) => Number(a.id === rootId) - Number(b.id === rootId));
  const claimed = new Set<string>();
  const duplicates: string[] = [];
  for (const node of claimOrder) {
    if (!node.children) continue;
    node.children = node.children.filter((child) => {
      if (claimed.has(child)) {
        duplicates.push(child);
        return false;
      }
      claimed.add(child);
      return true;
    });
  }
  if (duplicates.length) {
    const samples = [...new Set(duplicates)].slice(0, 5);
    warnings.push(`Removed ${plural(duplicates.length, 'duplicate parent reference')} so each component renders once: ${samples.join(', ')}${duplicates.length > samples.length ? ', …' : ''}.`);
  }
}

/** Resolve the root: the declared root, else a single orphan, else a synthesized Page around the orphans. */
function resolveRoot(nodes: NodeMap, declaredRoot: string | undefined, warnings: string[]): string {
  const childIds = new Set([...nodes.values()].flatMap((node) => node.children ?? []));
  const orphans = [...nodes.keys()].filter((id) => !childIds.has(id));
  if (declaredRoot && nodes.has(declaredRoot)) return declaredRoot;
  if (orphans.length === 1) return orphans[0];

  const rootId = declaredRoot && !nodes.has(declaredRoot) && IDENTIFIER.test(declaredRoot) && declaredRoot.length <= 112 ? declaredRoot : 'generatedRoot';
  const layoutId = `${rootId}Layout`;
  // Before wrapping, nest orphan leaves under the nearest preceding orphan
  // layout container: emission order is design intent, and run-on streams
  // arrive fully disconnected.
  const heads: string[] = [];
  let lastLayout: CatalogNode | undefined;
  for (const id of orphans) {
    const orphan = nodes.get(id)!;
    if (lastLayout && !isLayout(orphan) && (lastLayout.children?.length ?? 0) < CHILDREN_LIMIT) lastLayout.children = [...(lastLayout.children ?? []), id];
    else heads.push(id);
    if (isLayout(orphan)) lastLayout = orphan;
  }
  if (nodes.size > COMPONENT_LIMIT - 2 || heads.length > CHILDREN_LIMIT) throw new Error('The composition has no usable root node.');
  nodes.set(rootId, { id: rootId, component: 'Page', children: [layoutId] });
  nodes.set(layoutId, { id: layoutId, component: 'Stack', props: { gap: 'lg' }, children: heads });
  warnings.push(`Wrapped ${heads.length} top-level nodes in a synthesized Page layout.`);
  return rootId;
}

/**
 * Break cycles by dropping back-edges, adopt disconnected nodes into the
 * nearest preceding layout container (small models emit flat depth-first
 * sequences without linking children back to their container), then prune
 * whatever is still unreachable from the root.
 */
function connectTree(nodes: NodeMap, root: string, warnings: string[]): void {
  const reachable = new Set<string>();
  const walk = (id: string, ancestors: Set<string>) => {
    const node = nodes.get(id);
    if (!node || reachable.has(id)) return;
    reachable.add(id);
    if (!node.children) return;
    const lineage = new Set(ancestors).add(id);
    node.children = node.children.filter((child) => {
      if (!lineage.has(child)) return true;
      warnings.push(`Removed a cyclic reference from "${id}" to "${child}".`);
      return false;
    });
    for (const child of node.children) walk(child, lineage);
  };
  walk(root, new Set());
  if (![...nodes.keys()].some((id) => !reachable.has(id))) return;

  const referenced = new Set([...nodes.values()].flatMap((node) => node.children ?? []));
  let lastLayoutId = isLayout(nodes.get(root)!) ? root : undefined;
  let adopted = 0;
  for (const [id, node] of nodes) {
    if (!reachable.has(id) && !referenced.has(id) && lastLayoutId && id !== root) {
      const container = nodes.get(lastLayoutId)!;
      if ((container.children?.length ?? 0) < CHILDREN_LIMIT) {
        container.children = [...(container.children ?? []), id];
        adopted += 1;
      }
    }
    if (isLayout(node)) lastLayoutId = id;
  }
  if (adopted) {
    warnings.push(`Adopted ${plural(adopted, 'disconnected node')} into the nearest preceding layout container.`);
    reachable.clear();
    walk(root, new Set());
  }
  const pruned = [...nodes.keys()].filter((id) => !reachable.has(id));
  if (pruned.length) {
    for (const id of pruned) nodes.delete(id);
    warnings.push(`Pruned ${plural(pruned.length, 'node')} not reachable from the root.`);
  }
}

/** Pruning can leave hollow layout boxes behind; an empty Card renders as a bare border. Cascade upward. */
function removeEmptyContainers(nodes: NodeMap, root: string, warnings: string[]): void {
  let removed = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of [...nodes]) {
      if (id === root || !isLayout(node) || node.children?.length) continue;
      nodes.delete(id);
      removeChildEverywhere(nodes, id);
      removed += 1;
      changed = true;
    }
  }
  if (removed) warnings.push(`Removed ${plural(removed, 'empty layout container')}.`);
}

/**
 * The layout containers are flex columns, so consecutive leaves that belong
 * side by side would each stack full-width. Group runs of two or more:
 * Buttons/Tags/badges into a synthesized Inline row (only under Page/Card,
 * where an explicit Stack choice such as a full-width submit is respected),
 * and Metrics into a synthesized Grid under any column container.
 */
function groupRows(nodes: NodeMap, warnings: string[]): void {
  const inlineLeaves = new Set(['Tag', 'StatusBadge', 'Button']);
  let sequence = 0;
  const freshId = (base: string) => {
    let id = `${base}${++sequence}`;
    while (nodes.has(id)) id = `${base}${++sequence}`;
    return id;
  };
  for (const node of [...nodes.values()]) {
    const underPageOrCard = node.component === 'Page' || node.component === 'Card';
    if ((!underPageOrCard && node.component !== 'Stack') || !node.children || node.children.length < 2) continue;
    const grouped: string[] = [];
    let run: string[] = [];
    let runType: 'inline' | 'metric' | null = null;
    const flush = () => {
      if (runType && run.length >= 2 && nodes.size < COMPONENT_LIMIT) {
        if (runType === 'metric') {
          const columns = Math.min(run.length, 4) as 2 | 3 | 4;
          const gridId = freshId('metricGrid');
          nodes.set(gridId, { id: gridId, component: 'Grid', props: { columns }, children: run });
          grouped.push(gridId);
          warnings.push(`Grouped ${run.length} metrics under "${node.id}" into a ${columns}-column grid.`);
        } else {
          const inlineId = freshId('inlineRow');
          nodes.set(inlineId, { id: inlineId, component: 'Inline', children: run });
          grouped.push(inlineId);
          warnings.push(`Grouped ${run.length} inline components under "${node.id}" into a row.`);
        }
      } else {
        grouped.push(...run);
      }
      run = [];
      runType = null;
    };
    for (const child of node.children) {
      const component = nodes.get(child)?.component;
      const type: 'inline' | 'metric' | null = component === 'Metric' ? 'metric' : component && inlineLeaves.has(component) && underPageOrCard ? 'inline' : null;
      if (type && type === runType) {
        run.push(child);
        continue;
      }
      flush();
      if (type) {
        runType = type;
        run.push(child);
      } else {
        grouped.push(child);
      }
    }
    flush();
    node.children = grouped;
  }
}

/**
 * A greedy-decoding repetition loop can generate dozens of identical salvage
 * events. Collapse exact repeats and the noisiest per-item families into
 * summaries so the adjustment count reflects distinct decisions.
 */
function compactWarnings(warnings: string[]): string[] {
  const counts = new Map<string, number>();
  for (const warning of warnings) counts.set(warning, (counts.get(warning) ?? 0) + 1);
  let result = [...counts].map(([warning, count]) => count > 1 ? `${warning.replace(/\.$/, '')} (×${count}).` : warning);
  const collapse = (pattern: RegExp, threshold: number, summarize: (matches: RegExpMatchArray[]) => string) => {
    const matches = result.map((warning) => warning.match(pattern)).filter((match): match is RegExpMatchArray => match !== null);
    if (matches.length >= threshold) result = [...result.filter((warning) => !pattern.test(warning)), summarize(matches)];
  };
  collapse(/^Dropped duplicate node ID "(.+?)"/, 3, (matches) =>
    `Dropped ${matches.length} duplicate node IDs (kept first occurrences): ${matches.slice(0, 6).map((match) => match[1]).join(', ')}${matches.length > 6 ? ', …' : ''}.`);
  collapse(/^Pruned (\d+) missing child reference/, 5, (matches) =>
    `Pruned ${matches.reduce((sum, match) => sum + Number(match[1]), 0)} missing child references across ${matches.length} containers.`);
  collapse(/^Dropped (?!duplicate)(\w+) "/, 7, (matches) =>
    `Dropped ${matches.length} nodes that failed catalog validation (${[...new Set(matches.map((match) => match[1]))].join(', ')}).`);
  return result;
}

/**
 * Rebuild a renderable composition from arbitrary parsed model output. Nodes
 * that cannot be recovered are dropped with a warning instead of failing the
 * whole composition; the strict schemas still gate the final result.
 */
export function salvageComposition(input: unknown): ParsedComposition {
  if (!isRecord(input)) throw new Error('The model output is not a JSON object.');
  const warnings: string[] = [];
  const { interpreted, declaredRoot } = collectNodes(input, warnings);
  const nodes = resolveDuplicateIds(interpreted, warnings);
  ignoreTypeNameAnnotations(nodes, warnings);
  validateNodes(nodes, warnings);
  removeRepeatedContent(nodes, warnings);
  settleParents(nodes, declaredRoot, warnings);
  const root = resolveRoot(nodes, declaredRoot, warnings);
  connectTree(nodes, root, warnings);
  removeEmptyContainers(nodes, root, warnings);
  groupRows(nodes, warnings);
  if (![...nodes.values()].some((node) => !isLayout(node))) throw new Error('The composition contains no visible content components.');
  const composition = compositionSchema.parse({ root, nodes: [...nodes.values()] });
  return { composition, warnings: compactWarnings(warnings) };
}

/** The recover path: repair the text, then salvage the graph. */
export function parseComposition(output: string): ParsedComposition {
  const repaired = repairModelJson(output);
  try {
    const result = salvageComposition(repaired.value);
    return { composition: result.composition, warnings: [...repaired.warnings, ...result.warnings] };
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join('.') || 'composition'}: ${issue.message}`).join('\n')
      : error instanceof Error ? error.message : 'Unknown validation error';
    throw new Error(`The model returned an invalid catalog composition.\n${detail}`);
  }
}

const strictSchema = z.object({
  root: identifier,
  components: z.array(z.object({
    id: identifier,
    component: z.enum(componentNames),
    children: z.array(identifier).max(CHILDREN_LIMIT).optional(),
    // A2UI's DynamicString: a literal string or a { path } binding.
    value: z.union([z.string().max(TEXT_LIMIT), z.object({ path: z.string().startsWith('/').refine(isSafeJsonPointer, 'unsafe JSON Pointer path') }).strict()]).optional(),
    action: z.object({ event: actionSchema }).strict().optional(),
  }).passthrough()).min(1).max(COMPONENT_LIMIT),
}).strict();

/**
 * The guardrails-off path: markdown fences are stripped (presentation, not
 * semantics), then the output must survive plain JSON.parse and the strict
 * transport schema with no repair, coercion, or restructuring. What renders is
 * exactly what the model serialized; what fails shows exactly why.
 */
export function parseCompositionStrict(output: string): ParsedComposition {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!cleaned) throw new Error('Strict mode: the model returned an empty response.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Strict mode: the model output is not valid JSON (no repair applied).\n${error instanceof Error ? error.message : 'Unknown parse error'}`);
  }
  const result = strictSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || 'composition'}: ${issue.message}`).join('\n');
    throw new Error(`Strict mode: the A2UI component shape failed validation (no coercion applied).\n${detail}`);
  }
  // Normalize into the internal working shape without interpreting anything.
  const nodes: CatalogNode[] = result.data.components.map(({ id, component, children, value, action, ...props }) => {
    const binding = typeof value === 'object' ? value : undefined;
    if (value !== undefined && !binding) props.value = value;
    return {
      id,
      component,
      ...(Object.keys(props).length ? { props } : {}),
      ...(children ? { children } : {}),
      ...(binding ? { bind: binding.path } : {}),
      ...(action ? { action: action.event } : {}),
    };
  });
  return { composition: { root: result.data.root, nodes }, warnings: [] };
}
