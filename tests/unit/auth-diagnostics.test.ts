import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diagnoseAuthConfig } from '@/server/auth/diagnostics';
import { resetServerEnvCache } from '@/server/config/env';

/**
 * Diagnosing a `Configuration` error.
 *
 * Auth.js collapses four separate failures into one error code, and the login
 * page shows one sentence for all of them. This narrows it to the variable at
 * fault.
 *
 * The security property matters as much as the diagnosis: the result carries
 * variable NAMES and never values. The last test is the one that would catch a
 * well-meaning future change that adds "AUTH_SECRET (starts with abc...)" to
 * make debugging easier.
 */

const ORIGINAL_ENV = process.env;

const COMPLETE = {
  NODE_ENV: 'test',
  AUTH_SECRET: 'a-secret-long-enough-to-pass-the-32-character-minimum',
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret-value',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
};

function withEnv(vars: Record<string, string>): void {
  process.env = vars as NodeJS.ProcessEnv;
  resetServerEnvCache();
}

/** Everything except the named variables. */
function without(...omit: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(COMPLETE).filter(([key]) => !omit.includes(key)));
}

beforeEach(resetServerEnvCache);

afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetServerEnvCache();
});

describe('diagnoseAuthConfig', () => {
  it('reports ok when all four variables are set', () => {
    withEnv(COMPLETE);

    const result = diagnoseAuthConfig();
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.parseError).toBeNull();
  });

  it('names each missing variable individually', () => {
    for (const variable of [
      'AUTH_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'MONGODB_URI',
    ]) {
      withEnv(without(variable));

      const result = diagnoseAuthConfig();
      expect(result.ok).toBe(false);
      expect(result.missing.map((m) => m.name)).toEqual([variable]);
    }
  });

  it('names all of them when nothing is configured', () => {
    withEnv({ NODE_ENV: 'test' });

    expect(diagnoseAuthConfig().missing.map((m) => m.name)).toEqual([
      'AUTH_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'MONGODB_URI',
    ]);
  });

  it('includes MONGODB_URI, which is the least obvious of the four', () => {
    // Sessions are stored in the database, so the adapter cannot be built
    // without it. Nothing about the words "sign-in is not configured" points
    // at a database, which is exactly why it is listed.
    withEnv(without('MONGODB_URI'));

    const result = diagnoseAuthConfig();
    expect(result.missing[0]?.name).toBe('MONGODB_URI');
    expect(result.missing[0]?.why).toMatch(/database/i);
  });

  it('separates a variable that is present but invalid', () => {
    // A different failure with a different fix: the variable is there, so
    // "add it to .env.local" would be the wrong advice.
    withEnv({ ...COMPLETE, AUTH_SECRET: 'too-short' });

    const result = diagnoseAuthConfig();
    expect(result.ok).toBe(false);
    expect(result.parseError).toMatch(/AUTH_SECRET/);
  });

  it('never returns a value, a length or a masked fragment', () => {
    // The property that has to survive future edits. Someone will eventually
    // want to add "(starts with gsk_...)" to make debugging easier, and a
    // prefix of a secret is still part of a secret.
    withEnv({ ...COMPLETE, AUTH_SECRET: 'too-short' });
    const serialized = JSON.stringify(diagnoseAuthConfig());

    for (const secret of [
      COMPLETE.AUTH_SECRET,
      COMPLETE.GOOGLE_CLIENT_ID,
      COMPLETE.GOOGLE_CLIENT_SECRET,
      COMPLETE.MONGODB_URI,
      'too-short',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('never returns a value when a variable is merely missing', () => {
    withEnv(without('GOOGLE_CLIENT_SECRET'));
    const serialized = JSON.stringify(diagnoseAuthConfig());

    expect(serialized).toContain('GOOGLE_CLIENT_SECRET');
    expect(serialized).not.toContain(COMPLETE.GOOGLE_CLIENT_ID);
    expect(serialized).not.toContain(COMPLETE.AUTH_SECRET);
    expect(serialized).not.toContain(COMPLETE.MONGODB_URI);
  });
});
