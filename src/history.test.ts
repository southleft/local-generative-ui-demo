import { beforeEach, describe, expect, it } from 'vitest';
import type { GenerationRun } from './generation-types';
import { HISTORY_STORAGE_KEY, loadPersistedRuns, persistCompletedRuns } from './history';
import type { CatalogComposition } from './salvage';

const composition: CatalogComposition = {
  root: 'root',
  nodes: [
    { id: 'root', component: 'Page', children: ['copy'] },
    { id: 'copy', component: 'Text', props: { text: 'Hello' } },
  ],
};

const run = (overrides: Partial<GenerationRun>): GenerationRun => ({
  id: 1, prompt: 'A greeting.', take: 1, providerLabel: 'Gemma 4 E2B', status: 'done', composition, warnings: [], errors: [], exchanges: [], rawOutput: '{}', ...overrides,
});

describe('history persistence', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the valid records when one stored entry is corrupt, and still reads the original record shape', () => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([
      // The shape the first release wrote: no rawOutput, no message stream.
      { prompt: 'intact', take: 1, providerLabel: 'Gemma 4 E2B', composition, warnings: ['Grouped 2 metrics'] },
      // A later shape that carried fields this version no longer stores; they are stripped, not fatal.
      { prompt: 'newer', take: 2, providerLabel: 'Gemma 4 E2B', composition, warnings: [], status: 'done', errors: [], rawOutput: '{"root":"root"}' },
      // A failed run from that shape has nothing to render and is dropped.
      { prompt: 'failed', take: 1, providerLabel: 'Gemma 4 E2B', warnings: [], status: 'failed', errors: ['not JSON'] },
      { prompt: 'broken', take: 'one' },
      42,
    ]));

    const runs = loadPersistedRuns();
    expect(runs.map((entry) => entry.prompt)).toEqual(['intact', 'newer']);
    expect(runs[0]).toMatchObject({ status: 'done', warnings: ['Grouped 2 metrics'], errors: [] });
    expect(runs[0].rawOutput).toContain('"root": "root"');
    expect(runs[1].rawOutput).toBe('{"root":"root"}');
  });

  it('persists only runs that rendered; failed and in-flight runs stay in the session log', () => {
    persistCompletedRuns([
      run({ id: 1, prompt: 'rendered' }),
      run({ id: 2, prompt: 'failed', status: 'failed', composition: undefined, errors: ['The model output was not repairable JSON.'] }),
      run({ id: 3, prompt: 'streaming', status: 'streaming', composition: undefined }),
    ]);

    expect(loadPersistedRuns().map((entry) => entry.prompt)).toEqual(['rendered']);
  });
});
