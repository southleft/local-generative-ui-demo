/**
 * Fire-and-forget browser-session forensics. Run outcomes and user flags are
 * posted to the dev server without affecting generation or rendering. Only the
 * Vite dev server answers /__session-log, so a production build (for example
 * the GitHub Pages deployment) skips the request entirely.
 */

export function postSessionLog(record: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  try {
    void fetch('/__session-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => undefined);
  } catch {
    // The session log is diagnostic only.
  }
}
