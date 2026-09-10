/**
 * Inert live preview for partially streamed catalog compositions before the
 * official A2UI surface has passed validation.
 */

import { Fragment, memo, type ReactNode } from 'react';
import { renderComponent } from './catalog';
import { Page, Stack, type PageAccent } from './design-system';
import type { StreamingSurface } from './streaming';

export const StreamingSurfacePreview = memo(function StreamingSurfacePreview({ surface }: { surface: StreamingSurface }) {
  const renderNode = (id: string, ancestors: ReadonlySet<string>): ReactNode => {
    const node = surface.nodes.get(id);
    if (!node || ancestors.has(id)) return null;
    const lineage = new Set(ancestors).add(id);
    const children = node.children.map((child) => <Fragment key={child}>{renderNode(child, lineage)}</Fragment>);
    return <Fragment key={id}>{renderComponent(node.component, node.props, children)}</Fragment>;
  };

  const referenced = new Set([...surface.nodes.values()].flatMap((node) => node.children));
  const forest = surface.order.filter((id) => id === surface.root || !referenced.has(id));
  const ordered = surface.root ? [surface.root, ...forest.filter((id) => id !== surface.root)] : forest;
  if (!ordered.length) return null;
  const rootNode = surface.root ? surface.nodes.get(surface.root) : undefined;
  if (ordered.length === 1 && rootNode?.component === 'Page') return <div className="streaming-surface">{renderNode(ordered[0], new Set())}</div>;
  return (
    <div className="streaming-surface">
      <Page accent={rootNode?.props.accent as PageAccent | undefined}>
        <Stack gap="lg">{ordered.map((id) => renderNode(id, new Set()))}</Stack>
      </Page>
    </div>
  );
});
