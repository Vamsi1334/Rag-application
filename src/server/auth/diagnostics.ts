import 'server-only';

import { getServerEnv } from '@/server/config/env';
import { isAppError } from '@/server/observability/errors';

/**
 * Why sign-in is not configured.
 *
 * ------------------------------------------------------
 * The problem this file exists to solve
 * ------------------------------------------------------
 * Auth.js reports every configuration failure as one error code,
 * `Configuration`, and our login page turns that into one sentence. But there
 * are four separate ways to get it:
 *
 *   1. AUTH_SECRET missing, or shorter than 32 characters
 *   2. GOOGLE_CLIENT_ID missing
 *   3. GOOGLE_CLIENT_SECRET missing
 *   4. MONGODB_URI missing, because sessions live in the database, so the
 *      adapter cannot be built without it
 *
 * All four produce the identical message, which leaves you rereading working
 * code. This narrows it to the variable actually at fault.
 *
 * ------------------------------------------------------
 * What it reports, and what it never reports
 * ------------------------------------------------------
 * VARIABLE NAMES ONLY. Never a value, never a prefix, never a length, never a
 * masked fragment. A name is not a secret; anything derived from a value is.
 *
 * The caller decides whether to show it. `/login` is public and unauthenticated,
 * so it renders this in development only: telling a stranger which variables a
 * deployment is missing is free reconnaissance.
 */

/** The variables sign-in genuinely cannot start without. */
const REQUIRED: ReadonlyArray<{ name: string; why: string }> = [
  { name: 'AUTH_SECRET', why: 'signs the session cookie, minimum 32 characters' },
  { name: 'GOOGLE_CLIENT_ID', why: 'from Google Cloud Console, OAuth client ID' },
  { name: 'GOOGLE_CLIENT_SECRET', why: 'from the same OAuth client' },
  { name: 'MONGODB_URI', why: 'sessions are stored in the database' },
];

export interface AuthConfigDiagnosis {
  ok: boolean;
  /** Names of variables that are missing. Never values. */
  missing: ReadonlyArray<{ name: string; why: string }>;
  /**
   * Set when the environment could not be parsed at all, which is a different
   * failure: a variable is present but invalid, so nothing downstream runs.
   */
  parseError: string | null;
}

export function diagnoseAuthConfig(): AuthConfigDiagnosis {
  let env: ReturnType<typeof getServerEnv>;

  try {
    env = getServerEnv();
  } catch (error) {
    // A whole-environment parse failure. The safe message names which
    // variables failed validation without echoing what they contained; that
    // formatting already exists in `formatEnvIssues`.
    return {
      ok: false,
      missing: [],
      parseError: isAppError(error)
        ? error.message
        : 'The environment could not be parsed.',
    };
  }

  const present: Record<string, boolean> = {
    // The schema already enforces the 32-character minimum, so reaching here
    // with a short value is impossible; an absent one is the live case.
    AUTH_SECRET: Boolean(env.AUTH_SECRET),
    GOOGLE_CLIENT_ID: Boolean(env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: Boolean(env.GOOGLE_CLIENT_SECRET),
    MONGODB_URI: Boolean(env.MONGODB_URI),
  };

  const missing = REQUIRED.filter((variable) => !present[variable.name]);

  return { ok: missing.length === 0, missing, parseError: null };
}
