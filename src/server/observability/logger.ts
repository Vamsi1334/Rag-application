import 'server-only';
// Pino and the redaction rules exist to keep sensitive values out of logs;
// this module must never be bundled for the browser.

import pino, { type Logger } from 'pino';

import { isAppError, toAppError } from './errors';
import { safeMeta } from './redaction';
import { getRequestContext } from './request-context';

/**
 * Structured logging.
 *
 * Logs are JSON, one object per line, because the goal is not to read them in
 * a terminal but to search them later: "every error in the retrieval step for
 * this user in the last hour" is a query, not a scroll. For readable output
 * while developing, pipe the dev server through pino-pretty:
 *
 *     npm run dev:pretty
 *
 * This module deliberately reads `process.env` directly instead of importing
 * the validated config. The logger has to work when configuration is broken,
 * because a configuration failure is exactly the thing it needs to report.
 */

// 'silent' is pino's off switch; used by the test runner.
const LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
type Level = (typeof LEVELS)[number];

function resolveLevel(): Level {
  const raw = process.env.LOG_LEVEL;
  return (LEVELS as readonly string[]).includes(raw ?? '') ? (raw as Level) : 'info';
}

export const baseLogger: Logger = pino({
  level: resolveLevel(),
  base: {
    service: 'ai-document-assistant',
    env: process.env.NODE_ENV ?? 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Log the word, not the number. `"level":"error"` is greppable.
    level: (label) => ({ level: label }),
  },
  // A second line of defence behind safeMeta(), in case something is logged
  // without going through the helpers below.
  redact: {
    paths: [
      'password',
      'token',
      'apiKey',
      'api_key',
      'authorization',
      'cookie',
      'secret',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.secret',
      '*.authorization',
    ],
    censor: '[redacted]',
  },
});

/**
 * A logger that already knows which request it belongs to.
 *
 * Reads the request id and user id from AsyncLocalStorage, so nothing has to
 * be threaded through function arguments.
 */
export function getLogger(): Logger {
  const context = getRequestContext();
  if (!context) return baseLogger;

  return baseLogger.child({
    requestId: context.requestId,
    ...(context.userId ? { userId: context.userId } : {}),
  });
}

export interface LogFields {
  /** What was being attempted, e.g. `rag.retrieve` or `document.extract`. */
  operation: string;
  [key: string]: unknown;
}

export function logInfo(fields: LogFields, message: string): void {
  getLogger().info(safeMeta(fields), message);
}

export function logWarn(fields: LogFields, message: string): void {
  getLogger().warn(safeMeta(fields), message);
}

export function logDebug(fields: LogFields, message: string): void {
  getLogger().debug(safeMeta(fields), message);
}

/**
 * Logs a failure with the detail needed to diagnose it.
 *
 * The error's internal `message` and stack are recorded because logs are a
 * trusted destination; the caller-facing `safeMessage` is what the user sees.
 * `logMeta` from the error is merged in and passed through redaction with
 * everything else.
 */
export function logError(error: unknown, fields: LogFields, message?: string): void {
  const appError = toAppError(error);
  const meta = safeMeta({
    ...fields,
    ...appError.logMeta,
    errorType: appError.name,
    errorCode: appError.code,
    statusCode: appError.httpStatus,
    isOperational: appError.isOperational,
  });

  getLogger().error(
    {
      ...meta,
      // pino serializes this into `err` with type, message and stack.
      err: appError,
    },
    message ?? appError.message,
  );
}

/** True when the failure was anticipated, which callers may want to log quieter. */
export function isExpectedFailure(error: unknown): boolean {
  return isAppError(error) && error.isOperational;
}
