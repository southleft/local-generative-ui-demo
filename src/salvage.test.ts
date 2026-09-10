import { describe, expect, it } from 'vitest';
import { compileToA2ui, processA2uiMessages } from './a2ui-protocol';
import { componentNames, layoutComponents, type ComponentName } from './catalog';
import { RESPONSE_CONSTRAINT, buildCompositionPrompt } from './prompt';
import { parseComposition, parseCompositionStrict } from './salvage';

const generatedMap = {
  root: 'root',
  nodes: [
    { id: 'root', component: 'Page', props: { accent: 'teal' }, children: ['layout'] },
    { id: 'layout', component: 'Stack', props: { gap: 'lg' }, children: ['heading', 'summary', 'progress', 'risk', 'form', 'actions'] },
    { id: 'heading', component: 'Heading', props: { text: 'Incident command', level: 'h1', icon: '🚨' } },
    { id: 'summary', component: 'Metric', props: { label: 'Affected regions', value: '3', detail: 'EU traffic', tone: 'critical' } },
    { id: 'progress', component: 'ProgressBar', props: { label: 'Mitigation rollout', percent: 40, tone: 'warning' } },
    { id: 'risk', component: 'Alert', props: { title: 'Customer impact', message: 'Checkout latency is elevated.', tone: 'warning' } },
    { id: 'form', component: 'Card', children: ['owner'] },
    { id: 'owner', component: 'TextField', props: { label: 'Incident owner', placeholder: 'Name' }, bind: '/incident/owner' },
    { id: 'actions', component: 'Inline', props: { align: 'center' }, children: ['escalate'] },
    { id: 'escalate', component: 'Button', props: { label: 'Escalate', tone: 'danger' }, action: { name: 'escalateIncident', context: { severity: 'high' } } },
  ],
};

describe('native A2UI component syntax', () => {
  it('parses exactly what the model emits: flat A2UI components, no bespoke format', () => {
    // This is the model's real output shape — A2UI v0.9 component syntax.
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      components: [
        { id: 'root', component: 'Page', accent: 'teal', children: ['t', 'f', 'b'] },
        { id: 't', component: 'Heading', text: 'Patient intake', level: 'h1' },
        { id: 'f', component: 'TextField', label: 'Full name', value: { path: '/form/name' } },
        { id: 'b', component: 'Button', label: 'Submit', action: { event: { name: 'submitIntake' } } },
      ],
    }));

    expect(warnings).toEqual([]);
    const byId = Object.fromEntries(composition.nodes.map((node) => [node.id, node]));
    expect(byId.t.props).toEqual({ text: 'Patient intake', level: 'h1' });
    expect(byId.f.bind).toBe('/form/name');
    expect(byId.b.action?.name).toBe('submitIntake');
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('still tolerates the older nested props / bind / bare-action drift', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      components: [
        { id: 'root', component: 'Page', children: ['f', 'b'] },
        { id: 'f', component: 'TextField', props: { label: 'Name' }, bind: '/form/name' },
        { id: 'b', component: 'Button', props: { label: 'Go' }, action: { name: 'go' } },
      ],
    }));
    const byId = Object.fromEntries(composition.nodes.map((node) => [node.id, node]));
    expect(byId.f.bind).toBe('/form/name');
    expect(byId.b.action?.name).toBe('go');
  });
});

describe('free-form catalog composition', () => {
  it('parses one model-selected graph and compiles it to validated A2UI', () => {
    const { composition, warnings } = parseComposition(JSON.stringify(generatedMap));
    const a2ui = compileToA2ui(composition);

    expect(warnings).toEqual([]);
    expect(() => processA2uiMessages(a2ui)).not.toThrow();
    // v0.9 is multi-message: identity, then components, then data.
    expect(a2ui.map((message) => Object.keys(message).filter((key) => key !== 'version')[0]))
      .toEqual(['createSurface', 'updateComponents', 'updateDataModel']);
    const components = (a2ui[1] as { updateComponents: { components: Array<Record<string, unknown>> } }).updateComponents.components;
    expect(components.map((component) => component.component)).toEqual([
      'Page', 'Stack', 'Heading', 'Metric', 'ProgressBar', 'Alert', 'Card', 'TextField', 'Inline', 'Button',
    ]);
    expect(components[0]).toMatchObject({ accent: 'teal' });
  });

  it('frames the request with creative latitude and the complete expressive catalog', () => {
    const prompt = buildCompositionPrompt('Design a conference speaker review workspace.');

    expect(prompt).toContain('Design a conference speaker review workspace.');
    expect(prompt).toContain('full creative control');
    expect(prompt).toContain('not everything is a dashboard');
    for (const component of ['Metric', 'TextField', 'Select', 'Grid', 'Tag', 'ProgressBar', 'Divider']) {
      expect(prompt).toContain(component);
    }
    expect(prompt).toContain('accent=indigo|violet|sky|teal|emerald|amber|rose|slate');
    expect(prompt).toContain('Aim for roughly 8–20 components');
    expect(prompt).toContain('components is one flat array');
    expect(prompt).not.toContain('optionATitle.text');
  });

  it('drops redundant structural rules when the runtime enforces the schema natively', () => {
    const constrained = buildCompositionPrompt('A tea timer.', { schemaEnforced: true });
    const unconstrained = buildCompositionPrompt('A tea timer.');

    expect(constrained).not.toContain('components is one flat array');
    expect(constrained.length).toBeLessThan(unconstrained.length);
    expect(constrained).toContain('value={"path":"/state/path"} only on TextField, TextArea, and Select');
  });

  it('defines a topology-neutral response constraint with the complete component allowlist', () => {
    expect(RESPONSE_CONSTRAINT).toMatchObject({
      type: 'object',
      required: ['root', 'components'],
      additionalProperties: false,
      properties: {
        root: { type: 'string' },
        components: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'component'],
            additionalProperties: true,
            properties: {
              component: {
                enum: ['Page', 'Stack', 'Inline', 'Grid', 'Card', 'Heading', 'Text', 'ChatBubble', 'Metric', 'StatusBadge', 'Tag', 'ProgressBar', 'Alert', 'Divider', 'TextField', 'TextArea', 'Select', 'Button'],
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(RESPONSE_CONSTRAINT)).not.toMatch(/dashboard|metricGrid|overdue/i);
  });

  it('repairs extra unmatched closing braces without changing the selected graph', () => {
    const malformed = '{"root":"root","nodes":[{"id":"root","component":"Page","children":["copy"]}},{"id":"copy","component":"Text","props":{"text":"Recovered"}}]}';

    const { composition } = parseComposition(malformed);
    expect(composition.nodes.map((node) => node.component)).toEqual(['Page', 'Text']);
    expect(composition.nodes[1].props).toEqual({ text: 'Recovered' });
  });

  it('flattens nested local-model children while preserving the selected topology', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: {
        component: 'Page',
        children: [{
          id: 'dashboard',
          component: 'Stack',
          props: { gap: 'lg' },
          children: [
            { id: 'title', component: 'Heading', props: { text: 'Account health', level: 'h1' } },
            { id: 'pay', component: 'Button', props: { label: 'Pay invoice', tone: 'primary', action: { name: 'payInvoice' } } },
          ],
        }],
      },
    }));

    expect(composition.root).toBe('root');
    expect(composition.nodes).toEqual([
      { id: 'root', component: 'Page', children: ['dashboard'] },
      { id: 'dashboard', component: 'Stack', props: { gap: 'lg' }, children: ['title', 'pay'] },
      { id: 'title', component: 'Heading', props: { text: 'Account health', level: 'h1' } },
      { id: 'pay', component: 'Button', props: { label: 'Pay invoice', tone: 'primary' }, action: { name: 'payInvoice' } },
    ]);
  });

  it('reconciles a missing declared root only when the graph has one unambiguous root', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'dashboard',
      nodes: [
        { id: 'page', component: 'Page', children: ['title'] },
        { id: 'title', component: 'Heading', props: { text: 'Account health', level: 'h1' } },
      ],
    }));

    expect(composition.root).toBe('page');
  });

  it('preserves disconnected subtrees inside a spaced synthetic layout', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'accountDashboard',
      nodes: [
        { id: 'header', component: 'Stack', children: ['title'] },
        { id: 'title', component: 'Heading', props: { text: 'Account health', level: 'h1' } },
        { id: 'overview', component: 'Card', children: ['status'] },
        { id: 'status', component: 'StatusBadge', props: { label: 'Attention', tone: 'warning' } },
        { id: 'actions', component: 'Inline', children: ['pay'] },
        { id: 'pay', component: 'Button', props: { label: 'Pay invoice' }, action: { name: 'payInvoice' } },
      ],
    }));

    expect(composition.root).toBe('accountDashboard');
    expect(composition.nodes.find((node) => node.id === 'accountDashboard')).toMatchObject({ component: 'Page' });
    expect(composition.nodes.find((node) => node.id === 'accountDashboardLayout')).toMatchObject({
      component: 'Stack',
      children: ['header', 'overview', 'actions'],
    });
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('refuses a composition whose only nodes are an unreachable layout cycle', () => {
    expect(() => parseComposition(JSON.stringify({
      root: 'missingRoot',
      nodes: [
        { id: 'one', component: 'Stack', children: ['two'] },
        { id: 'two', component: 'Stack', children: ['one'] },
      ],
    }))).toThrow(/no usable root|no visible content/i);
  });

  it('uses the catalog neutral default when the model omits an Alert tone', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'dashboard',
      nodes: [
        { id: 'dashboard', component: 'Page', children: ['overdueInvoice'] },
        { id: 'overdueInvoice', component: 'Alert', props: { title: 'Overdue invoice', message: 'Payment is late.' } },
      ],
    }));

    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('canonicalizes snake-case actions and ignores empty children on leaf nodes', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'account-dashboard',
      nodes: [
        { id: 'account-dashboard', component: 'Page', children: ['title', 'pay-invoice-button'] },
        { id: 'title', component: 'Heading', props: { text: 'Account Dashboard' }, children: [] },
        {
          id: 'pay-invoice-button',
          component: 'Button',
          props: { label: 'Pay Invoice', tone: 'primary' },
          action: { name: 'pay_invoice', context: {} },
        },
      ],
    }));

    const title = composition.nodes.find((node) => node.id === 'title');
    expect(title).not.toHaveProperty('children');
    expect(composition.nodes.find((node) => node.id === 'pay-invoice-button')?.action?.name).toBe('payInvoice');
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('drops hallucinated components with a visible warning instead of failing the surface', () => {
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['chart', 'copy'] },
        { id: 'chart', component: 'FancyChart3D', props: { data: [1, 2, 3] } },
        { id: 'copy', component: 'Text', props: { text: 'Still renders' } },
      ],
    }));

    expect(composition.nodes.map((node) => node.id)).toEqual(['root', 'copy']);
    expect(warnings.join(' ')).toMatch(/FancyChart3D/);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('rejects output where nothing in the catalog can be recovered', () => {
    expect(() => parseComposition(JSON.stringify({
      root: 'root',
      nodes: [{ id: 'root', component: 'Chart', props: { data: [1, 2, 3] } }],
    }))).toThrow(/no usable root|no visible content|failed catalog validation|could be recovered/i);
  });

  it('interprets common component synonyms and stray top-level props', () => {
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'page', children: ['title', 'blurb'] },
        { id: 'title', component: 'Title', text: 'Coerced heading' },
        { id: 'blurb', component: 'Paragraph', props: { content: 'Body copy arrives intact.' } },
      ],
    }));

    expect(composition.nodes.map((node) => node.component)).toEqual(['Page', 'Heading', 'Text']);
    expect(composition.nodes[1].props).toMatchObject({ text: 'Coerced heading' });
    expect(composition.nodes[2].props).toMatchObject({ text: 'Body copy arrives intact.' });
    expect(warnings.some((warning) => /Interpreted component/.test(warning))).toBe(true);
  });

  it('coerces tones, percents, columns, and accents into the catalog vocabulary', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', props: { accent: 'purple' }, children: ['grid'] },
        { id: 'grid', component: 'Grid', props: { columns: '3' }, children: ['errors', 'rollout', 'deploys'] },
        { id: 'errors', component: 'Metric', props: { label: 'Errors', value: '12', tone: 'error' } },
        { id: 'rollout', component: 'ProgressBar', props: { label: 'Rollout', percent: '75%' } },
        { id: 'deploys', component: 'ProgressBar', props: { label: 'Deploys', percent: 0.4 } },
      ],
    }));

    const byId = Object.fromEntries(composition.nodes.map((node) => [node.id, node]));
    expect(byId.root.props).toMatchObject({ accent: 'violet' });
    expect(byId.grid.props).toMatchObject({ columns: 3 });
    expect(byId.errors.props).toMatchObject({ tone: 'critical' });
    expect(byId.rollout.props).toMatchObject({ percent: 75 });
    expect(byId.deploys.props).toMatchObject({ percent: 40 });
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('recovers a leaf Button that wrongly declares children instead of dropping it', () => {
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['go'] },
        { id: 'go', component: 'Button', props: { label: 'Go' }, action: { name: 'go' }, children: ['mystery'] },
      ],
    }));

    const go = composition.nodes.find((node) => node.id === 'go');
    expect(go).toBeDefined();
    expect(go).not.toHaveProperty('children');
    expect(warnings.join(' ')).toMatch(/recovered button "go"/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('keeps a ProgressBar whose label is missing', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['bar'] },
        { id: 'bar', component: 'ProgressBar', props: { percent: 55 } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'bar')?.props).toMatchObject({ label: '', percent: 55 });
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('synthesizes a semantic action for a Button the model left without one', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['save'] },
        { id: 'save', component: 'Button', props: { label: 'Save draft now' } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'save')?.action).toEqual({ name: 'saveDraftNow' });
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('aggregates repetition noise instead of logging one warning per duplicate', () => {
    const nodes: Array<Record<string, unknown>> = [
      { id: 'root', component: 'Page', children: ['a'] },
      { id: 'a', component: 'Text', props: { text: 'once' } },
    ];
    for (let index = 0; index < 10; index += 1) {
      nodes.push({ id: 'a', component: 'Text', props: { text: 'again' } });
      nodes.push({ id: `hallucination${index}`, component: 'Chart', props: {} });
    }

    const { warnings } = parseComposition(JSON.stringify({ root: 'root', nodes }));

    // The first "again" differs from "once" and is kept under a renamed id;
    // the nine identical repeats after it are the greedy loop and drop.
    expect(warnings.length).toBeLessThan(7);
    expect(warnings.join(' ')).toMatch(/duplicate node ID/i);
    expect(warnings.join(' ')).toMatch(/×9|9 duplicate/i);
    expect(warnings.join(' ')).toMatch(/Renamed 1 component that reused the id "a"/);
  });

  it('enforces single parenthood when the model lists a node under two parents', () => {
    // Real flagged run ("Gerald's Current Vibe"): root and stack1 both listed
    // card1/alert1/button1, so each rendered twice. The Stack wins them: the
    // root's listing is the flat catch-all, the Stack is the real grouping.
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['heading1', 'stack1', 'card1', 'alert1', 'button1'] },
        { id: 'heading1', component: 'Heading', props: { text: "Gerald's Dramatic Mood Tracker" } },
        { id: 'stack1', component: 'Stack', children: ['metric1', 'card1', 'alert1', 'button1'] },
        { id: 'metric1', component: 'Metric', props: { label: 'Watering Status', value: 'Overdue' } },
        { id: 'card1', component: 'Card', children: ['heading2'] },
        { id: 'heading2', component: 'Heading', props: { text: "Gerald's Current Vibe" } },
        { id: 'alert1', component: 'Alert', props: { title: 'Urgent Attention Required', message: 'Gerald is wilting dramatically.' } },
        { id: 'button1', component: 'Button', props: { label: 'View Full Log' }, action: { name: 'viewFullLog' } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'root')?.children).toEqual(['heading1', 'stack1']);
    expect(composition.nodes.find((node) => node.id === 'stack1')?.children).toEqual(['metric1', 'card1', 'alert1', 'button1']);
    expect(warnings.join(' ')).toMatch(/duplicate parent reference/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('keeps the model\'s own container when the root also claims its children', () => {
    // Real bike-shop run: formRoot listed the three fields flat AND intakeCard
    // claimed the same three. Letting the root win emptied the Card, and the
    // empty-container sweep then deleted it, so the fields rendered loose on
    // the page instead of inside the card the model actually composed.
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'formRoot',
      components: [
        { id: 'formRoot', component: 'Page', children: ['heading1', 'intakeCard', 'bikeModelField', 'problemDescription', 'requestButton'] },
        { id: 'heading1', component: 'Heading', text: 'Service Intake Form', level: 'h1' },
        { id: 'intakeCard', component: 'Card', children: ['bikeModelField', 'problemDescription'] },
        { id: 'bikeModelField', component: 'TextField', label: 'Bike Model', value: { path: '/state/bikeModel' } },
        { id: 'problemDescription', component: 'TextArea', label: 'Describe the Issue', value: { path: '/state/problem' } },
        { id: 'requestButton', component: 'Button', label: 'Request Service', action: { event: { name: 'submitIntakeForm' } } },
      ],
    }));

    const card = composition.nodes.find((node) => node.id === 'intakeCard');
    expect(card?.children).toEqual(['bikeModelField', 'problemDescription']);
    expect(composition.nodes.find((node) => node.id === 'formRoot')?.children).toEqual(['heading1', 'intakeCard', 'requestButton']);
    expect(warnings.join(' ')).not.toMatch(/empty layout container/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('drops a repeated reference inside a single children array', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['a', 'a', 'b'] },
        { id: 'a', component: 'Text', props: { text: 'Render me once' } },
        { id: 'b', component: 'Text', props: { text: 'And me after' } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'root')?.children).toEqual(['a', 'b']);
  });

  it('removes semantic duplicates: repeated fields and identical buttons keep the first occurrence', () => {
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['card'] },
        { id: 'card', component: 'Card', children: ['name1', 'name2', 'submit1', 'submit2', 'cancel'] },
        { id: 'name1', component: 'TextField', props: { label: 'Full Name' }, bind: '/form/name' },
        { id: 'name2', component: 'TextField', props: { label: 'Full Name' }, bind: '/form/name2' },
        { id: 'submit1', component: 'Button', props: { label: 'Submit' }, action: { name: 'submitForm' } },
        { id: 'submit2', component: 'Button', props: { label: 'Submit' }, action: { name: 'submitForm' } },
        { id: 'cancel', component: 'Button', props: { label: 'Submit' }, action: { name: 'cancelForm' } },
      ],
    }));

    const ids = composition.nodes.map((node) => node.id);
    expect(ids).toContain('name1');
    expect(ids).not.toContain('name2');
    expect(ids).toContain('submit1');
    expect(ids).not.toContain('submit2');
    // Same label but a different action is not a duplicate.
    expect(ids).toContain('cancel');
    expect(warnings.join(' ')).toMatch(/repeating identical content/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('keeps legitimate short repeats: tags, badges, and dividers are exempt from dedup', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['a', 'b', 'd1', 'd2'] },
        { id: 'a', component: 'Tag', props: { label: 'On Track' } },
        { id: 'b', component: 'Tag', props: { label: 'On Track' } },
        { id: 'd1', component: 'Divider' },
        { id: 'd2', component: 'Divider' },
      ],
    }));

    expect(composition.nodes.filter((node) => node.component === 'Tag')).toHaveLength(2);
    expect(composition.nodes.filter((node) => node.component === 'Divider')).toHaveLength(2);
  });

  it('drops an identical duplicate ID but keeps a same-id leaf with different content under a new id', () => {
    const identical = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['copy'] },
        { id: 'copy', component: 'Text', props: { text: 'First' } },
        { id: 'copy', component: 'Text', props: { text: 'First' } },
      ],
    }));
    expect(identical.composition.nodes).toHaveLength(2);
    expect(identical.warnings.join(' ')).toMatch(/duplicate node ID "copy"/i);

    const distinct = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['copy'] },
        { id: 'copy', component: 'Text', props: { text: 'First' } },
        { id: 'copy', component: 'Text', props: { text: 'Second' } },
      ],
    }));
    expect(distinct.composition.nodes.map((node) => node.id)).toEqual(['root', 'copy', 'copy-2']);
    expect(distinct.composition.nodes[2].props).toMatchObject({ text: 'Second' });
    expect(distinct.composition.nodes[0].children).toEqual(['copy', 'copy-2']);
    expect(distinct.warnings.join(' ')).toMatch(/Renamed 1 component that reused the id "copy"/);
  });

  it('strips unsafe binding paths instead of failing the composition', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['field'] },
        { id: 'field', component: 'TextField', props: { label: 'Name' }, bind: '/__proto__/polluted' },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'field')).not.toHaveProperty('bind');
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('keeps action context scalar-only by dropping executable-looking nested values', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['go'] },
        { id: 'go', component: 'Button', props: { label: 'Go' }, action: { name: 'go', context: { payload: { code: 'run()' }, severity: 'high' } } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'go')?.action).toEqual({ name: 'go', context: { severity: 'high' } });
  });

  it('truncates emoji icons by grapheme cluster instead of rejecting them', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['party'] },
        { id: 'party', component: 'Tag', props: { label: 'Family plan', icon: '👨‍👩‍👧🎉🎊🎈' } },
      ],
    }));

    const icon = composition.nodes.find((node) => node.id === 'party')?.props?.icon as string;
    expect(icon.length).toBeLessThanOrEqual(16);
    expect(icon.startsWith('👨‍👩‍👧')).toBe(true);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('reconstructs inline child components declared inside a children array', () => {
    // Real Gemma med-form pattern: the model inlines a whole TextField into the
    // card's children array instead of emitting a separate node.
    const malformed = '{"root":"root","nodes":[{"id":"root","component":"Page","children":["card1"]},{"id":"card1","component":"Card","props":{"tone":"recommended"},"children":["TextField","label":"Full Name","placeholder":"Enter your complete name","bind":"/state/fullName"}]}';

    const { composition, warnings } = parseComposition(malformed);
    const card = composition.nodes.find((node) => node.id === 'card1');
    expect(card?.children).toHaveLength(1);
    const field = composition.nodes.find((node) => node.id === card!.children![0]);
    expect(field).toMatchObject({ component: 'TextField', props: { label: 'Full Name', placeholder: 'Enter your complete name' }, bind: '/state/fullName' });
    expect(warnings.join(' ')).toMatch(/reconstructed 1 inline child/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('keeps sibling ID references out of inline text when children mix refs and objects', () => {
    // Flagged heist run: headings rendered as "Crew Readiness Statusmetric_gear…"
    // because bare sibling IDs were glued onto the previous text value.
    const malformed = '{"root":"root","nodes":[{"id":"root","component":"Page","children":["card1","metric_gear","metric_morale"]},{"id":"card1","component":"Card","children":["h2":{"text":"Crew Readiness Status","icon":"✅"},"metric_gear","metric_morale"]},{"id":"metric_gear","component":"Metric","props":{"label":"Gear Checklist Completion","value":"85%"}},{"id":"metric_morale","component":"Metric","props":{"label":"Crew Morale","value":"High"}}]}';

    const { composition } = parseComposition(malformed);
    const heading = composition.nodes.find((node) => node.component === 'Heading');
    expect(heading?.props?.text).toBe('Crew Readiness Status');
    expect(composition.nodes.filter((node) => node.component === 'Metric')).toHaveLength(2);
    for (const node of composition.nodes) {
      for (const value of Object.values(node.props ?? {})) {
        expect(String(value)).not.toMatch(/metric_gear|metric_morale/);
      }
    }
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('reconstructs name-and-object inline children like ["Button":{...}]', () => {
    // Second real Gemma inline variant: component name as a key with an object
    // value inside the children array.
    const malformed = '{"root":"root","nodes":[{"id":"root","component":"Page","children":["row"]},{"id":"row","component":"Stack","props":{"gap":"md"},"children":["Button":{"label":"Accept Solution","tone":"primary","action":{"name":"acceptSolution"}},"Button":{"label":"Reopen Chat","tone":"secondary","action":{"name":"reopenChat"}}]}]}';

    const { composition } = parseComposition(malformed);
    const buttons = composition.nodes.filter((node) => node.component === 'Button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({ props: { label: 'Accept Solution', tone: 'primary' }, action: { name: 'acceptSolution' } });
    expect(buttons[1]).toMatchObject({ props: { label: 'Reopen Chat', tone: 'secondary' }, action: { name: 'reopenChat' } });
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('removes hollow layout containers left behind by pruning', () => {
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['content', 'emptyCard'] },
        { id: 'content', component: 'Text', props: { text: 'Real content' } },
        { id: 'emptyCard', component: 'Card', props: { tone: 'critical' }, children: ['ghost'] },
      ],
    }));

    expect(composition.nodes.map((node) => node.id)).toEqual(['root', 'content']);
    expect(warnings.join(' ')).toMatch(/removed 1 empty layout container/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('keeps an icon-only Heading instead of dropping it', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['h', 'x'] },
        { id: 'h', component: 'Heading', props: { level: 'h2', icon: '📈' } },
        { id: 'x', component: 'Text', props: { text: 'anchor' } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'h')?.props).toMatchObject({ text: '', icon: '📈' });
  });

  it('recovers a label-less Button from its action name', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['b', 'x'] },
        { id: 'b', component: 'Button', props: { tone: 'primary' }, action: { name: 'submitIntake' } },
        { id: 'x', component: 'Text', props: { text: 'anchor' } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'b')?.props).toMatchObject({ label: 'Submit intake' });
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('recovers a run-on emission where no node object is ever closed', () => {
    // Real Gemma pattern: every node runs into the next, so the stream parses
    // as ONE object whose repeated "id" keys overwrite each other.
    const runOn = '{"root":"screen","nodes":[{"id":"heading1","component":"Heading","props":{"text":"Review Your Order","level":2,"icon":"🛒"},"children":["",""],"id":"introText","component":"Text","props":{"text":"Please review before finalizing your purchase.","tone":"default"},"id":"orderSummaryCard","component":"Card","props":{"tone":"recommended"},"children":["id":"summaryHeading","component":"Heading","props":{"text":"Order Summary","level":3,"icon":"📝"},"id":"item1","component":"Text","props":{"text":"Blue T-Shirt (Size L)","tone":"default"},"id":"total","component":"Metric","props":{"label":"Order Total","value":"$53.60","tone":"critical"}]}';

    const { composition } = parseComposition(runOn);
    const components = composition.nodes.map((node) => `${node.component}:${node.id}`);
    expect(components).toContain('Heading:heading1');
    expect(components).toContain('Text:introText');
    expect(components).toContain('Card:orderSummaryCard');
    expect(components).toContain('Heading:summaryHeading');
    expect(components).toContain('Text:item1');
    expect(components).toContain('Metric:total');
    expect(composition.nodes.find((node) => node.id === 'heading1')?.props).toMatchObject({ text: 'Review Your Order', level: 'h2' });
    // Emission-order adoption puts the summary content inside the card.
    const card = composition.nodes.find((node) => node.id === 'orderSummaryCard');
    expect(card?.children).toContain('summaryHeading');
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('groups consecutive metrics into a grid so a KPI row shares the width', () => {
    // Condensed from a real checkout-review run: four totals metrics emitted
    // directly under the Stack layout each rendered as a full-width row.
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['layout'] },
        { id: 'layout', component: 'Stack', props: { gap: 'lg' }, children: ['heading1', 'orderSummaryCard', 'totalMetric', 'taxMetric', 'shippingMetric', 'grandTotalMetric', 'placeOrder'] },
        { id: 'heading1', component: 'Heading', props: { text: 'Review Your Order', icon: '🛒' } },
        { id: 'orderSummaryCard', component: 'Card', children: ['item1'] },
        { id: 'item1', component: 'Text', props: { text: 'Item 1: Blue Widget (Qty: 2)' } },
        { id: 'totalMetric', component: 'Metric', props: { label: 'Subtotal', value: '$45.00' } },
        { id: 'taxMetric', component: 'Metric', props: { label: 'Tax (8%)', value: '$3.60' } },
        { id: 'shippingMetric', component: 'Metric', props: { label: 'Shipping', value: '$5.00' } },
        { id: 'grandTotalMetric', component: 'Metric', props: { label: 'Order Total', value: '$53.60', tone: 'critical' } },
        { id: 'placeOrder', component: 'Button', props: { label: 'Place Order Now', tone: 'primary' }, action: { name: 'placeOrder' } },
      ],
    }));

    const layout = composition.nodes.find((node) => node.id === 'layout');
    expect(layout?.children).toHaveLength(4);
    const gridId = layout!.children![2];
    const grid = composition.nodes.find((node) => node.id === gridId);
    expect(grid).toMatchObject({ component: 'Grid', props: { columns: 4 }, children: ['totalMetric', 'taxMetric', 'shippingMetric', 'grandTotalMetric'] });
    expect(warnings.join(' ')).toMatch(/grouped 4 metrics .* 4-column grid/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('leaves a single metric and non-consecutive metrics unwrapped', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['solo', 'divider', 'pair1', 'note', 'pair2'] },
        { id: 'solo', component: 'Metric', props: { label: 'Uptime', value: '99.9%' } },
        { id: 'divider', component: 'Divider' },
        { id: 'pair1', component: 'Metric', props: { label: 'Errors', value: '3' } },
        { id: 'note', component: 'Text', props: { text: 'Separated by copy, so no shared row.' } },
        { id: 'pair2', component: 'Metric', props: { label: 'Deploys', value: '7' } },
      ],
    }));

    expect(composition.nodes.some((node) => node.component === 'Grid')).toBe(false);
    expect(composition.nodes.find((node) => node.id === 'root')?.children).toEqual(['solo', 'divider', 'pair1', 'note', 'pair2']);
  });

  it('groups consecutive buttons under a flex card into an inline row', () => {
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['card'] },
        { id: 'card', component: 'Card', children: ['title', 'approve', 'reject'] },
        { id: 'title', component: 'Heading', props: { text: 'Decision' } },
        { id: 'approve', component: 'Button', props: { label: 'Approve' }, action: { name: 'approve' } },
        { id: 'reject', component: 'Button', props: { label: 'Reject', tone: 'danger' }, action: { name: 'reject' } },
      ],
    }));

    const card = composition.nodes.find((node) => node.id === 'card');
    expect(card?.children).toHaveLength(2);
    const rowId = card!.children![1];
    expect(composition.nodes.find((node) => node.id === rowId)).toMatchObject({ component: 'Inline', children: ['approve', 'reject'] });
    expect(warnings.join(' ')).toMatch(/grouped 2 inline components/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('compiles a chat composition with coerced bubbles and a bound reply box into A2UI', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', props: { accent: 'sky' }, children: ['title', 'thread', 'composer'] },
        { id: 'title', component: 'Heading', props: { text: 'Order support' } },
        { id: 'thread', component: 'Card', children: ['m1', 'm2'] },
        { id: 'm1', component: 'ChatBubble', props: { text: 'Where is my order?', from: 'customer', name: 'Sam' } },
        { id: 'm2', component: 'ChatBubble', props: { text: 'Checking now.', from: 'agent' } },
        { id: 'composer', component: 'Inline', children: ['reply', 'send'] },
        { id: 'reply', component: 'TextArea', props: { label: 'Reply' }, bind: '/chat/draft' },
        { id: 'send', component: 'Button', props: { label: 'Send' }, action: { name: 'sendReply' } },
      ],
    }));

    const byId = Object.fromEntries(composition.nodes.map((node) => [node.id, node]));
    expect(byId.m1.props).toMatchObject({ from: 'user' });
    expect(byId.m2.props).toMatchObject({ from: 'other' });
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('round-trips every catalog component through salvage into a valid A2UI message stream', () => {
    const minimalProps: Record<ComponentName, Record<string, unknown>> = {
      Page: {}, Stack: {}, Inline: {}, Grid: {}, Card: {}, Divider: {},
      Heading: { text: 'T' }, Text: { text: 'T' }, ChatBubble: { text: 'T' },
      Metric: { label: 'L', value: 'V' }, StatusBadge: { label: 'L' }, Tag: { label: 'L' },
      ProgressBar: { label: 'L', percent: 10 }, Alert: { title: 'T', message: 'M' },
      TextField: { label: 'L' }, TextArea: { label: 'L' },
      Select: { label: 'L', options: [{ label: 'A', value: 'a' }] }, Button: { label: 'L' },
    };
    for (const name of componentNames) {
      const isLayout = layoutComponents.has(name);
      const { composition } = parseComposition(JSON.stringify({
        root: 'root',
        nodes: [
          { id: 'root', component: 'Page', children: ['x', 'anchor'] },
          { id: 'x', component: name, props: minimalProps[name], ...(isLayout ? { children: ['inner'] } : {}) },
          ...(isLayout ? [{ id: 'inner', component: 'Text', props: { text: 'inner' } }] : []),
          { id: 'anchor', component: 'Text', props: { text: 'anchor' } },
        ],
      }));
      expect(composition.nodes.some((node) => node.component === name), `${name} should survive salvage`).toBe(true);
      expect(() => processA2uiMessages(compileToA2ui(composition)), `${name} through A2UI`).not.toThrow();
    }
  });

  it('preserves a model-selected root ID when adapting to A2UI transport', () => {
    const { composition } = parseComposition(JSON.stringify({
      root: 'page',
      nodes: [
        { id: 'page', component: 'Page', children: ['copy'] },
        { id: 'copy', component: 'Text', props: { text: 'Model root' } },
      ],
    }));

    const messages = compileToA2ui(composition);
    const components = (messages[1] as { updateComponents: { components: Array<Record<string, unknown>> } }).updateComponents.components;
    expect(components.map((node) => node.id)).toEqual(['root', 'copy']);
    expect(components[0].children).toEqual(['copy']);
    expect(() => processA2uiMessages(messages)).not.toThrow();
  });

  it('recovers a Gemma stream whose final node loses its closing brace', () => {
    // Real Gemma 4 E2B failure shape: the last node object never closes, so
    // jsonrepair splits the stream into an envelope plus stray node values.
    const truncated = '{"root":"root","nodes":[{"id":"root","component":"Page","props":{"accent":"amber"},"children":["card1","card2"]},{"id":"card1","component":"Card","children":["text1"]},{"id":"text1","component":"Text","props":{"text":"First card"}},{"id":"card2","component":"Card","children":["text2"]},{"id":"text2","component":"Text","props":{"tone":"default","text":"System Log: Awaiting final authorization."}]}';

    const { composition } = parseComposition(truncated);
    expect(composition.root).toBe('root');
    expect(composition.nodes.map((node) => node.id)).toEqual(['root', 'card1', 'text1', 'card2', 'text2']);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('reconstructs a flat depth-first Gemma emission whose cards never link their children', () => {
    // Real Gemma 4 E2B pattern: containers declare children as component TYPE
    // names inside props, while the actual child nodes simply follow in order.
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root1',
      nodes: [
        { id: 'root1', component: 'Page', props: { accent: 'slate' }, children: ['header1', 'mainGrid'] },
        { id: 'header1', component: 'Heading', props: { text: 'Raccoon Heist Command Center', level: 'h1', icon: '🦝' } },
        { id: 'mainGrid', component: 'Grid', props: { columns: 3 }, children: ['card1', 'card2'] },
        { id: 'card1', component: 'Card', props: { tone: 'recommended', children: ['Heading', 'Metric', 'Button'] } },
        { id: 'card1_h2', component: 'Heading', props: { text: 'Crew Readiness', level: 'h2', icon: '✅' } },
        { id: 'readiness_metric', component: 'Metric', props: { label: 'Crew Readiness Score', value: '85%', tone: 'success' } },
        { id: 'go_button', component: 'Button', props: { label: 'INITIATE HEIST (GO)', tone: 'primary' }, action: { name: 'initiateHeist' } },
        { id: 'card2', component: 'Card', props: { tone: 'warning', children: ['Heading', 'Text'] } },
        { id: 'card2_h2', component: 'Heading', props: { text: 'Gear Inventory', level: 'h2', icon: '🎒' } },
        { id: 'gear_list_text', component: 'Text', props: { text: 'Masks, lockpicks, distraction noise makers.' } },
      ],
    }));

    const byId = Object.fromEntries(composition.nodes.map((node) => [node.id, node]));
    expect(byId.card1.children).toEqual(['card1_h2', 'readiness_metric', 'go_button']);
    expect(byId.card2.children).toEqual(['card2_h2', 'gear_list_text']);
    expect(composition.nodes).toHaveLength(10);
    expect(warnings.join(' ')).toMatch(/adopted 5 disconnected nodes/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('attaches an orphaned subtree to a layout root instead of discarding it', () => {
    const { composition, warnings } = parseComposition(JSON.stringify({
      root: 'root',
      nodes: [
        { id: 'root', component: 'Page', children: ['main'] },
        { id: 'main', component: 'Text', props: { text: 'Connected' } },
        { id: 'stray', component: 'Alert', props: { title: 'Forgotten', message: 'The model never linked this.' } },
      ],
    }));

    expect(composition.nodes.find((node) => node.id === 'root')?.children).toEqual(['main', 'stray']);
    expect(warnings.join(' ')).toMatch(/adopted 1 disconnected node/i);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });
});

describe('strict guardrails mode', () => {
  it('accepts cleanly serialized output without touching it', () => {
    const clean = JSON.stringify({
      root: 'root',
      components: [
        { id: 'root', component: 'Page', accent: 'teal', children: ['title'] },
        { id: 'title', component: 'Heading', text: 'Clean output' },
      ],
    });

    const { composition, warnings } = parseCompositionStrict(clean);
    expect(warnings).toEqual([]);
    expect(composition.nodes).toHaveLength(2);
    expect(() => processA2uiMessages(compileToA2ui(composition))).not.toThrow();
  });

  it('rejects malformed JSON with no repair applied', () => {
    expect(() => parseCompositionStrict('{"root":"root","components":[{"id":"root","component":"Page"')).toThrow(/strict mode: .*not valid json/i);
  });

  it('rejects an off-catalog component that salvage would normally drop and continue past', () => {
    expect(() => parseCompositionStrict(JSON.stringify({
      root: 'root',
      components: [
        { id: 'root', component: 'Page', children: ['title'] },
        { id: 'title', component: 'Sparkline', text: 'Off-catalog' },
      ],
    }))).toThrow(/strict mode: .*no coercion applied/i);
  });
});
