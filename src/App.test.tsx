import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { ModelProvider } from './model-provider';
import type { LiteRtEngineLike } from './local-model';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const idleEngine = { createConversation: async () => ({ sendMessageStreaming: async function* () {} }) } as LiteRtEngineLike;

function readyModelApi(generate: ModelProvider['generate']): ModelProvider {
  return {
    hasWebGpu: () => true,
    load: async (onProgress) => { onProgress({ phase: 'ready', percent: 100 }); return idleEngine; },
    generate,
  };
}

async function loadGemma() {
  fireEvent.click(screen.getByRole('button', { name: /load gemma 4 e2b locally/i }));
  await screen.findByText(/gemma 4 e2b loaded in this browser/i);
}

function setPrompt(value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: /what should exist/i }), { target: { value } });
}

// What the model actually emits: A2UI v0.9 component syntax, flat props.
const simpleGraph = {
  root: 'root',
  components: [
    { id: 'root', component: 'Page', accent: 'teal', children: ['title', 'status'] },
    { id: 'title', component: 'Heading', text: 'Tea timer', level: 'h1' },
    { id: 'status', component: 'StatusBadge', label: 'Steeping', tone: 'success' },
  ],
};

describe('free-form local UI composer', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders an interactive A2UI v0.9 fixture through the deterministic integration check', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /deterministic integration check/i }));

    expect(await screen.findByText('Past due')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pay invoice' }));
    // The official A2UI processor dispatches actions asynchronously.
    expect(await screen.findAllByText('Action received: payInvoice')).not.toHaveLength(0);
  });


  it('opens with the first spark filled in and that chip highlighted, with no creativity control', () => {
    render(<App />);

    const promptBox = screen.getByRole('textbox', { name: /what should exist/i });
    expect((promptBox as HTMLTextAreaElement).value).toContain('A patient intake form for a family clinic');
    expect(screen.getByLabelText(/prompt sparks/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /boring med form/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /sourdough control/i })).toHaveAttribute('aria-pressed', 'false');
    // Decoding is locked to the focused profile; there is no creativity picker.
    expect(screen.queryByRole('button', { name: 'Balanced' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adventurous' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /audit intake/i })).not.toBeInTheDocument();
    // The raccoon-heist spark retired after a flagged run: its phrasing kept
    // inviting pathologically nested serialization.
    expect(screen.queryByRole('button', { name: /raccoon heist/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /sourdough control/i }));
    expect((promptBox as HTMLTextAreaElement).value).toContain('sourdough starter');
    expect(screen.getByRole('button', { name: /sourdough control/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /boring med form/i })).toHaveAttribute('aria-pressed', 'false');

    // Editing the text so it no longer matches any spark clears the highlight.
    fireEvent.change(promptBox, { target: { value: 'Mission control for my sourdough starter, but make it purple' } });
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
  });

  it('exposes the LiteRT model picker under the inference provider', () => {
    render(<App />);
    expect(screen.getByText('INFERENCE PROVIDER')).toBeInTheDocument();
    // A2UI v0.9 is the only rendering protocol now; no toggle remains.
    expect(screen.queryByText('RENDERING PROTOCOL')).not.toBeInTheDocument();
    const modelSelect = screen.getByRole('combobox', { name: /litert model/i });
    expect(modelSelect).toHaveValue('gemma-4-e2b');
    expect(within(modelSelect).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(['gemma-4-e2b', 'gemma-4-e2b-catalog']);
  });

  it('loads and generates through Chrome with a native constraint and no schema text in the prompt', async () => {
    const chromeGenerate = vi.fn<ModelProvider['generate']>(async () => JSON.stringify(simpleGraph));
    const chromeLoad = vi.fn<ModelProvider['load']>(async (onProgress) => {
      onProgress({ phase: 'ready', percent: 100 });
      return idleEngine;
    });
    render(<App chromeModelApi={{ hasWebGpu: () => true, load: chromeLoad, generate: chromeGenerate }} />);

    fireEvent.click(screen.getByRole('button', { name: /chrome built-in/i }));
    fireEvent.click(screen.getByRole('button', { name: /use chrome built-in ai/i }));
    await screen.findByText(/chrome built-in ai loaded in this browser/i);
    setPrompt('A tea timer with a steeping status.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText('Tea timer')).toBeInTheDocument();
    expect(chromeLoad).toHaveBeenCalledTimes(1);
    const [, sentPrompt, options] = chromeGenerate.mock.calls[0];
    expect(sentPrompt).not.toContain('Transport-only JSON Schema');
    expect(sentPrompt).not.toContain('components is one flat array');
    expect(options.responseConstraint).toMatchObject({ type: 'object', required: ['root', 'components'] });
    expect(options.sampler).toMatchObject({ temperature: 0.4, topK: 3 });
  });

  it('passes the selected catalog-tuned Gemma definition to LiteRT loading', async () => {
    const load = vi.fn<ModelProvider['load']>(async (onProgress) => { onProgress({ phase: 'ready', percent: 100 }); return idleEngine; });
    render(<App modelApi={{ hasWebGpu: () => true, load, generate: async () => '' }} />);

    fireEvent.change(screen.getByRole('combobox', { name: /litert model/i }), { target: { value: 'gemma-4-e2b-catalog' } });
    fireEvent.click(screen.getByRole('button', { name: /load gemma 4 e2b · catalog-tuned locally/i }));

    await screen.findByText(/catalog-tuned loaded in this browser/i);
    expect(load.mock.calls[0][1]).toMatchObject({ id: 'gemma-4-e2b-catalog', loader: 'heap' });
  });

  it('retains a loaded LiteRT engine when switching to Chrome and back', async () => {
    const load = vi.fn<ModelProvider['load']>(async (onProgress) => { onProgress({ phase: 'ready', percent: 100 }); return idleEngine; });
    render(<App modelApi={{ hasWebGpu: () => true, load, generate: async () => '' }} />);

    await loadGemma();
    fireEvent.click(screen.getByRole('button', { name: /chrome built-in/i }));
    fireEvent.click(screen.getByRole('button', { name: /^litert$/i }));

    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows determinate download progress and an honest indeterminate compile phase', async () => {
    const downloadGate = deferred();
    const compileGate = deferred();
    render(<App modelApi={{
      hasWebGpu: () => true,
      generate: async () => '',
      load: async (onProgress) => {
        onProgress({ phase: 'preparing' });
        onProgress({ phase: 'downloading', loadedBytes: 1_000, totalBytes: 2_000, percent: 50 });
        await downloadGate.promise;
        onProgress({ phase: 'compiling', loadedBytes: 2_000, totalBytes: 2_000 });
        await compileGate.promise;
        onProgress({ phase: 'ready', percent: 100 });
        return idleEngine;
      },
    }} />);

    fireEvent.click(screen.getByRole('button', { name: /load gemma 4 e2b locally/i }));
    expect(await screen.findByRole('progressbar', { name: /downloading gemma 4 e2b/i })).toHaveAttribute('aria-valuenow', '50');

    await act(async () => downloadGate.resolve());
    expect(await screen.findByText(/compiling for webgpu/i)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /compiling gemma 4 e2b/i })).not.toHaveAttribute('aria-valuenow');

    await act(async () => compileGate.resolve());
    expect(await screen.findByText(/gemma 4 e2b loaded in this browser/i)).toBeInTheDocument();
  });

  it('generates from a free-form prompt with schema guidance in the LiteRT prompt', async () => {
    const generate = vi.fn<ModelProvider['generate']>(async () => JSON.stringify(simpleGraph));
    render(<App modelApi={readyModelApi(generate)} />);

    await loadGemma();
    setPrompt('A tea timer with a steeping status.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText('Tea timer')).toBeInTheDocument();
    expect(screen.getByText('Steeping')).toBeInTheDocument();
    const [, sentPrompt, options] = generate.mock.calls[0];
    expect(sentPrompt).toContain('A tea timer with a steeping status.');
    expect(sentPrompt).toContain('Component catalog');
    expect(sentPrompt).toContain('Transport-only JSON Schema');
    // Locked focused profile: LiteRT-LM 0.14 decodes greedily and no creative
    // direction is injected — the same prompt reproduces the same surface.
    expect(options.sampler).toBeUndefined();
    expect(sentPrompt).not.toContain('Creative direction');
    expect(screen.getByText(/compiled model-selected components into a2ui v0\.9/i)).toBeInTheDocument();

    const exchange = screen.getByText(/inspect generation exchange/i).closest('details') as HTMLElement;
    fireEvent.click(within(exchange).getByRole('tab', { name: /harness → renderer/i }));
    expect(within(exchange).getByLabelText(/harness to renderer json/i)).toHaveTextContent(/"createSurface"/i);
    expect(within(exchange).getByLabelText(/harness to renderer json/i)).toHaveTextContent(/Tea timer/i);
  });

  it('hides the reroll affordance on the deterministic LiteRT path but numbers repeated takes', async () => {
    const generate = vi.fn<ModelProvider['generate']>(async () => JSON.stringify(simpleGraph));
    render(<App modelApi={readyModelApi(generate)} />);

    await loadGemma();
    setPrompt('Something dependable.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Tea timer');
    // Greedy decoding makes a reroll pointless on LiteRT — the button is Chrome-only.
    expect(screen.queryByRole('button', { name: /reroll/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText(/take 2/i);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('renders the streaming preview while the model is still emitting', async () => {
    const gate = deferred();
    const generate = vi.fn<ModelProvider['generate']>(async (_engine, _prompt, options) => {
      options.onPartial?.('{"root":"root","nodes":[{"id":"root","component":"Page","children":["title"]},{"id":"title","component":"Heading","props":{"text":"Streaming hea');
      await gate.promise;
      return JSON.stringify(simpleGraph);
    });
    render(<App modelApi={readyModelApi(generate)} />);

    await loadGemma();
    setPrompt('A tea timer.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText('Streaming hea', undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText(/composing · /i)).toBeInTheDocument();

    await act(async () => gate.resolve());
    expect(await screen.findByText('Tea timer')).toBeInTheDocument();
    expect(screen.queryByText('Streaming hea')).not.toBeInTheDocument();
  });

  it('allows two visible repair attempts at focused sampling before accepting a graph', async () => {
    const outputs = [
      'this is not json at all',
      JSON.stringify({ root: 'root', components: [{ id: 'root', component: 'Stack', children: [] }] }),
      JSON.stringify(simpleGraph),
    ];
    const generate = vi.fn<ModelProvider['generate']>(async () => outputs.shift()!);
    render(<App modelApi={readyModelApi(generate)} />);

    await loadGemma();
    setPrompt('A tea timer.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText('Tea timer')).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[1][1]).toContain('could not be rendered');
    expect(generate.mock.calls[1][2].sampler).toBeUndefined();
    expect(screen.getByText('3 attempts')).toBeInTheDocument();
  });

  it('records every generation as a restorable take and supports rerolling on Chrome', async () => {
    const outputs = [
      JSON.stringify(simpleGraph),
      JSON.stringify({
        root: 'root',
        components: [
          { id: 'root', component: 'Page', accent: 'rose', children: ['other'] },
          { id: 'other', component: 'Alert', title: 'Second take', message: 'A different composition.' },
        ],
      }),
    ];
    const generate = vi.fn<ModelProvider['generate']>(async () => outputs.shift()!);
    render(<App chromeModelApi={{ hasWebGpu: () => true, load: async (onProgress) => { onProgress({ phase: 'ready', percent: 100 }); return idleEngine; }, generate }} />);

    fireEvent.click(screen.getByRole('button', { name: /chrome built-in/i }));
    fireEvent.click(screen.getByRole('button', { name: /use chrome built-in ai/i }));
    await screen.findByText(/chrome built-in ai loaded in this browser/i);
    setPrompt('A tea timer.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Tea timer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /reroll/i }));
    expect(await screen.findByText('Second take')).toBeInTheDocument();
    expect(screen.queryByText('Tea timer')).not.toBeInTheDocument();

    const history = screen.getByLabelText(/generation history/i);
    const chips = within(history).getAllByRole('button');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('T2');
    expect(chips[1]).toHaveTextContent('T1');

    fireEvent.click(chips[1]);
    expect(await screen.findByText('Tea timer')).toBeInTheDocument();
  });

  it('restores completed generations from localStorage after a reload', async () => {
    const generate = vi.fn<ModelProvider['generate']>(async () => JSON.stringify(simpleGraph));
    render(<App modelApi={readyModelApi(generate)} />);

    await loadGemma();
    setPrompt('A tea timer.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Tea timer');

    cleanup();
    render(<App />);
    const history = screen.getByLabelText(/generation history/i);
    fireEvent.click(within(history).getAllByRole('button')[0]);
    expect(await screen.findByText('Tea timer')).toBeInTheDocument();
  });

  it('strict guardrails render clean output untouched and surface raw failures honestly', async () => {
    const outputs = [
      JSON.stringify(simpleGraph),
      'the model rambled instead of emitting JSON',
      '{"root":"root","nodes":[{"id":"root","component":"Page","children":["ghost"',
      'still broken',
    ];
    const generate = vi.fn<ModelProvider['generate']>(async () => outputs.shift()!);
    render(<App modelApi={readyModelApi(generate)} />);

    await loadGemma();
    fireEvent.click(screen.getByRole('button', { name: 'Strict' }));
    setPrompt('A tea timer.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    // Clean output passes strict validation with zero adjustments.
    expect(await screen.findByText('Tea timer')).toBeInTheDocument();
    expect(screen.queryByText(/guardrail adjustment/i)).not.toBeInTheDocument();

    // Malformed output fails visibly: no repair, no salvage, three attempts.
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/validation stopped the surface/i)).toBeInTheDocument();
    expect(within(screen.getByRole('alert')).getByText(/strict mode: .*not valid json/i)).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(4);

    // The choice persists for the next session.
    expect(localStorage.getItem('local-ui-composer-guardrails-v1')).toBe('strict');
  });

  it('surfaces salvage warnings without hiding the rendered surface', async () => {
    const generate = vi.fn<ModelProvider['generate']>(async () => JSON.stringify({
      root: 'root',
      components: [
        { id: 'root', component: 'Page', children: ['title', 'chart'] },
        { id: 'title', component: 'Heading', text: 'Partially valid' },
        { id: 'chart', component: 'HoloChart', data: [] },
      ],
    }));
    render(<App modelApi={readyModelApi(generate)} />);

    await loadGemma();
    setPrompt('A dashboard with a chart.');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText('Partially valid')).toBeInTheDocument();
    expect(screen.getByText(/guardrail adjustment/i)).toBeInTheDocument();
  });

  it('posts run outcomes and flagged examples to the session log endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('metrics look wrong here');
    try {
      const outputs = [JSON.stringify(simpleGraph), 'broken', 'broken', 'broken'];
      const generate = vi.fn<ModelProvider['generate']>(async () => outputs.shift()!);
      render(<App modelApi={readyModelApi(generate)} />);

      await loadGemma();
      setPrompt('A tea timer.');
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByText('Tea timer');

      const logCalls = () => fetchSpy.mock.calls.filter(([url]) => url === '/__session-log').map(([, init]) => JSON.parse(String(init?.body)));
      const doneRecord = logCalls().find((record) => record.type === 'run' && record.status === 'done');
      expect(doneRecord).toMatchObject({ prompt: 'A tea timer.', guardrails: 'recover', nodeCount: 3 });
      expect(doneRecord.attempts).toHaveLength(1);
      expect(doneRecord.attempts[0].response).toContain('Tea timer');

      // A failed run logs its error and every attempt's raw output.
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByText(/validation stopped the surface/i);
      const failedRecord = logCalls().find((record) => record.type === 'run' && record.status === 'failed');
      expect(failedRecord).toMatchObject({ prompt: 'A tea timer.' });
      expect(failedRecord.attempts).toHaveLength(3);
      expect(failedRecord.error).toMatch(/invalid catalog composition|not valid json|repairable/i);

      // Flagging the active run captures a note plus the full run context.
      fireEvent.click(screen.getAllByRole('button', { name: /flag for review/i })[0]);
      const flagRecord = logCalls().find((record) => record.type === 'flag');
      expect(flagRecord).toMatchObject({ note: 'metrics look wrong here', prompt: 'A tea timer.' });
    } finally {
      fetchSpy.mockRestore();
      promptSpy.mockRestore();
    }
  });

  it('opens the debug trace by default and logs framework steps', async () => {
    render(<App />);
    const trace = screen.getByText('Debug trace').closest('details');
    expect(trace).toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: /deterministic integration check/i }));
    expect(await screen.findByText(/official processor/i)).toBeInTheDocument();
    expect(within(trace as HTMLElement).getByText(/built surface sample\.dashboard/i)).toBeInTheDocument();
  });

  it('exposes the prompt, editable blueprints, vocabulary, and salvage playbook in the harness tab', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: /prompt & guardrails/i }));

    expect(screen.getByRole('heading', { name: /what the model does/i })).toBeInTheDocument();
    expect(screen.getByText('The model authors')).toBeInTheDocument();
    expect(screen.getByText('The harness contributes')).toBeInTheDocument();
    expect(screen.getByText(/salvage playbook/i)).toBeInTheDocument();
    expect(screen.getByText(/component synonyms/i)).toBeInTheDocument();

    // Typing a form-shaped request highlights the form blueprint and shows it in the live prompt.
    setPrompt('A patient intake form for a family clinic.');
    fireEvent.click(screen.getByRole('tab', { name: /prompt & guardrails/i }));
    expect(screen.getAllByText(/matches current prompt/i)).not.toHaveLength(0);

    // Editing a blueprint flows into the live prompt and persists.
    const blueprintBoxes = screen.getAllByLabelText(/blueprint sent to the model/i);
    fireEvent.change(blueprintBoxes[0], { target: { value: 'Form: Page [Heading, one Card [2 TextField]]' } });
    const livePrompt = document.querySelector('.harness-prompt');
    expect(livePrompt?.textContent).toContain('Form: Page [Heading, one Card [2 TextField]]');
    expect(localStorage.getItem('local-ui-composer-pattern-library-v1')).toContain('one Card [2 TextField]');
  });

  it('shows the rendered preview first, then overview and code, for each shared component', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: /component library/i }));

    expect(screen.getByRole('heading', { name: 'Shared component library' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ProgressBar' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tag' })).toBeInTheDocument();

    const metric = screen.getByRole('article', { name: 'Metric component' });
    expect(within(metric).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Preview', 'Overview', 'Code']);
    expect(within(metric).getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
    expect(within(metric).getByText('$42,800')).toBeInTheDocument();
    fireEvent.click(within(metric).getByRole('tab', { name: 'Overview' }));
    expect(within(metric).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(metric).getByRole('tab', { name: 'Code' }));
    expect(within(metric).getByText(/<Metric/)).toBeInTheDocument();
  });
});
