import Link from "next/link";

import { getDataAccess } from "../../lib/data-access";

export const dynamic = "force-dynamic";

export default function HealthPage() {
  try {
    const health = getDataAccess().checkHealth();

    return (
      <main>
        <p className="eyebrow">rip-dvd</p>
        <h1>Service health</h1>
        <section className="health-card" aria-label="Database health">
          <dl>
            <dt>Service</dt>
            <dd className="health-ok">Healthy</dd>
            <dt>Database</dt>
            <dd className="health-ok">Connected</dd>
            <dt>SQLite</dt>
            <dd>{health.sqliteVersion}</dd>
            <dt>Journal mode</dt>
            <dd>{health.journalMode.toUpperCase()}</dd>
            <dt>Busy timeout</dt>
            <dd>{health.busyTimeoutMs} ms</dd>
          </dl>
        </section>
        <p>
          <Link className="health-link" href="/">
            Back to control plane
          </Link>
        </p>
      </main>
    );
  } catch {
    return (
      <main>
        <p className="eyebrow">rip-dvd</p>
        <h1>Service health</h1>
        <section className="health-card" aria-label="Database health">
          <p className="health-error">Database unavailable</p>
        </section>
      </main>
    );
  }
}
