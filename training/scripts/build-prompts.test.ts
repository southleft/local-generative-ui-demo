import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { RESPONSE_CONSTRAINT, buildCompositionPrompt } from '../../src/prompt';

/**
 * Materialise the exact production prompt for every request, so the teacher
 * model and the fine-tune see byte-for-byte what the app sends. The LiteRT
 * variant carries the transport schema as text (the app appends it in
 * use-composer-workbench.ts); the Chrome variant omits it because Chrome
 * enforces the schema natively.
 *
 *   npx vitest run training/scripts/build-prompts.test.ts
 */
const IN = `${process.cwd()}/training/data/prompts.jsonl`;
const OUT = `${process.cwd()}/training/data/prompts-built.jsonl`;
const SUFFIX = `\n\nTransport-only JSON Schema (follow this exact outer shape; you still choose every node and relationship):\n${JSON.stringify(RESPONSE_CONSTRAINT)}`;

it('builds the production prompt for every request', () => {
  const rows = readFileSync(IN, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { id: string; family: string; split: string; request: string });
  const out = rows.map((row) => ({
    ...row,
    prompt_litert: buildCompositionPrompt(row.request) + SUFFIX,
    prompt_chrome: buildCompositionPrompt(row.request, { schemaEnforced: true }),
  }));
  writeFileSync(OUT, out.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const lengths = out.map((row) => row.prompt_litert.length).sort((a, b) => a - b);
  console.log(`built ${out.length} prompts · litert prompt chars min ${lengths[0]} median ${lengths[Math.floor(lengths.length / 2)]} max ${lengths.at(-1)}`);
});
