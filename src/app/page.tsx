import { APP_NAME, APP_VERSION } from '@/lib/constants';
import { buildHealthReport, type CheckStatus } from '@/server/health/report';

/**
 * Home page.
 *
 * A Server Component, which is why it can call `buildHealthReport()` directly
 * instead of fetching its own API. No data crosses the network and no secret
 * is ever serialized to the browser: only the finished status words below are
 * sent.
 *
 * It doubles as a build tracker while the application takes shape.
 */

export const dynamic = 'force-dynamic';

const STATUS_STYLES: Record<CheckStatus, string> = {
  ok: 'bg-accent-soft text-accent',
  not_implemented: 'bg-warn-soft text-warn',
  not_configured: 'bg-canvas text-muted border border-line',
  error: 'bg-danger-soft text-danger',
};

const STATUS_LABELS: Record<CheckStatus, string> = {
  ok: 'ready',
  not_implemented: 'configured',
  not_configured: 'not set',
  error: 'error',
};

const ROADMAP = [
  { phase: 1, name: 'Project setup', done: true },
  { phase: 2, name: 'Database and tenant isolation', done: true },
  { phase: 3, name: 'Local LLM via Ollama', done: true },
  { phase: 4, name: 'Authentication with Google', done: true },
  { phase: 5, name: 'Embeddings and first retrieval loop', done: false },
];

export default function HomePage() {
  const report = buildHealthReport();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="border-b border-line pb-8">
        <div className="flex items-center gap-3">
          <span
            className="inline-block size-2 rounded-full bg-accent"
            aria-hidden="true"
          />
          <span className="font-mono text-xs uppercase tracking-widest text-accent">
            Running
          </span>
        </div>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance">{APP_NAME}</h1>
        <p className="mt-3 max-w-xl leading-relaxed text-ink-soft">
          Upload your documents, ask questions about them, and get answers that cite the exact
          passages they came from.
        </p>
        <p className="mt-4 font-mono text-xs text-muted">
          v{APP_VERSION} &middot; phase {report.phase}: {report.phaseName} &middot; node{' '}
          {report.runtime.node} &middot; {report.runtime.environment}
        </p>
      </header>

      <section className="mt-10">
        <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
          Subsystem status
        </h2>
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {Object.entries(report.checks).map(([name, check]) => (
            <li key={name} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:gap-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{name}</span>
                <span className="mt-1 text-sm leading-relaxed text-muted">{check.detail}</span>
              </div>
              <span
                className={`shrink-0 self-start rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${STATUS_STYLES[check.status]}`}
              >
                {STATUS_LABELS[check.status]}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">
          <a className="text-accent underline underline-offset-2" href="/login">
            Sign in
          </a>{' '}
          &middot;{' '}
          <a className="text-accent underline underline-offset-2" href="/ai-test">
            try the model
          </a>{' '}
          &middot; the same report as JSON:{' '}
          <a
            className="text-accent underline underline-offset-2"
            href="/api/health"
            target="_blank"
            rel="noreferrer"
          >
            /api/health
          </a>
        </p>
      </section>

      <section className="mt-10">
        <h2 className="font-mono text-xs uppercase tracking-widest text-muted">Build progress</h2>
        <ol className="mt-4 space-y-2">
          {ROADMAP.map((item) => (
            <li key={item.phase} className="flex items-baseline gap-3 text-sm">
              <span className="font-mono text-xs text-muted tabular-nums">
                {String(item.phase).padStart(2, '0')}
              </span>
              <span className={item.done ? 'text-ink' : 'text-muted'}>{item.name}</span>
              {item.done ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
                  done
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
