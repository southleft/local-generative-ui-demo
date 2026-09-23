import { appendFileSync, createReadStream, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Session forensics: the app POSTs every generation run (successes, failures,
 * and user-flagged examples) to /__session-log, and this middleware appends
 * them as NDJSON to sessions/generation-log.ndjson — a file on disk that an
 * agent (or a human) can read to assess what actually happened in the browser.
 * Dev-server only; the file is gitignored.
 */
function sessionLogPlugin(): Plugin {
  const logDir = join(process.cwd(), 'sessions');
  const logFile = join(logDir, 'generation-log.ndjson');
  return {
    name: 'session-log',
    configureServer(server) {
      server.middlewares.use('/__session-log', (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            if (body.length < 4_000_000) body += chunk;
          });
          req.on('end', () => {
            try {
              const record = JSON.parse(body);
              mkdirSync(logDir, { recursive: true });
              appendFileSync(logFile, `${JSON.stringify({ loggedAt: new Date().toISOString(), port: server.config.server.port ?? null, ...record })}\n`);
              res.statusCode = 204;
            } catch {
              res.statusCode = 400;
            }
            res.end();
          });
          return;
        }
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/x-ndjson');
          res.end(existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/**
 * Serves the catalog-tuned artifact (a 2.14 GB standard .litertlm produced by
 * training/scripts, gitignored) at /models/gemma-4-e2b-catalog-int8.litertlm
 * with Content-Length and Range support, so the loader can size its heap
 * block and Cache Storage can keep it. Dev-server only, and only used when
 * VITE_TUNED_MODEL_URL points here; by default the app loads the Hub copy.
 */
function tunedModelPlugin(): Plugin {
  const route = '/models/gemma-4-e2b-catalog-int8.litertlm';
  const file = resolve(process.cwd(), process.env.TUNED_MODEL_PATH ?? 'training/runs/release/gemma-4-e2b-catalog-int8.litertlm');
  return {
    name: 'tuned-model',
    configureServer(server) {
      server.middlewares.use(route, (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain');
          res.end(`The catalog-tuned artifact is not on this machine (expected ${file}). See docs/fine-tuning-feasibility.md.`);
          return;
        }
        const size = statSync(file).size;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('accept-ranges', 'bytes');
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        let start = 0;
        let end = size - 1;
        if (range && (range[1] || range[2])) {
          start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
        }
        res.setHeader('content-length', String(end - start + 1));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/; the Pages workflow sets
  // BASE_PATH so local dev and local builds stay at the root.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), sessionLogPlugin(), tunedModelPlugin()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // The training pipeline's test-shaped scripts write files under training/; run them with training/vitest.config.ts.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
