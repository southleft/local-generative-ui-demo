/**
 * Incremental composer for the live preview. It re-reads the growing model
 * output on a throttle and reconciles append-only: node identity is the
 * model-declared ID, a node that has rendered is never removed, the root is
 * frozen once resolved, and prop updates happen in place so React never
 * remounts a subtree mid-stream. Strict validation still happens after the
 * stream completes; this layer only decides what is stable enough to show.
 */

import { COMPONENT_LIMIT, coerceComponentName, coerceProps, isRecord, isReservedNodeKey, layoutComponents, type ComponentName } from './catalog';
import { repairModelJson } from './repair';

export interface StreamingNode {
  id: string;
  component: ComponentName;
  props: Record<string, unknown>;
  children: string[];
}

export interface StreamingSurface {
  root: string | null;
  nodes: ReadonlyMap<string, StreamingNode>;
  /** Node IDs in arrival order. */
  order: readonly string[];
}

export interface StreamingUpdate {
  surface: StreamingSurface;
  /** Nodes that appeared for the first time in this update. */
  added: StreamingNode[];
}

function tryParsePartial(buffer: string): Record<string, unknown> | undefined {
  try {
    const { value } = repairModelJson(buffer);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createStreamingComposer() {
  const nodes = new Map<string, StreamingNode>();
  const order: string[] = [];
  // Single parenthood, mirroring the final salvage: the first parent whose
  // children array mentions an id (in stream order) claims it, except that the
  // root yields to any more specific container; later references are dropped
  // so nothing renders twice mid-stream.
  const claimedBy = new Map<string, string>();
  let root: string | null = null;

  const surface = (): StreamingSurface => ({ root, nodes, order });

  return {
    update(buffer: string): StreamingUpdate {
      const added: StreamingNode[] = [];
      const parsed = tryParsePartial(buffer);
      if (!parsed) return { surface: surface(), added };

      const rawNodes = Array.isArray(parsed.components) ? parsed.components : Array.isArray(parsed.nodes) ? parsed.nodes : [];
      const declaredRoot = typeof parsed.root === 'string' ? parsed.root : root;
      // A leaf that reuses an earlier container's id is a parent pointer (see
      // the final salvage); derive a stable id from its ordinal so re-parses
      // update the same node in place instead of remounting it.
      const collisionOrdinals = new Map<string, number>();
      const claimChild = (parentId: string, child: string): boolean => {
        if (child === parentId) return false;
        const claimer = claimedBy.get(child);
        if (claimer === undefined || claimer === parentId) {
          claimedBy.set(child, parentId);
          return true;
        }
        // The root yields to a more specific container: models list everything
        // flat under the root first and nest the real grouping a few nodes
        // later. Reparenting here keeps the live preview from settling into a
        // layout the final surface will not have.
        if (claimer === declaredRoot && parentId !== declaredRoot) {
          const previous = nodes.get(claimer);
          if (previous) previous.children = previous.children.filter((id) => id !== child);
          claimedBy.set(child, parentId);
          return true;
        }
        return false;
      };

      for (const raw of rawNodes.slice(0, COMPONENT_LIMIT)) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) continue;
        const component = coerceComponentName(raw.component ?? raw.type);
        if (!component) continue;
        let nodeId = raw.id;
        let rehomeInto: StreamingNode | undefined;
        const collided = nodes.get(raw.id);
        if (collided && collided.component !== component && layoutComponents.has(collided.component) && !layoutComponents.has(component)) {
          const ordinalKey = `${raw.id}-${component.toLowerCase()}`;
          const ordinal = (collisionOrdinals.get(ordinalKey) ?? 0) + 1;
          collisionOrdinals.set(ordinalKey, ordinal);
          nodeId = `${ordinalKey}${ordinal}`;
          rehomeInto = collided;
        }
        const strayProps = Object.fromEntries(Object.entries(raw).filter(([key]) => !isReservedNodeKey(key, component)));
        const props = coerceProps(component, { ...strayProps, ...(isRecord(raw.props) ? raw.props : {}) });
        // Component type names written as child references are annotations of
        // the child that follows by id (the final salvage ignores them too);
        // skip them unless a node with that exact id already exists.
        const children = Array.isArray(raw.children)
          ? raw.children.filter((child): child is string => typeof child === 'string' && (nodes.has(child) || !coerceComponentName(child)))
          : [];
        const existing = nodes.get(nodeId);
        if (existing) {
          // Update in place; children grow but never shrink so rendered
          // content cannot pop back out of the surface mid-stream.
          existing.props = props;
          for (const child of children) {
            if (claimChild(nodeId, child) && !existing.children.includes(child)) existing.children.push(child);
          }
          continue;
        }
        const node: StreamingNode = { id: nodeId, component, props, children: [] };
        nodes.set(nodeId, node);
        order.push(nodeId);
        added.push(node);
        for (const child of children) if (claimChild(nodeId, child)) node.children.push(child);
        if (rehomeInto && claimChild(rehomeInto.id, nodeId)) rehomeInto.children.push(nodeId);
      }

      if (!root) {
        const candidate = typeof parsed.root === 'string' ? parsed.root : undefined;
        if (candidate && nodes.has(candidate)) root = candidate;
        else {
          const referenced = new Set([...nodes.values()].flatMap((node) => node.children));
          const orphans = order.filter((id) => !referenced.has(id));
          if (orphans.length === 1 && layoutComponents.has(nodes.get(orphans[0])!.component)) root = orphans[0];
        }
      }
      return { surface: surface(), added };
    },
    surface,
  };
}

export type StreamingComposer = ReturnType<typeof createStreamingComposer>;
