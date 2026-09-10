/**
 * A2UI v0.9 transport on the official packages. `@a2ui/web_core`'s
 * MessageProcessor owns surface state, data-model updates, and action
 * dispatch; `@a2ui/react`'s renderer walks the resulting surface model. This
 * module only builds the message envelopes and hands them over.
 *
 * v0.9 is deliberately multi-message: `createSurface` carries the surface and
 * catalog identity, components and data arrive as separate `updateComponents`
 * and `updateDataModel` messages, so every generation exercises three of the
 * protocol's four message types.
 */

import { MessageProcessor, type A2uiClientAction, type A2uiMessage, type SurfaceModel } from '@a2ui/web_core/v0_9';
import type { ReactComponentImplementation } from '@a2ui/react/v0_9';
import { A2UI_CATALOG_ID, a2uiCatalog } from './catalog';
import { decodeJsonPointer } from './json-pointer';
import type { CatalogComposition } from './salvage';

export type { A2uiMessage };
export const A2UI_PROTOCOL_VERSION = 'v0.9' as const;

/** One flat A2UI component: props sit alongside `id` and `component`. */
export interface A2uiComponentNode extends Record<string, unknown> {
  id: string;
  component: string;
}

/** The surface model `A2uiSurface` renders. */
export type A2uiSurface = SurfaceModel<ReactComponentImplementation>;

export interface A2uiActionEvent {
  name: string;
  surfaceId: string;
  context?: Record<string, unknown>;
}

export interface A2uiSurfaceHandle {
  surfaceId: string;
  surface: A2uiSurface;
  componentCount: number;
}

/** Build the canonical v0.9 message sequence for one surface. */
export function buildA2uiMessages(surfaceId: string, components: A2uiComponentNode[], dataModel: Record<string, unknown>): A2uiMessage[] {
  const messages: A2uiMessage[] = [
    { version: A2UI_PROTOCOL_VERSION, createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID } },
    { version: A2UI_PROTOCOL_VERSION, updateComponents: { surfaceId, components } },
  ];
  if (Object.keys(dataModel).length) messages.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, value: dataModel } });
  return messages;
}

/**
 * Feed messages to the official processor and return the resulting surface.
 * Library errors (unknown catalog, malformed message) propagate so the
 * workbench can display them like any other validation error.
 */
export function processA2uiMessages(messages: A2uiMessage[], onAction?: (event: A2uiActionEvent) => void): A2uiSurfaceHandle {
  const processor = new MessageProcessor<ReactComponentImplementation>([a2uiCatalog]);
  processor.processMessages(messages);
  const entry = [...processor.model.surfacesMap].at(-1);
  if (!entry) throw new Error('The A2UI message stream did not create a surface.');
  const [surfaceId, surface] = entry;
  // Actions surface through the model's own event source, so the host observes exactly what the library dispatches.
  if (onAction) {
    surface.onAction.subscribe((action: A2uiClientAction) => onAction({ name: action.name, surfaceId: action.surfaceId, context: action.context }));
  }
  const componentCount = [...surface.componentsModel.entries].length;
  if (!componentCount) throw new Error('The A2UI surface has no components.');
  return { surfaceId, surface, componentCount };
}

function seedBinding(state: Record<string, unknown>, path: string): void {
  const segments = decodeJsonPointer(path).filter(Boolean);
  if (!segments.length) return;
  let target = state;
  for (const segment of segments.slice(0, -1)) {
    if (!target[segment] || typeof target[segment] !== 'object' || Array.isArray(target[segment])) target[segment] = {};
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1)!] ??= '';
}

function assertTransportIntegrity(composition: CatalogComposition): void {
  const ids = new Set<string>();
  const reserved = new Set(['id', 'component', 'children', 'bind', 'action']);
  for (const node of composition.nodes) {
    if (ids.has(node.id)) throw new Error(`The catalog composition contains duplicate node ID "${node.id}".`);
    ids.add(node.id);
    for (const prop of Object.keys(node.props ?? {})) {
      if (reserved.has(prop)) throw new Error(`Node "${node.id}" puts reserved transport field "${prop}" inside props.`);
    }
  }
  if (!ids.has(composition.root)) throw new Error(`The declared root "${composition.root}" does not exist.`);
  if (composition.root !== 'root' && ids.has('root')) throw new Error('Node ID "root" is reserved when a different root is declared.');
}

/**
 * Compile the neutral graph into an official A2UI v0.9 message sequence:
 * createSurface, then updateComponents, then updateDataModel when the surface
 * binds any state. Nodes are already flat, which is exactly the v0.9 shape.
 */
export function compileToA2ui(composition: CatalogComposition): A2uiMessage[] {
  assertTransportIntegrity(composition);
  const toA2uiId = (id: string) => id === composition.root ? 'root' : id;
  const components: A2uiComponentNode[] = composition.nodes.map((node) => ({
    ...node.props,
    id: toA2uiId(node.id),
    component: node.component,
    ...(node.children ? { children: node.children.map(toA2uiId) } : {}),
    ...(node.bind ? { value: { path: node.bind } } : {}),
    ...(node.action ? { action: { event: { name: node.action.name, context: node.action.context } } } : {}),
  }));
  const dataModel: Record<string, unknown> = {};
  for (const node of composition.nodes) if (node.bind) seedBinding(dataModel, node.bind);
  return buildA2uiMessages('generated.a2ui', components, dataModel);
}
