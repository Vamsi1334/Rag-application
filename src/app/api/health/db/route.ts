import { isDatabaseConfigured, pingDatabase } from '@/server/db/client';
import { driverErrorName, safeDriverMessage } from '@/server/db/redact';
import { createRoute, json } from '@/server/http/route';
import { logError, logInfo } from '@/server/observability/logger';
import { getRequestId } from '@/server/observability/request-context';

/**
 * GET /api/health/db
 *
 * Proves the database is actually reachable, as opposed to merely configured.
 *
 * ------------------------------------------------------
 * What this endpoint deliberately does not tell you
 * ------------------------------------------------------
 * No connection string, no username, no cluster hostname, no database name, no
 * driver error text. It is unauthenticated, so anything it returns is public,
 * and the raw MongoDB error for a failed connection frequently contains the
 * full connection string including the password.
 *
 * What a caller gets is a status word and a round-trip time. What an operator
 * gets is the same, plus a request id that ties it to a log line carrying the
 * redacted detail. That split is the point: enough to act on, nothing to
 * exploit.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DbStatus = 'ok' | 'unavailable' | 'not_configured';

interface DbHealthBody {
  status: DbStatus;
  detail: string;
  latencyMs: number | null;
  requestId: string;
  timestamp: string;
}

function body(status: DbStatus, detail: string, latencyMs: number | null): DbHealthBody {
  return {
    status,
    detail,
    latencyMs,
    requestId: getRequestId(),
    timestamp: new Date().toISOString(),
  };
}

export const GET = createRoute('health.db', async () => {
  if (!isDatabaseConfigured()) {
    // 503, not 500: nothing has gone wrong, the feature is simply not set up.
    // A monitor should treat this as "not ready", not as a crash.
    return json(
      body('not_configured', 'MONGODB_URI is not set.', null),
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    const { latencyMs } = await pingDatabase();

    logInfo({ operation: 'db.ping', status: 'ok', durationMs: latencyMs }, 'Database reachable');

    return json(body('ok', 'Database connection is healthy.', latencyMs), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    // The redacted message goes to the log, correlated by request id.
    // The caller gets none of it.
    logError(error, { operation: 'db.ping', errorType: driverErrorName(error) },
      `Database ping failed: ${safeDriverMessage(error)}`);

    return json(
      body('unavailable', 'Database is not reachable. See server logs for detail.', null),
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
});
