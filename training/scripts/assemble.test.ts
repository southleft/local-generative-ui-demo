import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { compileToA2ui } from '../../src/a2ui-protocol';
import { parseCompositionStrict, type CatalogComposition } from '../../src/salvage';

/**
 * Assemble the fine-tuning sets from three labelled sources and write
 * mlx-lm chat JSONL for each mix:
 *
 *   gemma    — runs from sessions/generation-log.ndjson that the guardrail
 *              passed without dropping a node (the guardrail as labeler)
 *   teacher  — Claude outputs that pass the STRICT parser with zero salvage
 *   catalog  — schema-derived micro-examples (already validated at generation)
 *
 * Every target is canonicalised the same way: parse → compileToA2ui →
 * { root: "root", components: [...] } in A2UI component syntax, so the three
 * sources are indistinguishable in form and differ only in provenance.
 *
 *   npx vitest run training/scripts/assemble.test.ts
 */
const ROOT = process.cwd();
const DATA = `${ROOT}/training/data`;
const LOG = `${ROOT}/sessions/generation-log.ndjson`;
const readJsonl = <T,>(file: string): T[] => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as T) : [];

type Prompt = { id: string; family: string; split: string; request: string; prompt_litert: string };
type LogRun = { type: string; status: string; provider: string; prompt: string; loggedAt: string; warnings?: string[]; composition?: CatalogComposition };
type Teacher = { id: string; output?: string; error?: string };
type CatalogRow = { id: string; request: string; target: string };
type Example = { id: string; source: 'gemma' | 'teacher' | 'catalog'; family: string; request: string; prompt: string; target: string; nodes: number };

const canonical = (composition: CatalogComposition): { target: string; nodes: number } => {
  const messages = compileToA2ui(composition) as Array<Record<string, unknown>>;
  const update = messages.find((m) => 'updateComponents' in m) as { updateComponents: { components: unknown[] } };
  return { target: JSON.stringify({ root: 'root', components: update.updateComponents.components }), nodes: update.updateComponents.components.length };
};
const LOSSY = /^(Dropped|Kept the first|Removed \d+ components repeating)/;

it('assembles the training mixes', () => {
  const prompts = readJsonl<Prompt>(`${DATA}/prompts-built.jsonl`);
  const byRequest = new Map(prompts.map((p) => [p.request, p]));
  const trainIds = new Set(prompts.filter((p) => p.split === 'train').map((p) => p.id));
  const examples: Example[] = [];
  const stats: Record<string, Record<string, number>> = { gemma: {}, teacher: {}, catalog: {} };
  const bump = (source: string, key: string) => { stats[source][key] = (stats[source][key] ?? 0) + 1; };

  // Gemma: latest run per training prompt from the log, guardrail-passed without node loss.
  const runs = readJsonl<LogRun>(LOG).filter((r) => r.type === 'run' && r.provider === 'Gemma 4 E2B' && byRequest.has(r.prompt) && trainIds.has(byRequest.get(r.prompt)!.id));
  const latest = new Map<string, LogRun>();
  for (const run of runs) latest.set(run.prompt, run);
  for (const [request, run] of latest) {
    const p = byRequest.get(request)!;
    bump('gemma', 'runs');
    if (run.status !== 'done' || !run.composition) { bump('gemma', 'failed'); continue; }
    if ((run.warnings ?? []).some((w) => LOSSY.test(w))) { bump('gemma', 'rejected: node loss'); continue; }
    const { target, nodes } = canonical(run.composition);
    if (nodes < 4) { bump('gemma', 'rejected: under 4 nodes'); continue; }
    bump('gemma', 'kept');
    examples.push({ id: `g-${p.id}`, source: 'gemma', family: p.family, request, prompt: p.prompt_litert, target, nodes });
  }

  // Teacher: strict parse, zero salvage.
  for (const row of readJsonl<Teacher>(`${DATA}/teacher-raw.jsonl`)) {
    const p = prompts.find((x) => x.id === row.id);
    if (!p || !trainIds.has(p.id)) continue;
    bump('teacher', 'runs');
    if (!row.output) { bump('teacher', 'api error'); continue; }
    try {
      const { composition, warnings } = parseCompositionStrict(row.output);
      if (warnings.length) { bump('teacher', 'rejected: needed salvage'); continue; }
      const { target, nodes } = canonical(composition);
      // ~1,500 prompt tokens + a 6,000-character target stays under the 4,096-token training window.
      if (target.length > 6000) { bump('teacher', 'rejected: too long for the window'); continue; }
      bump('teacher', 'kept');
      examples.push({ id: `t-${p.id}`, source: 'teacher', family: p.family, request: p.request, prompt: p.prompt_litert, target, nodes });
    } catch (error) {
      bump('teacher', `rejected: ${String((error as Error).message).split('\n')[0].slice(0, 40)}`);
    }
  }

  // Catalog: validated at generation; canonicalise for uniform form. The prompt is the production prompt for the micro-request.
  const built = new Map(readJsonl<Prompt>(`${DATA}/catalog-prompts-built.jsonl`).map((p) => [p.id, p]));
  for (const row of readJsonl<CatalogRow>(`${DATA}/catalog-set.jsonl`)) {
    bump('catalog', 'runs');
    const prompt = built.get(row.id)?.prompt_litert;
    if (!prompt) { bump('catalog', 'missing built prompt'); continue; }
    const { composition } = parseCompositionStrict(row.target);
    const { target, nodes } = canonical(composition);
    bump('catalog', 'kept');
    examples.push({ id: `c-${row.id}`, source: 'catalog', family: 'catalog', request: row.request, prompt, target, nodes });
  }

  const mixes: Record<string, Example['source'][]> = { 'mix-gemma': ['gemma', 'catalog'], 'mix-teacher': ['teacher', 'catalog'], 'mix-all': ['gemma', 'teacher', 'catalog'] };
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const [name, sources] of Object.entries(mixes)) {
    const pool = examples.filter((e) => sources.includes(e.source));
    const shuffled = [...pool].sort(() => rand() - 0.5);
    const validCount = Math.max(8, Math.floor(shuffled.length * 0.05));
    const valid = shuffled.slice(0, validCount), train = shuffled.slice(validCount);
    const dir = `${DATA}/${name}`;
    mkdirSync(dir, { recursive: true });
    // Same system message the app sends to LiteRT, so the rendered training turn matches inference byte for byte.
    const SYSTEM = 'Follow the output format exactly. Never emit executable code.';
    const line = (e: Example) => JSON.stringify({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: e.prompt }, { role: 'assistant', content: e.target }] });
    writeFileSync(`${dir}/train.jsonl`, train.map(line).join('\n') + '\n');
    writeFileSync(`${dir}/valid.jsonl`, valid.map(line).join('\n') + '\n');
    writeFileSync(`${dir}/test.jsonl`, valid.slice(0, 4).map(line).join('\n') + '\n');
    writeFileSync(`${dir}/manifest.jsonl`, pool.map((e) => JSON.stringify({ id: e.id, source: e.source, family: e.family, nodes: e.nodes, request: e.request })).join('\n') + '\n');
    console.log(`${name}: train ${train.length} · valid ${valid.length} · by source ${sources.map((s) => `${s} ${pool.filter((e) => e.source === s).length}`).join(', ')}`);
  }
  console.log('stats:', JSON.stringify(stats));
  const nodes = (source: string) => { const list = examples.filter((e) => e.source === source).map((e) => e.nodes).sort((a, b) => a - b); return list.length ? `${list[0]}–${list.at(-1)} (median ${list[Math.floor(list.length / 2)]})` : '-'; };
  console.log(`nodes per example: gemma ${nodes('gemma')} · teacher ${nodes('teacher')} · catalog ${nodes('catalog')}`);
});
