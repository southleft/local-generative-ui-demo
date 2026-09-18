// End-to-end check of the hosted site through the real UI: choose LiteRT, pick the catalog-tuned
// model, load it from the Hub, run a spark prompt, and record what rendered. Fresh extension-free
// Chrome with WebGPU. Usage: node e2e-hosted.mjs <site url> <out dir>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
// playwright-core: from node_modules, or from a directory named in PLAYWRIGHT_CORE (e.g. an npx cache copy).
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const [site, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--enable-features=WebGPU', '--disable-extensions', '--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !/INFO:|WARNING:|litert_lm|environment.cc|registry/.test(m.text())) errors.push(m.text().slice(0, 200)); });
const t0 = Date.now();
const stamp = () => `${Math.round((Date.now() - t0) / 1000)}s`;
await page.goto(site, { waitUntil: 'load', timeout: 60000 });
await page.getByRole('button', { name: /^LiteRT$/ }).click();
const select = page.getByRole('combobox', { name: /litert model/i });
const options = await select.locator('option').evaluateAll((els) => els.map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled })));
console.log(stamp(), 'model options:', JSON.stringify(options));
await select.selectOption('gemma-4-e2b-catalog');
const card = await page.locator('.model-card__head').innerText().catch(() => '(no model card)');
console.log(stamp(), 'model card:', card.replace(/\s+/g, ' ').slice(0, 200));
await page.getByRole('button', { name: /load gemma 4 e2b · catalog-tuned locally/i }).click();
console.log(stamp(), 'load clicked; waiting for the download and compile…');
await page.getByText(/catalog-tuned loaded in this browser/i).waitFor({ timeout: 20 * 60 * 1000 });
console.log(stamp(), 'model loaded');
await page.getByRole('button', { name: /sourdough control/i }).click();
const request = await page.locator('#request').inputValue();
await page.getByRole('button', { name: /^Generate$/ }).click();
console.log(stamp(), 'generating:', request.slice(0, 80));
await page.locator('#request:disabled').waitFor({ timeout: 30000 }).catch(() => {});
await page.locator('#request:not([disabled])').waitFor({ timeout: 5 * 60 * 1000 });
const done = stamp();
const body = await page.locator('body').innerText();
const lines = body.split('\n').map((l) => l.trim()).filter((l) => /nodes|adjust|rendered|attempt|salvage|repair|Recover|conversation|LiteRT/i.test(l)).slice(0, 25);
await page.screenshot({ path: `${outDir}/hosted-e2e.png`, fullPage: true });
const result = { site, done, request, statusLines: lines, errors, url: page.url() };
writeFileSync(`${outDir}/hosted-e2e.json`, JSON.stringify(result, null, 1));
console.log(done, 'generation finished; status lines:', JSON.stringify(lines.slice(0, 12)));
if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 5)));
await browser.close();
