import { describe, expect, it, vi } from 'vitest';

/**
 * Auth configuration.
 *
 * The MongoDB adapter is mocked, so these run without a database. What is
 * asserted is the set of decisions that would be invisible until they went
 * wrong in production: session strategy, scopes, and what reaches a log.
 */
vi.mock('@/server/auth/mongo-adapter', () => ({
  createAuthAdapter: () => ({}),
}));

// Auth.js reads these when the provider is constructed.
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.AUTH_SECRET = 'a'.repeat(48);

const { buildAuthConfig } = await import('@/server/auth/config');
const authConfig = buildAuthConfig();

describe('session strategy', () => {
  it('uses database sessions, so signing out can actually revoke access', () => {
    // A JWT session cannot be revoked: signing out deletes the cookie, but the
    // token stays valid until it expires, so a copied one keeps working. This
    // app holds private documents, so sign-out has to mean something.
    expect(authConfig.session?.strategy).toBe('database');
  });

  it('expires sessions and refreshes them at most daily', () => {
    expect(authConfig.session?.maxAge).toBe(30 * 24 * 60 * 60);
    // Without updateAge, every request from an active user writes to the
    // sessions collection.
    expect(authConfig.session?.updateAge).toBe(24 * 60 * 60);
  });
});

describe('Google provider', () => {
  it('is the only configured provider', () => {
    expect(authConfig.providers).toHaveLength(1);
  });

  it('requests only the scopes needed to identify someone', () => {
    // Anything more shows the user a scarier consent screen and hands us data
    // we would then have to protect. We need to know who they are, not read
    // their contacts.
    //
    // Auth.js keeps caller-supplied overrides under `options` and merges them
    // with its defaults when the request is built, so the scope is read from
    // there rather than off the top of the provider object.
    const provider = authConfig.providers[0] as unknown as {
      id: string;
      options: { authorization: { params: { scope: string } } };
    };

    expect(provider.id).toBe('google');

    const { scope } = provider.options.authorization.params;
    expect(scope).toBe('openid email profile');
    for (const overreach of ['drive', 'gmail', 'contacts', 'calendar', 'photos']) {
      expect(scope).not.toContain(overreach);
    }
  });
});

describe('callbacks', () => {
  it('puts the user id on the session', () => {
    // The tenant key for the whole application. Without this callback,
    // requireUser() has nothing to return and every ownership filter breaks.
    const session = { user: { name: 'Mac', email: 'mac@example.com' } };
    const result = authConfig.callbacks?.session?.({
      session,
      user: { id: '6537f1a2b3c4d5e6f7890123' },
    } as never) as { user: { id: string } };

    expect(result.user.id).toBe('6537f1a2b3c4d5e6f7890123');
  });

  it('rejects a sign-in when Google says the email is unverified', () => {
    // Accounts are keyed by email address. Accepting an unverified one would
    // let someone claim an address they do not control, which is account
    // takeover rather than a mere annoyance.
    const rejected = authConfig.callbacks?.signIn?.({
      profile: { email_verified: false },
    } as never);
    expect(rejected).toBe(false);

    const accepted = authConfig.callbacks?.signIn?.({
      profile: { email_verified: true },
    } as never);
    expect(accepted).toBe(true);
  });
});

describe('pages', () => {
  it('sends sign-in and errors to our own page, not the Auth.js default', () => {
    expect(authConfig.pages?.signIn).toBe('/login');
    expect(authConfig.pages?.error).toBe('/login');
  });
});

describe('what sign-in logs', () => {
  it('records the user id and never the email address', async () => {
    const logged: Record<string, unknown>[] = [];
    vi.doMock('@/server/observability/logger', () => ({
      logInfo: (fields: Record<string, unknown>) => logged.push(fields),
      logWarn: (fields: Record<string, unknown>) => logged.push(fields),
    }));
    vi.resetModules();
    const { buildAuthConfig: freshBuild } = await import('@/server/auth/config');
    const freshConfig = freshBuild();

    freshConfig.events?.signIn?.({
      user: { id: '6537f1a2b3c4d5e6f7890123', email: 'mac@example.com', name: 'Mac' },
      isNewUser: true,
    } as never);

    const serialized = JSON.stringify(logged);
    expect(serialized).toContain('6537f1a2b3c4d5e6f7890123');
    // An id is meaningless without database access; an email is personal data.
    expect(serialized).not.toContain('mac@example.com');
    expect(serialized).not.toContain('Mac');

    vi.doUnmock('@/server/observability/logger');
  });
});
