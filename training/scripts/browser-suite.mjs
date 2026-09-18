// Standalone runner: fresh Chrome (own profile, no extensions) -> load a .litertlm through the
// app's heap-resident loader on WebGPU, run the app prompt + guardrail over held-out prompts.
// Usage: node browser-suite.mjs <model url> <ids csv | eval> <out json> [headed]
// Also writes <out json>.jsonl with {id, request, output, seconds} rows for training/scripts/eval-replay.test.ts.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
// playwright-core: from node_modules, or from a directory named in PLAYWRIGHT_CORE (e.g. an npx cache copy).
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const [modelUrl, idsCsv, outPath, headed] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: headed !== 'headed',
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--enable-features=WebGPU', '--disable-extensions', '--no-first-run'],
});
const page = await browser.newPage();
const quiet = ['litert_lm_loader', 'engine_settings.cc', 'accelerator_registry', 'environment.cc', 'delegate_', 'model_resources', 'compiled_model.cc', 'gpu_', 'npu_registry', 'cpu_registry'];
let consoleCount = 0;
page.on('console', (m) => { consoleCount += 1; const t = m.text(); if (quiet.some((q) => t.includes(q))) return; if (m.type() === 'error' || t.includes('ABORTED') || t.includes('Aborted')) console.log('[page]', t.slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto('http://localhost:5174/', { waitUntil: 'load', timeout: 60000 });
const adapter = await page.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); if (!a) return null; const i = a.info || {}; return { vendor: i.vendor, architecture: i.architecture, maxBufferSize: a.limits.maxBufferSize }; });
console.log('adapter:', JSON.stringify(adapter));
if (!adapter) { await browser.close(); process.exit(2); }
const t0 = Date.now();
await page.evaluate(async ({ modelUrl, ids }) => {
  window.__suite = undefined; window.__vfsProbe = undefined;
  const m = await import('/src/vfs-backend-probe.ts');
  m.runSuite(modelUrl, ids);
}, { modelUrl, ids: idsCsv.split(',') });
let last = '';
while (Date.now() - t0 < 90 * 60 * 1000) {
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => { const s = window.__suite; const p = window.__vfsProbe; return { stage: s?.stage, load: p && { stage: p.stage, loadSeconds: p.loadSeconds, generateSeconds: p.generateSeconds, output: p.output, error: p.error, heap: p.wasmHeapBytes }, entries: s?.entries ?? [] }; });
  const line = JSON.stringify({ stage: s.stage, load: s.load?.stage, done: s.entries.filter((e) => e.nodes !== undefined || e.error).length, last: s.entries.slice(-1).map((e) => `${e.id}:${e.nodes ?? e.error ?? '…'}`)[0] });
  if (line !== last) { console.log(Math.round((Date.now() - t0) / 1000) + 's', line); last = line; }
  if (s.stage === 'done' || s.stage === 'failed' || (s.load && s.load.stage === 'failed')) {
    writeFileSync(outPath, JSON.stringify(s, null, 1));
    writeFileSync(outPath.replace(/\.json$/, '') + '.jsonl', s.entries.filter((e) => typeof e.raw === 'string').map((e) => JSON.stringify({ id: e.id, request: e.request, output: e.raw, seconds: e.seconds })).join('\n') + '\n');
    console.log('RESULT', JSON.stringify({ load: s.load, entries: s.entries.map((e) => ({ id: e.id, seconds: e.seconds, validJson: e.validJson, strict: e.strict, adjustments: e.adjustments, nodes: e.nodes, error: e.error })) }));
    break;
  }
}
console.log('console messages seen:', consoleCount);
await browser.close();
