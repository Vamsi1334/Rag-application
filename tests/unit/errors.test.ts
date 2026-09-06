import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConfigurationError,
  NotFoundError,
  NotImplementedError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  isAppError,
  toAppError,
  toErrorResponseBody,
} from '@/server/observability/errors';

describe('error taxonomy', () => {
  it('maps each error to the right status and code', () => {
    expect(new ValidationError('bad input').httpStatus).toBe(400);
    expect(new UnauthorizedError().httpStatus).toBe(401);
    expect(new NotFoundError().httpStatus).toBe(404);
    expect(new RateLimitError().httpStatus).toBe(429);
    expect(new ConfigurationError('missing var').httpStatus).toBe(500);
    expect(new NotImplementedError('later').httpStatus).toBe(501);

    expect(new ValidationError('bad input').code).toBe('VALIDATION_ERROR');
    expect(new NotImplementedError('later').code).toBe('NOT_IMPLEMENTED');
  });

  it('separates the internal message from the one shown to users', () => {
    const error = new ConfigurationError(
      'MONGODB_URI is malformed: mongodb+srv://admin:hunter2@cluster.net',
    );

    // The detail is kept for the logs.
    expect(error.message).toContain('hunter2');
    // But never offered to a caller.
    expect(error.safeMessage).toBe('The server is not configured correctly.');
    expect(error.safeMessage).not.toContain('hunter2');
    expect(error.safeMessage).not.toContain('MONGODB_URI');
  });

  it('sends only code, safe message and request id to the client', () => {
    const error = new ValidationError('field "ssn" failed regex /^\\d{9}$/', {
      variable: 'ssn',
    });
    const body = toErrorResponseBody(error, 'req_abc123');

    expect(body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request was not valid.',
        requestId: 'req_abc123',
      },
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('ssn');
    expect(serialized).not.toContain('regex');
  });

  it('marks anticipated failures as operational', () => {
    expect(new NotFoundError().isOperational).toBe(true);
  });

  it('keeps a readable class name after minification', () => {
    // The production build minifies class names, so `new.target.name` becomes
    // an empty string and every log line loses its `errorType`. Each class
    // therefore declares a literal name. Found by reading a real production
    // log that said errorType: "".
    expect(new ConfigurationError('x').name).toBe('ConfigurationError');
    expect(new ValidationError('x').name).toBe('ValidationError');
    expect(new UnauthorizedError().name).toBe('UnauthorizedError');
    expect(new NotFoundError().name).toBe('NotFoundError');
    expect(new RateLimitError().name).toBe('RateLimitError');
    expect(new NotImplementedError('x').name).toBe('NotImplementedError');
    expect(toAppError(new Error('boom')).name).toBe('AppError');
  });
});

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const original = new NotFoundError('document missing');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps an unexpected throw without leaking its message to the user', () => {
    const wrapped = toAppError(new Error('Connection failed: user=admin password=hunter2'));

    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.httpStatus).toBe(500);
    expect(wrapped.safeMessage).toBe('Something went wrong on our end.');
    expect(wrapped.safeMessage).not.toContain('hunter2');
    // The original survives for the logs.
    expect(wrapped.message).toContain('hunter2');
  });

  it('marks an unexpected throw as a bug rather than a handled condition', () => {
    expect(toAppError(new Error('boom')).isOperational).toBe(false);
  });

  it('handles values that are not Errors', () => {
    expect(toAppError('a string was thrown').code).toBe('INTERNAL_ERROR');
    expect(toAppError(undefined).code).toBe('INTERNAL_ERROR');
  });
});

describe('isAppError', () => {
  it('distinguishes our errors from everything else', () => {
    expect(isAppError(new NotFoundError())).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('string')).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it('recognizes a directly constructed AppError', () => {
    const error = new AppError('INTERNAL_ERROR', 500, 'safe', { message: 'internal' });
    expect(isAppError(error)).toBe(true);
  });
});
