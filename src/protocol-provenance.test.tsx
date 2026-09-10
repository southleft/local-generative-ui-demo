import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { A2uiMessageSchema } from '@a2ui/web_core/v0_9';
import { A2UI_PROTOCOL_VERSION, buildA2uiMessages, compileToA2ui, processA2uiMessages } from './a2ui-protocol';
import { a2uiCatalog, componentNames } from './catalog';
import { buildCompositionPrompt } from './prompt';
import { parseComposition } from './salvage';
import { getA2uiSample } from './sample-messages';

/**
 * Provenance guards for the prototype's central claim: a browser-local model
 * speaks A2UI v0.9 component syntax, and the official published runtime —
 * @a2ui/web_core + @a2ui/react — does the interpreting and rendering. These
 * fail if the path is ever quietly reduced to a facade, if the model's output
 * shape drifts away from A2UI's own binding/action shapes, if compiled output
 * drifts from the official message schema, or if the runtime catalog and the
 * model-facing prompt stop agreeing.
 */

/**
 * What the local model actually emits: A2UI v0.9 component syntax. Props sit
 * alongside `id` and `component`, bindings are `value: { path }`, actions are
 * `action: { event: { name } }`. No `props` envelope, no bespoke `bind` string.
 */
const modelOutput = JSON.stringify({
  root: 'root',
  components: [
    { id: 'root', component: 'Page', accent: 'teal', children: ['title', 'field', 'go'] },
    { id: 'title', component: 'Heading', text: 'Provenance check', level: 'h1' },
    { id: 'field', component: 'TextField', label: 'Name', value: { path: '/form/name' } },
    { id: 'go', component: 'Button', label: 'Submit', tone: 'primary', action: { event: { name: 'submitForm' } } },
  ],
});

describe('deterministic fixtures match the generation path', () => {

  it('keeps the A2UI fixture editable through the official binder', () => {
    const messages = getA2uiSample('audit');
    expect(() => processA2uiMessages(messages)).not.toThrow();
    const handle = processA2uiMessages(messages);

    render(<A2uiSurface surface={handle.surface} />);
    const input = screen.getByLabelText('Work email') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'someone@example.com' } });
    expect((screen.getByLabelText('Work email') as HTMLInputElement).value).toBe('someone@example.com');
  });
});

describe('A2UI provenance: the official v0.9 packages do the work', () => {
  it('declares the shared design system as a real A2UI catalog', () => {
    // A library Catalog instance, keyed by our catalog id, holding all 18 components.
    expect(a2uiCatalog.id).toContain('local-generative-ui');
    expect(a2uiCatalog.components.size).toBe(18);
    for (const name of ['Page', 'Stack', 'Grid', 'Heading', 'ChatBubble', 'ProgressBar', 'TextArea', 'Button']) {
      expect(a2uiCatalog.components.has(name), `${name} missing from the A2UI catalog`).toBe(true);
    }
  });

  it('compiles the graph into an official multi-message v0.9 stream and renders it', () => {
    const { composition } = parseComposition(modelOutput);
    const messages = compileToA2ui(composition);

    expect(messages.every((message) => (message as { version: string }).version === A2UI_PROTOCOL_VERSION)).toBe(true);
    expect(messages.map((message) => Object.keys(message).filter((key) => key !== 'version')[0]))
      .toEqual(['createSurface', 'updateComponents', 'updateDataModel']);
    expect(() => processA2uiMessages(messages)).not.toThrow();

    const handle = processA2uiMessages(messages);
    expect(handle.componentCount).toBe(composition.nodes.length);

    render(<A2uiSurface surface={handle.surface} />);
    expect(screen.getByText('Provenance check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('carries the model\'s own A2UI binding and action shapes through to the surface', () => {
    // The value the model wrote is A2UI's, not ours: `value: { path }` must
    // arrive as a live two-way binding and `action: { event: { name } }` as a
    // dispatchable callback, without a translation step inventing either.
    const { composition, warnings } = parseComposition(modelOutput);
    expect(warnings).toEqual([]);
    const messages = compileToA2ui(composition);
    const update = messages.find((message) => 'updateComponents' in message) as
      { updateComponents: { components: Array<Record<string, unknown>> } };
    const field = update.updateComponents.components.find((component) => component.id === 'field');
    expect(field).toMatchObject({ component: 'TextField', label: 'Name', value: { path: '/form/name' } });
    const button = update.updateComponents.components.find((component) => component.id === 'go');
    expect(button).toMatchObject({ component: 'Button', action: { event: { name: 'submitForm' } } });

    const actions: string[] = [];
    const handle = processA2uiMessages(messages, (event) => actions.push(event.name));
    render(<A2uiSurface surface={handle.surface} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    return vi.waitFor(() => expect(actions).toContain('submitForm'));
  });

  it('emits messages that satisfy the library\'s own A2uiMessageSchema', () => {
    const { composition } = parseComposition(modelOutput);
    for (const message of [...compileToA2ui(composition), ...getA2uiSample('audit')]) {
      const kind = Object.keys(message).filter((key) => key !== 'version')[0];
      expect((A2uiMessageSchema as { safeParse: (value: unknown) => { success: boolean } }).safeParse(message).success, `${kind} must satisfy A2uiMessageSchema`).toBe(true);
    }
  });

  it('keeps the catalog and the model-facing prompt guide in lockstep', () => {
    // A2UI's premise is that the catalog IS the model's vocabulary. Two sources
    // of truth (the runtime catalog and the hand-tuned prompt table) must not
    // drift, or the model is told about components that do not exist.
    const guide = buildCompositionPrompt('A patient intake form.');
    for (const name of a2uiCatalog.components.keys()) {
      expect(guide, `${name} is in the A2UI catalog but missing from the prompt guide`).toContain(name);
    }
    expect(a2uiCatalog.components.size).toBe(componentNames.length);
    for (const name of componentNames) {
      expect(a2uiCatalog.components.has(name), `${name} is offered to the model but absent from the A2UI catalog`).toBe(true);
    }
  });

  it('gives every catalog component a description, since the schema is its documentation', () => {
    for (const [name, api] of a2uiCatalog.components) {
      const description = (api as { schema?: { description?: string } }).schema?.description;
      expect(description, `${name} has no schema description`).toBeTruthy();
      expect((description ?? '').length, `${name} description is too terse`).toBeGreaterThan(12);
    }
  });

  it('documents the real division of labor: the library enforces catalog identity, salvage rejects hallucinated components', () => {
    // The official processor refuses a surface whose catalog it does not know.
    expect(() => processA2uiMessages([
      { version: A2UI_PROTOCOL_VERSION, createSurface: { surfaceId: 's', catalogId: 'no-such-catalog' } },
    ])).toThrow();

    // It is, however, lenient about unknown component names — it stores them and
    // fails at render. Keeping hallucinated components out is the salvage
    // layer's job, upstream of the protocol.
    expect(() => processA2uiMessages([
      { version: A2UI_PROTOCOL_VERSION, createSurface: { surfaceId: 's', catalogId: a2uiCatalog.id } },
      { version: A2UI_PROTOCOL_VERSION, updateComponents: { surfaceId: 's', components: [{ id: 'root', component: 'HoloDeck' }] } },
    ])).not.toThrow();

    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['ghost', 'copy'] },
        { id: 'ghost', component: 'HoloDeck', props: {} },
        { id: 'copy', component: 'Text', props: { text: 'Survives' } },
      ],
    }));
    expect(composition.nodes.map((node) => node.component)).not.toContain('HoloDeck');
    expect(warnings.join(' ')).toMatch(/HoloDeck/);
  });

  it('expands a data-driven child template through the library binder, like the built-in catalog', () => {
    // The model is never asked for templates, but the catalog schemas accept
    // A2UI's ChildListSchema, so a template must render rather than vanish.
    const messages = buildA2uiMessages('template.test', [
      { id: 'root', component: 'Page', children: ['list'] },
      { id: 'list', component: 'Stack', children: { componentId: 'row', path: '/items' } },
      { id: 'row', component: 'Text', text: 'Row' },
    ], { items: ['a', 'b', 'c'] });
    const handle = processA2uiMessages(messages);
    render(<A2uiSurface surface={handle.surface} />);
    expect(screen.getAllByText('Row')).toHaveLength(3);
  });
});
