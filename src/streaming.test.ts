import { describe, expect, it } from 'vitest';
import { createStreamingComposer } from './streaming';

describe('createStreamingComposer', () => {
  it('reveals nodes append-only as the JSON buffer grows', () => {
    const composer = createStreamingComposer();

    const first = composer.update('{"root":"root","nodes":[{"id":"root","component":"Page","children":["title"]},{"id":"title","component":"Heading","props":{"text":"Par');
    expect(first.added.map((node) => node.id)).toEqual(['root', 'title']);
    expect(first.surface.root).toBe('root');
    expect(first.surface.nodes.get('title')?.props.text).toBe('Par');

    const second = composer.update('{"root":"root","nodes":[{"id":"root","component":"Page","children":["title"]},{"id":"title","component":"Heading","props":{"text":"Partial heading"}},{"id":"badge","component":"StatusBadge","props":{"label":"Live"');
    expect(second.added.map((node) => node.id)).toEqual(['badge']);
    expect(second.surface.nodes.get('title')?.props.text).toBe('Partial heading');
    expect(second.surface.order).toEqual(['root', 'title', 'badge']);
  });

  it('never removes an already rendered node even if a later parse omits it', () => {
    const composer = createStreamingComposer();
    composer.update('{"root":"root","nodes":[{"id":"root","component":"Page","children":["a"]},{"id":"a","component":"Text","props":{"text":"First"}}]}');

    const update = composer.update('{"root":"root","nodes":[{"id":"root","component":"Page","children":["a"]}]}');
    expect(update.surface.nodes.has('a')).toBe(true);
  });

  it('freezes the root once resolved and keeps child order grow-only', () => {
    const composer = createStreamingComposer();
    composer.update('{"root":"page","nodes":[{"id":"page","component":"Page","children":["a"]}]}');
    const first = composer.surface();
    expect(first.root).toBe('page');

    const update = composer.update('{"root":"different","nodes":[{"id":"page","component":"Page","children":["a","b"]},{"id":"different","component":"Page","children":[]}]}');
    expect(update.surface.root).toBe('page');
    expect(update.surface.nodes.get('page')?.children).toEqual(['a', 'b']);
  });

  it('ignores unparseable buffers and nodes without usable identity', () => {
    const composer = createStreamingComposer();
    expect(composer.update('The model is thinking about').surface.nodes.size).toBe(0);
    expect(composer.update('{"root":"r","nodes":[{"component":"Text","props":{"text":"no id"}}]}').surface.nodes.size).toBe(0);
    expect(composer.update('{"root":"r","nodes":[{"id":"x","component":"Hologram"}]}').surface.nodes.size).toBe(0);
  });

  it('enforces single parenthood mid-stream so a double-referenced node renders once', () => {
    // Real flagged pattern: root and a Stack both list the same card. The
    // Stack keeps it — the root yields to a more specific container, so the
    // live preview settles into the same tree the final salvage produces.
    const composer = createStreamingComposer();
    const { surface } = composer.update('{"root":"root","nodes":[{"id":"root","component":"Page","children":["heading1","stack1","card1"]},{"id":"heading1","component":"Heading","props":{"text":"Gerald"}},{"id":"stack1","component":"Stack","children":["metric1","card1"]},{"id":"metric1","component":"Metric","props":{"label":"Watering","value":"Overdue"}},{"id":"card1","component":"Card","children":["note1"]},{"id":"note1","component":"Text","props":{"text":"Moody"}}]}');

    expect(surface.nodes.get('root')?.children).toEqual(['heading1', 'stack1']);
    expect(surface.nodes.get('stack1')?.children).toEqual(['metric1', 'card1']);
    const refCounts = new Map<string, number>();
    for (const node of surface.nodes.values()) {
      for (const child of node.children) refCounts.set(child, (refCounts.get(child) ?? 0) + 1);
    }
    expect([...refCounts.values()].every((count) => count === 1)).toBe(true);
  });

  it('applies the same coercion vocabulary as final validation', () => {
    const composer = createStreamingComposer();
    const { surface } = composer.update('{"root":"p","nodes":[{"id":"p","component":"page","accent":"purple","children":["t"]},{"id":"t","component":"Title","text":"Coerced"}]}');

    expect(surface.nodes.get('p')?.component).toBe('Page');
    expect(surface.nodes.get('p')?.props.accent).toBe('violet');
    expect(surface.nodes.get('t')?.component).toBe('Heading');
    expect(surface.nodes.get('t')?.props.text).toBe('Coerced');
  });
});
