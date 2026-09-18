#!/usr/bin/env node
/**
 * Teacher set: ask Claude for a composition per request, using the exact
 * production prompt the app sends to LiteRT. Raw outputs are written as-is;
 * validation (strict parse, zero salvage) happens in a separate step so the
 * rejection rate is itself a number we can report.
 *
 *   ANTHROPIC_API_KEY=... node training/scripts/teacher.mjs [--model claude-sonnet-5] [--limit N] [--split train]
 *
 * Resumable: requests already present in the output file are skipped.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith('--') ? [arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : []).filter(Boolean));
const MODEL = args.model ?? 'claude-sonnet-5';
const SPLIT = args.split ?? 'train';
const LIMIT = Number(args.limit ?? Infinity);
const CONCURRENCY = Number(args.concurrency ?? 4);
const IN = new URL('../data/prompts-built.jsonl', import.meta.url).pathname;
const OUT = new URL('../data/teacher-raw.jsonl', import.meta.url).pathname;

const key = process.env.ANTHROPIC_API_KEY || readEnv('ANTHROPIC_API_KEY');
if (!key) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }
function readEnv(name) {
  for (const file of [process.env.ENV_FILE, '.env', '../../../.env'].filter(Boolean)) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const SYSTEM = 'You are the UI designer. Answer with exactly one JSON object and nothing else: no prose, no markdown fences. Every component must be an entry in the flat "components" array with a unique id; children are id strings. Use only the catalog and the prop values it lists. Write real, specific content for the request.';

const rows = readFileSync(IN, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.split === SPLIT);
const done = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).id) : []);
const todo = rows.filter((row) => !done.has(row.id)).slice(0, LIMIT);
console.error(`teacher: ${todo.length} to generate (${done.size} already done) with ${MODEL}`);

let inTokens = 0, outTokens = 0, failures = 0;
async function generate(row) {
  const body = { model: MODEL, max_tokens: Number(args["max-tokens"] ?? 2500), system: SYSTEM, messages: [{ role: 'user', content: row.prompt_litert }] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    const json = await res.json();
    if (!res.ok) { failures += 1; return { id: row.id, request: row.request, family: row.family, model: MODEL, error: json.error?.message ?? `http ${res.status}` }; }
    inTokens += json.usage?.input_tokens ?? 0; outTokens += json.usage?.output_tokens ?? 0;
    const text = (json.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
    return { id: row.id, request: row.request, family: row.family, model: MODEL, output: text, usage: json.usage, stop: json.stop_reason };
  }
  failures += 1;
  return { id: row.id, request: row.request, family: row.family, model: MODEL, error: 'retries exhausted' };
}

let index = 0;
async function worker() {
  while (index < todo.length) {
    const row = todo[index++];
    const result = await generate(row);
    appendFileSync(OUT, JSON.stringify(result) + '\n');
    if (index % 25 === 0 || index === todo.length) console.error(`  ${index}/${todo.length} · tokens in ${inTokens} out ${outTokens} · failures ${failures}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.error(`done · input tokens ${inTokens} · output tokens ${outTokens} · failures ${failures}`);
