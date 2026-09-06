import 'server-only';

import { MongoClient, type Db } from 'mongodb';

import { getServerEnv, requireEnv } from '@/server/config/env';
import { ExternalServiceError } from '@/server/observability/errors';
import { logInfo, logWarn } from '@/server/observability/logger';
import { driverErrorName, safeDriverMessage } from './redact';

/**
 * The MongoDB connection.
 *
 * ------------------------------------------------
 * CONCEPT: why the client is cached on globalThis
 * ------------------------------------------------
 * A `MongoClient` is not a connection, it is a connection POOL. Creating one
 * is expensive: DNS resolution for the SRV record, a TLS handshake, and a
 * server-selection round trip before the first query runs. It is meant to be
 * created once and shared for the lifetime of the process.
 *
 * Two things make that harder than it sounds in Next.js.
 *
 * In development, hot reload re-evaluates modules on every file save. A client
 * held in a module-level variable would be recreated each time, and the old
 * pools are never closed, so after an afternoon of editing you have dozens of
 * live pools and Atlas starts refusing connections. Caching on `globalThis`
 * survives module re-evaluation, so there is exactly one pool no matter how
 * many times the module reloads.
 *
 * In production, each serverless instance gets its own module scope, so the
 * cache is per-instance. That is correct: instances are separate processes.
 * What matters is that one instance never opens a pool per request, which is
 * what this prevents.
 *
 * The promise, not the client, is what gets cached. Two requests arriving
 * before the first connection completes then await the same promise instead of
 * racing to create two clients.
 */

declare global {
  var __mongoClientPromise: Promise<MongoClient> | undefined;
}

/**
 * Fails fast rather than hanging.
 *
 * The driver's default server-selection timeout is 30 seconds. On a serverless
 * platform that means a request sits burning execution time before anyone
 * learns the database is unreachable. Ten seconds is long enough for a cold
 * Atlas cluster to wake and short enough to surface a real outage quickly.
 */
const CLIENT_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  retryWrites: true,
} as const;

function createClientPromise(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, CLIENT_OPTIONS);

  return client.connect().catch((error: unknown) => {
    // Clear the cache so the next request retries instead of awaiting a
    // permanently rejected promise for the life of the process.
    globalThis.__mongoClientPromise = undefined;

    // safeDriverMessage strips credentials: the driver puts the full
    // connection string in several of its error messages.
    throw new ExternalServiceError(
      `MongoDB connection failed: ${safeDriverMessage(error)}`,
      { operation: 'db.connect', errorType: driverErrorName(error) },
      error,
    );
  });
}

export function getMongoClient(): Promise<MongoClient> {
  if (!globalThis.__mongoClientPromise) {
    const uri = requireEnv('MONGODB_URI', 'the database');
    const pending = createClientPromise(uri);

    /**
     * Marks the cached promise as handled.
     *
     * This is not swallowing the error. Callers still `await` this promise and
     * still get the rejection; the empty catch exists only so Node does not
     * see a promise that was created and rejected with no handler attached.
     *
     * Without it, an unreachable cluster produces a wall of
     * `unhandledRejection` traces on every request, because the promise is
     * cached at creation but not awaited until something actually needs the
     * database. The traces bury the one line that says what is wrong, and
     * Node can be configured to terminate the process on them.
     */
    pending.catch(() => {});

    globalThis.__mongoClientPromise = pending;
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getServerEnv().MONGODB_DB_NAME);
}

/** True when a connection string is configured. Used by the health report. */
export function isDatabaseConfigured(): boolean {
  return Boolean(getServerEnv().MONGODB_URI);
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
}

/**
 * Round-trips a trivial command to prove the database is actually reachable.
 *
 * `getDb()` alone is not proof: the driver connects lazily and a client can
 * exist while the cluster is unreachable. A health check that only constructed
 * the client would report healthy during an outage.
 */
export async function pingDatabase(): Promise<PingResult> {
  const startedAt = Date.now();
  const db = await getDb();
  await db.command({ ping: 1 });
  return { ok: true, latencyMs: Date.now() - startedAt };
}

/**
 * Closes the pool.
 *
 * Only for tests and scripts. Never call this from a request handler: the pool
 * is shared, so closing it breaks every other in-flight request.
 */
export async function closeMongoClient(): Promise<void> {
  const pending = globalThis.__mongoClientPromise;
  if (!pending) return;

  globalThis.__mongoClientPromise = undefined;
  try {
    const client = await pending;
    await client.close();
    logInfo({ operation: 'db.close' }, 'MongoDB connection closed');
  } catch (error) {
    logWarn(
      { operation: 'db.close', errorType: driverErrorName(error) },
      `Error closing MongoDB connection: ${safeDriverMessage(error)}`,
    );
  }
}
