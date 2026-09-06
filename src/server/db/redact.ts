/**
 * Connection string redaction.
 *
 * ------------------------------------------------------------
 * Why this file exists, and why it is the first thing in the DB layer
 * ------------------------------------------------------------
 * The MongoDB driver puts the connection string into its own error messages.
 * A failed DNS lookup, a bad password, an IP that is not on the Atlas access
 * list: several of those produce an Error whose `.message` contains
 *
 *     mongodb+srv://appuser:hunter2@cluster0.abcde.mongodb.net/...
 *
 * If that error is logged, or bubbles into a stack trace, or reaches an error
 * tracker, the database password goes with it. This is one of the most common
 * ways production credentials leak, and it happens without anyone writing a
 * single careless log line.
 *
 * So every string that comes out of the driver passes through here first.
 *
 * This is not a substitute for the allowlist in `observability/redaction.ts`;
 * it is a narrower guard for the one case that allowlist cannot catch, because
 * a driver error arrives as a plain message rather than as structured
 * metadata.
 */

/**
 * Matches a MongoDB connection string and captures the credential section.
 *
 * Covers both `mongodb://` and `mongodb+srv://`, with or without a password,
 * and stops at the `@` so the host is left readable for debugging.
 */
const CONNECTION_STRING = /\b(mongodb(?:\+srv)?:\/\/)([^\s/@]+)@/gi;

/** Any bare `user:password@host` that survived without the scheme. */
const BARE_CREDENTIALS = /\b([\w.%+-]+):([^\s:@/]+)@([\w.-]+\.mongodb\.net)/gi;

/**
 * Replaces credentials in any text with a placeholder.
 *
 * The host is deliberately preserved: knowing that the failure was against
 * `cluster0.abcde.mongodb.net` is exactly what makes an error actionable, and
 * a hostname is not a secret. Only the user and password are removed.
 */
export function redactConnectionString(text: string): string {
  return text
    .replace(CONNECTION_STRING, (_match, scheme: string) => `${scheme}[credentials-redacted]@`)
    .replace(BARE_CREDENTIALS, (_match, _user, _pass, host: string) =>
      `[credentials-redacted]@${host}`,
    );
}

/**
 * Pulls a safe message out of anything the driver threw.
 *
 * Returns a generic string for non-Errors rather than stringifying an unknown
 * object, which could itself contain configuration.
 */
export function safeDriverMessage(error: unknown): string {
  if (error instanceof Error) return redactConnectionString(error.message);
  return 'Unknown database error';
}

/**
 * A driver error code, when there is one.
 *
 * Codes such as `MongoServerSelectionError` or `AuthenticationFailed` are safe
 * to log and are the fastest route to a diagnosis.
 */
export function driverErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
