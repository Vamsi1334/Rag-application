import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthFailure,
  getLastAuthFailure,
  recordAuthFailure,
} from '@/server/auth/last-error';

/**
 * Capturing why sign-in failed.
 *
 * Auth.js knows the reason and prints it to a terminal, then hands the
 * browser one opaque code. This module keeps the reason so the login page can
 * show it, which is the difference between a five second fix and an hour.
 *
 * Two properties are being protected: that the useful sentence survives the
 * two layers of wrapping Auth.js puts around it, and that nothing secret ever
 * rides along with it into a page.
 */

/** The shape Auth.js produces for a rejected token exchange. */
function callbackRouteError(error: string, description: string): Error {
  const err = new Error('Read more at https://errors.authjs.dev#callbackrouteerror');
  err.name = 'CallbackRouteError';
  Object.defineProperty(err, 'cause', {
    value: { provider: 'google', err: { error, error_description: description } },
  });
  return err;
}

afterEach(clearAuthFailure);

describe('recordAuthFailure', () => {
  it('digs the provider reason out of the wrapping', () => {
    // The whole point. Without this, all anyone sees is "Configuration".
    recordAuthFailure(
      callbackRouteError('invalid_client', 'The provided client secret is invalid.'),
    );

    const failure = getLastAuthFailure();
    expect(failure?.name).toBe('CallbackRouteError');
    expect(failure?.detail).toBe('invalid_client: The provided client secret is invalid.');
  });

  it('falls back to the inner message when there is no OAuth description', () => {
    const err = new Error('outer');
    err.name = 'AdapterError';
    Object.defineProperty(err, 'cause', {
      value: { err: { message: 'MongoDB connection failed' } },
    });

    recordAuthFailure(err);
    expect(getLastAuthFailure()?.detail).toBe('MongoDB connection failed');
  });

  it('falls back to the error own message when there is no cause at all', () => {
    recordAuthFailure(new Error('something went wrong'));
    expect(getLastAuthFailure()?.detail).toBe('something went wrong');
  });

  it('starts empty and clears on demand', () => {
    expect(getLastAuthFailure()).toBeNull();

    recordAuthFailure(callbackRouteError('invalid_client', 'nope'));
    expect(getLastAuthFailure()).not.toBeNull();

    // Called on a successful sign-in, so a fixed problem stops being shown.
    clearAuthFailure();
    expect(getLastAuthFailure()).toBeNull();
  });
});

describe('crossing the bundle boundary', () => {
  it('is visible to a second instance of the module', async () => {
    // The bug this exists to prevent, and it cost an hour of debugging.
    //
    // The failure is WRITTEN by the auth route handler and READ by the login
    // page. Next.js bundles routes separately, so each can hold its own
    // instance of this module: with a plain module-level `let`, the write
    // lands in one copy and the read looks at another. The page then shows
    // nothing while the terminal proves the error happened.
    //
    // Re-importing after resetModules gives a genuinely fresh instance, which
    // is the closest a unit test gets to a separate bundle. It fails against
    // a module-scoped variable and passes against globalThis.
    recordAuthFailure(
      callbackRouteError('invalid_client', 'The provided client secret is invalid.'),
    );

    vi.resetModules();
    const reimported = await import('@/server/auth/last-error');

    expect(reimported.getLastAuthFailure()?.detail).toBe(
      'invalid_client: The provided client secret is invalid.',
    );
  });

  it('clears across instances too, so a fixed problem stops being shown', async () => {
    recordAuthFailure(callbackRouteError('invalid_client', 'nope'));

    vi.resetModules();
    const reimported = await import('@/server/auth/last-error');
    reimported.clearAuthFailure();

    expect(getLastAuthFailure()).toBeNull();
  });
});

describe('what must never reach the page', () => {
  it('redacts a Google client secret', () => {
    recordAuthFailure(
      callbackRouteError('invalid_client', 'secret GOCSPX-abc123DEF456ghi was rejected'),
    );

    const detail = getLastAuthFailure()?.detail ?? '';
    expect(detail).not.toContain('GOCSPX-abc123DEF456ghi');
    expect(detail).toContain('[redacted]');
    // The useful part still survives, which is the whole balance being struck.
    expect(detail).toContain('invalid_client');
  });

  it('redacts a connection string, password and all', () => {
    const err = new Error('outer');
    Object.defineProperty(err, 'cause', {
      value: {
        err: {
          message:
            'connect failed for mongodb+srv://someuser:somepassword@cluster.example.mongodb.net/',
        },
      },
    });

    recordAuthFailure(err);
    const detail = getLastAuthFailure()?.detail ?? '';
    expect(detail).not.toContain('somepassword');
    expect(detail).not.toContain('someuser');
    expect(detail).toContain('[redacted]');
  });

  it('redacts any long opaque token', () => {
    // Catches the credentials nobody thought to write a pattern for.
    recordAuthFailure(
      callbackRouteError('invalid_grant', 'token ya29ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef rejected'),
    );

    expect(getLastAuthFailure()?.detail).not.toContain(
      'ya29ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef',
    );
  });

  it('caps the length, so a stack trace never lands in a page', () => {
    recordAuthFailure(callbackRouteError('boom', 'x'.repeat(5000)));
    expect((getLastAuthFailure()?.detail.length ?? 0)).toBeLessThanOrEqual(400);
  });
});
