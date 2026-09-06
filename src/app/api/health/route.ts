import { buildHealthReport } from '@/server/health/report';
import { createRoute, json } from '@/server/http/route';

/**
 * GET /api/health
 *
 * Reports whether the application is running and which subsystems are wired
 * up. Used as a smoke test locally and, later, as the readiness probe the
 * hosting platform calls after a deploy.
 */

// pino, AsyncLocalStorage and (later) the MongoDB driver all need Node APIs
// that the Edge runtime does not provide.
export const runtime = 'nodejs';

// Never cached: a cached health check reports the state of a past deployment.
export const dynamic = 'force-dynamic';

export const GET = createRoute('health.check', async () => {
  const report = buildHealthReport();
  return json(report, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
});
