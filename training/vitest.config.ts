/**
 * Vitest config for the training pipeline's test-shaped scripts (data assembly,
 * prompt materialisation, exam scoring). They read and write files under
 * training/, so they run on request, not as part of `npm test`:
 *
 *   npx vitest run -c training/vitest.config.ts assemble
 *   EVAL_FILES=training/runs/stamp3/exam-tuned-2ep.jsonl npx vitest run -c training/vitest.config.ts eval-replay
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: new URL('..', import.meta.url).pathname,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['training/scripts/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
