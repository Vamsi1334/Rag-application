import 'server-only';

/**
 * The last sign-in failure, so it can be shown instead of hunted for.
 *
 * ------------------------------------------------------
 * Why this exists
 * ------------------------------------------------------
 * Auth.js knows exactly why a sign-in failed. It prints a line like
 *
 *   [auth][details]: { "error": "invalid_client", ... }
 *
 * to the server terminal, and then hands the browser a single opaque code,
 * `Configuration`, that covers half a dozen unrelated causes. So the answer
 * exists, but it is in a different place from the person reading the error,
 * buried under a stack trace, and gone as soon as the terminal scrolls.
 *
 * This captures that reason and lets the login page show it.
 *
 * ------------------------------------------------------
 * Development only, and deliberately so
 * ------------------------------------------------------
 * `/login` is public and unauthenticated. Telling a stranger that your client
 * secret is wrong, or that your database is unreachable, maps your
 * deployment's weak points for them. In production this module records
 * nothing at all, and the page falls back to the generic sentence.
 *
 * It is also a single shared value, not per session. That is fine for one
 * developer on localhost and would be wrong anywhere else, which is the same
 * reason it is switched off in production.
 *
 * ------------------------------------------------------
 * Why the value lives on globalThis
 * ------------------------------------------------------
 * A plain module-level `let` does not work here, and the reason is worth
 * knowing because it is not obvious.
 *
 * The failure is recorded by the auth route handler and read by the login
 * page. Those are two different routes, and Next.js bundles routes
 * separately: each can get its OWN instance of this module. The write lands
 * in one copy, the read looks at another, and the page shows nothing while
 * the terminal proves the error happened. Hot reload re-evaluating modules
 * makes it worse again.
 *
 * `globalThis` is per process rather than per bundle, so both routes see the
 * same value. This is the same reason `src/server/db/client.ts` caches the
 * MongoDB client there.
 */

const ENABLED = process.env.NODE_ENV !== 'production';

/** Values that must never be echoed, even into a development-only page. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Google client secrets.
  /GOCSPX-[\w-]+/g,
  // Connection strings, which carry a password in the authority section.
  /mongodb(\+srv)?:\/\/\S+/gi,
  // Bearer tokens and long opaque credentials.
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

function redactSecretish(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, '[redacted]'),
    text,
  );
}

export interface AuthFailure {
  /** e.g. "CallbackRouteError". */
  name: string;
  /** e.g. "invalid_client: The provided client secret is invalid." */
  detail: string;
  at: string;
}

declare global {
  var __lastAuthFailure: AuthFailure | null | undefined;
}

/**
 * Pulls the useful sentence out of whatever Auth.js threw.
 *
 * Auth.js wraps the real cause one or two levels down: a CallbackRouteError
 * carries `cause.err`, and for an OAuth token-endpoint rejection that inner
 * error holds the provider's own `error` and `error_description`. Those two
 * fields are the entire diagnosis, and they are what this digs out.
 */
function describe(error: unknown): AuthFailure {
  const outer = error as { name?: string; message?: string; cause?: unknown };

  const cause = outer?.cause as { err?: unknown } | undefined;
  const inner = (cause?.err ?? outer?.cause ?? {}) as {
    error?: unknown;
    error_description?: unknown;
    message?: unknown;
  };

  const parts: string[] = [];
  if (typeof inner.error === 'string') parts.push(inner.error);
  if (typeof inner.error_description === 'string') parts.push(inner.error_description);
  else if (typeof inner.message === 'string') parts.push(inner.message);
  else if (typeof outer?.message === 'string') parts.push(outer.message);

  return {
    name: typeof outer?.name === 'string' ? outer.name : 'Error',
    // Capped: a stack trace pasted into a page helps nobody.
    detail: redactSecretish(parts.join(': ')).slice(0, 400),
    at: new Date().toISOString(),
  };
}

export function recordAuthFailure(error: unknown): void {
  if (!ENABLED) return;
  globalThis.__lastAuthFailure = describe(error);
}

/** The last failure, or null in production and before anything has failed. */
export function getLastAuthFailure(): AuthFailure | null {
  return ENABLED ? (globalThis.__lastAuthFailure ?? null) : null;
}

/** Cleared on a successful sign-in, so a stale reason is never shown. */
export function clearAuthFailure(): void {
  globalThis.__lastAuthFailure = null;
}
