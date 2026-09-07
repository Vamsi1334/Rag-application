/**
 * The error taxonomy.
 *
 * Every failure the application can produce gets a class here. That buys three
 * things a bare `throw new Error('something went wrong')` cannot:
 *
 *   1. A stable `code` the frontend can branch on without parsing English.
 *   2. A split between the message shown to the user (`safeMessage`) and the
 *      detail kept for the logs (`message` and `logMeta`). Internal detail is
 *      exactly what an attacker wants and exactly what a user cannot act on.
 *   3. A correct HTTP status without every route handler deciding for itself.
 *
 * The full monitoring integration comes later. This is the structure it will
 * plug into.
 */

export const ERROR_CODES = [
  'CONFIGURATION_ERROR',
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'EXTERNAL_SERVICE_ERROR',
  // The model layer gets its own codes rather than one generic upstream
  // error, because the frontend genuinely needs to react differently: a
  // missing model is fixed by pulling it, an unreachable service by starting
  // it, and a timeout by asking something shorter.
  'LLM_UNAVAILABLE',
  'LLM_MODEL_NOT_FOUND',
  'LLM_TIMEOUT',
  'LLM_INVALID_RESPONSE',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorOptions {
  /** Detail for the logs. May be specific. Never sent to the client. */
  message: string;
  /** Extra context for the logs. Passed through redaction before it is written. */
  logMeta?: Record<string, unknown>;
  /** The original failure, when this error wraps one. */
  cause?: unknown;
}

export class AppError extends Error {
  /** Stable class name, safe from minification. Overridden by each subclass. */
  static readonly errorName: string = 'AppError';

  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Safe to show a user: no internals, no identifiers, no values. */
  readonly safeMessage: string;
  readonly logMeta: Readonly<Record<string, unknown>>;
  /**
   * True for failures we anticipated and handled. False would mean a genuine
   * bug. Monitoring can use this to separate noise from real alerts.
   */
  readonly isOperational: boolean = true;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    safeMessage: string,
    options: AppErrorOptions,
  ) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    // Set explicitly rather than from `new.target.name`. The production build
    // minifies class names, so the constructor name becomes '' and every log
    // line loses its `errorType`. A string literal survives minification.
    this.name = new.target.errorName ?? 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.safeMessage = safeMessage;
    this.logMeta = Object.freeze({ ...options.logMeta });
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * A required setting is missing or malformed. Almost always a deployment problem.
 *
 * `safeMessage` is optional and defaults to the generic sentence, for the same
 * reason it is optional on ValidationError: naming the specific setting usually
 * tells an attacker about the deployment and tells the user nothing they can
 * act on.
 *
 * The exception is a failure the person reading it can actually fix, where
 * saying so names no secret. "Document search is unavailable, the index is
 * missing or still building" is one: it points at a real, fixable state without
 * exposing a variable, a value or a host.
 */
export class ConfigurationError extends AppError {
  static override readonly errorName = 'ConfigurationError';

  constructor(
    message: string,
    logMeta?: Record<string, unknown>,
    safeMessage = 'The server is not configured correctly.',
  ) {
    super('CONFIGURATION_ERROR', 500, safeMessage, {
      message,
      ...(logMeta ? { logMeta } : {}),
    });
  }
}

/**
 * The request body, query or params did not match the expected schema.
 *
 * `safeMessage` is optional and defaults to the generic sentence, which is the
 * right answer when the specific reason would tell an attacker something: which
 * field exists, what a value was compared against, how a check is implemented.
 *
 * Some validation failures are not like that. "No extractable text found; the
 * PDF appears to be scanned" reveals nothing except a fact about the file the
 * caller just supplied, and it is the difference between a person fixing the
 * problem in a minute and a person reading server logs. Those pass their own
 * message. The default stays generic so the safe choice is the one you get by
 * doing nothing.
 */
export class ValidationError extends AppError {
  static override readonly errorName = 'ValidationError';

  constructor(
    message: string,
    logMeta?: Record<string, unknown>,
    safeMessage = 'The request was not valid.',
  ) {
    super('VALIDATION_ERROR', 400, safeMessage, {
      message,
      ...(logMeta ? { logMeta } : {}),
    });
  }
}

/** No valid session. */
export class UnauthorizedError extends AppError {
  static override readonly errorName = 'UnauthorizedError';

  constructor(message = 'No authenticated user', logMeta?: Record<string, unknown>) {
    super('UNAUTHORIZED', 401, 'You need to sign in to do that.', {
      message,
      ...(logMeta ? { logMeta } : {}),
    });
  }
}

/**
 * Authenticated, but the resource belongs to someone else.
 *
 * Note that the data layer will usually raise NotFoundError instead of this
 * one for another user's records. Saying "forbidden" confirms the resource
 * exists, which leaks information; "not found" does not.
 */
export class ForbiddenError extends AppError {
  static override readonly errorName = 'ForbiddenError';

  constructor(message = 'Access denied', logMeta?: Record<string, unknown>) {
    super('FORBIDDEN', 403, 'You do not have access to that.', {
      message,
      ...(logMeta ? { logMeta } : {}),
    });
  }
}

export class NotFoundError extends AppError {
  static override readonly errorName = 'NotFoundError';

  constructor(message = 'Resource not found', logMeta?: Record<string, unknown>) {
    super('NOT_FOUND', 404, 'That was not found.', {
      message,
      ...(logMeta ? { logMeta } : {}),
    });
  }
}

export class RateLimitError extends AppError {
  static override readonly errorName = 'RateLimitError';

  constructor(message = 'Rate limit exceeded', logMeta?: Record<string, unknown>) {
    super('RATE_LIMITED', 429, 'Too many requests. Please wait a moment and try again.', {
      message,
      ...(logMeta ? { logMeta } : {}),
    });
  }
}

/** A provider, database or third-party API failed. */
export class ExternalServiceError extends AppError {
  static override readonly errorName = 'ExternalServiceError';

  constructor(message: string, logMeta?: Record<string, unknown>, cause?: unknown) {
    super('EXTERNAL_SERVICE_ERROR', 502, 'An upstream service is unavailable.', {
      message,
      ...(logMeta ? { logMeta } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** A configured feature exists in the design but has not been built yet. */
export class NotImplementedError extends AppError {
  static override readonly errorName = 'NotImplementedError';

  constructor(message: string, logMeta?: Record<string, unknown>) {
    super('NOT_IMPLEMENTED', 501, 'That feature is not available yet.', {
      message,
      ...(logMeta ? { logMeta } : {}),
    });
  }
}

/**
 * A failure from a model provider.
 *
 * Carries its own safe message because the useful thing to tell someone
 * differs per case, and the generic "an upstream service is unavailable" hides
 * the one fact that would let them fix it.
 *
 * What it never carries is the provider's own error text. Ollama's messages
 * are harmless, but a hosted provider's can contain request ids, account
 * identifiers or fragments of the prompt, and the mapping has to be safe for
 * every provider we will add rather than the one we have.
 */
export class LLMError extends AppError {
  static override readonly errorName = 'LLMError';

  constructor(
    code: 'LLM_UNAVAILABLE' | 'LLM_MODEL_NOT_FOUND' | 'LLM_TIMEOUT' | 'LLM_INVALID_RESPONSE',
    httpStatus: number,
    safeMessage: string,
    message: string,
    logMeta?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(code, httpStatus, safeMessage, {
      message,
      ...(logMeta ? { logMeta } : {}),
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Wraps anything thrown into an AppError.
 *
 * An unexpected throw becomes a generic INTERNAL_ERROR whose safe message says
 * nothing at all. The original message survives on the internal `message`
 * field for the logs.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new AppError('INTERNAL_ERROR', 500, 'Something went wrong on our end.', {
    message,
    cause: error,
  });
  // An unhandled throw is a bug, not an anticipated condition.
  Object.defineProperty(wrapped, 'isOperational', { value: false });
  return wrapped;
}

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

/** The only shape an error ever takes on its way to a client. */
export function toErrorResponseBody(error: AppError, requestId: string): ErrorResponseBody {
  return {
    error: {
      code: error.code,
      message: error.safeMessage,
      requestId,
    },
  };
}
