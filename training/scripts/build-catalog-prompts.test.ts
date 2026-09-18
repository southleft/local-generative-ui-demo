import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { RESPONSE_CONSTRAINT, buildCompositionPrompt } from '../../src/prompt';

/** Production prompts for the catalog micro-requests, same shape as build-prompts.test.ts. */
const IN = `${process.cwd()}/training/data/catalog-set.jsonl`;
const OUT = `${process.cwd()}/training/data/catalog-prompts-built.jsonl`;
const SUFFIX = `\n\nTransport-only JSON Schema (follow this exact outer shape; you still choose every node and relationship):\n${JSON.stringify(RESPONSE_CONSTRAINT)}`;

it('builds the production prompt for every catalog example', () => {
  const rows = readFileSync(IN, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { id: string; request: string });
  writeFileSync(OUT, rows.map((row) => JSON.stringify({ id: row.id, family: 'catalog', split: 'train', request: row.request, prompt_litert: buildCompositionPrompt(row.request) + SUFFIX })).join('\n') + '\n');
  console.log(`built ${rows.length} catalog prompts`);
});
