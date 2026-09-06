import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * requireUser().
 *
 * The only place server code learns who is asking. Every ownership filter in
 * the application depends on the value it returns, so these tests are about
 * one question: can anything other than a real server-side session produce a
 * user id?
 */

const authMock = vi.fn();
vi.mock('@/server/auth/index', () => ({ auth: authMock }));

const { requireUser, getOptionalUser } = await import('@/server/auth/require-user');

afterEach(() => {
  authMock.mockReset();
});

describe('requireUser', () => {
  it('returns the user id as an ObjectId, ready for a repository', async () => {
    authMock.mockResolvedValue({
      user: {
        id: '6537f1a2b3c4d5e6f7890123',
        email: 'mac@example.com',
        name: 'Mac',
        image: 'https://example.com/a.jpg',
      },
    });

    const user = await requireUser();

    expect(user.userIdString).toBe('6537f1a2b3c4d5e6f7890123');
    expect(user.userId.toHexString()).toBe('6537f1a2b3c4d5e6f7890123');
    expect(user.email).toBe('mac@example.com');
  });

  it('throws when there is no session', async () => {
    authMock.mockResolvedValue(null);

    await expect(requireUser()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    });
  });

  it('throws when a session exists but carries no user id', async () => {
    // Would happen if the session callback were removed. Failing loudly beats
    // returning undefined into a query that then matches nothing, or worse,
    // everything.
    authMock.mockResolvedValue({ user: { email: 'mac@example.com' } });

    await expect(requireUser()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a session whose user id is a query operator', async () => {
    // Defence in depth. The id comes from our own database via the session, so
    // this should be impossible, but the guarantee should not rest on
    // reasoning about provenance: an operator object reaching a filter would
    // match every row in the collection.
    authMock.mockResolvedValue({ user: { id: { $ne: null } } });

    await expect(requireUser()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a malformed user id', async () => {
    authMock.mockResolvedValue({ user: { id: 'not-an-object-id' } });

    await expect(requireUser()).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('never reports an error containing the session value', async () => {
    authMock.mockResolvedValue({ user: { id: 'sessiontoken-abc-secret' } });

    try {
      await requireUser();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('sessiontoken');
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('tolerates a user with no name or picture', async () => {
    authMock.mockResolvedValue({
      user: { id: '6537f1a2b3c4d5e6f7890123', email: 'mac@example.com' },
    });

    const user = await requireUser();
    expect(user.name).toBeNull();
    expect(user.image).toBeNull();
  });
});

describe('getOptionalUser', () => {
  it('returns the user when signed in', async () => {
    authMock.mockResolvedValue({
      user: { id: '6537f1a2b3c4d5e6f7890123', email: 'mac@example.com' },
    });

    await expect(getOptionalUser()).resolves.toMatchObject({
      userIdString: '6537f1a2b3c4d5e6f7890123',
    });
  });

  it('returns null instead of throwing when signed out', async () => {
    authMock.mockResolvedValue(null);
    await expect(getOptionalUser()).resolves.toBeNull();
  });
});
