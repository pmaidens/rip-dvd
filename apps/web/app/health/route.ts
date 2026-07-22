import { getDataAccess } from "../../lib/data-access";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] ?? character,
  );
}

function document(content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>rip-dvd service health</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #111827; color: #f9fafb; }
      main { max-width: 48rem; margin: 0 auto; padding: 4rem 1.5rem; }
      .eyebrow, dt { color: #9ca3af; }
      .card { margin-top: 1.5rem; padding: 1.25rem; border: 1px solid #374151; border-radius: .75rem; background: #1f2937; }
      dl { display: grid; grid-template-columns: max-content 1fr; gap: .75rem 1rem; margin: 0; }
      dd { margin: 0; overflow-wrap: anywhere; }
      .ok { color: #86efac; font-weight: 700; }
      .error { color: #fca5a5; font-weight: 700; }
      a { display: inline-block; margin-top: 1rem; color: #fbbf24; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">rip-dvd</p>
      <h1>Service health</h1>
      ${content}
      <a href="/">Back to control plane</a>
    </main>
  </body>
</html>`;
}

export function GET(): Response {
  try {
    const health = getDataAccess().checkHealth();
    return new Response(
      document(`<section class="card" aria-label="Database health">
        <dl>
          <dt>Service</dt><dd class="ok">Healthy</dd>
          <dt>Database</dt><dd class="ok">Connected</dd>
          <dt>SQLite</dt><dd>${escapeHtml(health.sqliteVersion)}</dd>
          <dt>Journal mode</dt><dd>${escapeHtml(health.journalMode.toUpperCase())}</dd>
          <dt>Busy timeout</dt><dd>${health.busyTimeoutMs} ms</dd>
        </dl>
      </section>`),
      { headers: responseHeaders },
    );
  } catch {
    return new Response(
      document(`<section class="card" aria-label="Database health">
        <p class="error">Database unavailable</p>
      </section>`),
      { headers: responseHeaders, status: 503 },
    );
  }
}
