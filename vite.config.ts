import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/; the Pages workflow sets
  // BASE_PATH so local dev and local builds stay at the root.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), sessionLogPlugin()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
