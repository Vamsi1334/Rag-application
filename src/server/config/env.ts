import 'server-only';

import { ConfigurationError } from '@/server/observability/errors';
import { formatEnvIssues, serverEnvSchema, type ServerEnv } from './env.schema';

/**
 * Server-side configuration.
 *
 * The `import 'server-only'` on the first line is the guard that makes the
 * secret boundary real. If a client component ever imports this file, even
 * indirectly, the build fails with an explicit error instead of quietly
 * shipping your MongoDB password to the browser.
 *
 * Parsing is memoized rather than run at import time so that importing this
 * module is always safe; the first caller pays for validation.
 */
let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigurationError(formatEnvIssues(parsed.error), {
      variables: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }

  cached = parsed.data;
  return cached;
}

/**
 * Reads a variable that a feature genuinely cannot run without.
 *
 * Variables for unbuilt features are optional in the schema, so this is how a
 * feature states its own requirement at the moment it needs it. The thrown
 * error names the variable and the feature, which is the difference between a
 * five second fix and a confusing `undefined` three call frames later.
 */
export function requireEnv<K extends keyof ServerEnv>(
  key: K,
  feature: string,
): NonNullable<ServerEnv[K]> {
  const value = getServerEnv()[key];
  if (value === undefined || value === null || value === '') {
    throw new ConfigurationError(
      `${String(key)} is required for ${feature} but is not set. Add it to .env.local.`,
      { variable: String(key), feature },
    );
  }
  return value as NonNullable<ServerEnv[K]>;
}

/** Called once at server startup so misconfiguration fails immediately. */
export function assertServerEnv(): void {
  getServerEnv();
}

/** Test helper. Clears the memoized value so a test can change process.env. */
export function resetServerEnvCache(): void {
  cached = null;
}
