/**
 * Runs once when the server starts, before it handles any request.
 *
 * Next.js calls the exported `register` function automatically. It is the
 * right place to fail fast: a missing or malformed environment variable should
 * stop the server at boot with a clear message, not surface as a confusing
 * `undefined` during someone's first request.
 *
 * When error monitoring is added, its initialization goes here too.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime has the config and logging modules.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertServerEnv } = await import('@/server/config/env');
  const { baseLogger } = await import('@/server/observability/logger');
  const { APP_NAME, APP_VERSION, CURRENT_PHASE } = await import('@/lib/constants');

  try {
    assertServerEnv();

    // Indexes are created at startup in development so a fresh clone is
    // usable immediately. In production this belongs in the deploy pipeline:
    // building an index on a large collection while requests are arriving is
    // not something that should happen implicitly on boot.
    const { getServerEnv } = await import('@/server/config/env');
    const env = getServerEnv();
    if (env.NODE_ENV !== 'production' && env.MONGODB_URI) {
      const { ensureIndexesSafely } = await import('@/server/db/indexes');
      await ensureIndexesSafely();
    }
    baseLogger.info(
      { operation: 'server.start', version: APP_VERSION, phase: CURRENT_PHASE },
      `${APP_NAME} started`,
    );
  } catch (error) {
    const { logError } = await import('@/server/observability/logger');
    logError(error, { operation: 'server.start' }, 'Startup configuration check failed');
    throw error;
  }
}
