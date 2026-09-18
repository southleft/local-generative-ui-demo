import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { compileToA2ui, processA2uiMessages } from '../../src/a2ui-protocol';
import { parseComposition, parseCompositionStrict } from '../../src/salvage';

/**
 * Score model outputs through the real guardrail. One row per outputs file:
 *
 *   EVAL_FILES=training/runs/eval-base.jsonl,training/runs/eval-mix-all.jsonl \
 *     npx vitest run training/scripts/eval-replay.test.ts --reporter=verbose
 *
 * Metrics: valid JSON on its own, strict pass (no repair, no coercion),
 * rendered through salvage + the official processor, adjustments per run,
 * runs that lost nodes, and node counts. The eight showcase prompts are also
 * reported individually so the blog's before/after uses prompts readers know.
 */
type Output = { id: string; family: string; request: string; output: string; seconds: number };
const ROOT = process.cwd();
const files = (process.env.EVAL_FILES ?? 'training/runs/eval-base.jsonl').split(',').map((f) => f.trim()).filter(Boolean);
const LOSSY = /^(Dropped|Kept the first|Removed \d+ components repeating)/;
const cleaned = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
const median = (list: number[]) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const showcase = ['houseplant Gerald', 'model rocket', 'patient intake form', 'customer support chat', 'status dashboard for a website', 'account settings page', 'checkout review screen for a small web shop', 'sourdough starter: fermentation'];

it('scores every outputs file through the guardrail', () => {
  const report: string[] = [];
  report.push('| model | n | valid JSON | strict pass | rendered | first-try no loss | median adjustments | median nodes | median s |');
  report.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const perShowcase: Record<string, string[]> = {};
  for (const file of files) {
    const path = file.startsWith('/') ? file : `${ROOT}/${file}`;
    if (!existsSync(path)) { report.push(`| ${file} | missing |`); continue; }
    const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Output);
    let validJson = 0, strict = 0, rendered = 0, clean = 0;
    const adjustments: number[] = [], nodes: number[] = [], seconds: number[] = [];
    for (const row of rows) {
      seconds.push(row.seconds);
      try { JSON.parse(cleaned(row.output)); validJson += 1; } catch { /* not JSON */ }
      try { parseCompositionStrict(row.output); strict += 1; } catch { /* strict fail */ }
      let summary = 'FAIL';
      try {
        const { composition, warnings } = parseComposition(row.output);
        const handle = processA2uiMessages(compileToA2ui(composition));
        rendered += 1;
        adjustments.push(warnings.length);
        nodes.push(handle.componentCount);
        const lossy = warnings.some((w) => LOSSY.test(w));
        if (!lossy) clean += 1;
        summary = `${handle.componentCount} nodes, ${warnings.length} adj${lossy ? ', node loss' : ''}`;
      } catch (error) {
        summary = `FAIL: ${String((error as Error).message).split('\n')[0].slice(0, 50)}`;
      }
      const key = showcase.find((s) => row.request.includes(s));
      if (key) (perShowcase[key] ??= []).push(`${file.replace(/^.*\//, '')}: ${summary}`);
    }
    const n = rows.length;
    report.push(`| ${file.replace(/^.*\//, '')} | ${n} | ${validJson} | ${strict} | ${rendered} | ${clean} | ${median(adjustments)} | ${median(nodes)} | ${median(seconds)} |`);
  }
  report.push('', 'Showcase prompts:');
  for (const [key, lines] of Object.entries(perShowcase)) report.push(`- ${key}: ${lines.join(' · ')}`);
  const text = report.join('\n');
  console.log(text);
  writeFileSync(`${ROOT}/training/runs/eval-report.md`, text + '\n');
});
