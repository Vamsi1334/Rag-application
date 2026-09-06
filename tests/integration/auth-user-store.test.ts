import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

import { resetServerEnvCache } from '@/server/config/env';

/**
 * User creation and ownership, against a real MongoDB.
 *
 * Two things are checked here that a mock cannot show.
 *
 * First, that the user shape Auth.js will write is compatible with the schema
 * defined in the database phase: same collection, same unique index on email,
 * timestamps present.
 *
 * Second, and much more importantly, that a user id obtained from a session
 * flows into the repository layer and produces isolation. This is the bridge
 * between authentication and the RAG requirement: user A must never retrieve
 * user B's documents or chunks.
 */

let mongo: MongoMemoryServer;

type Modules = {
  users: typeof import('@/server/db/repositories/users.repo');
  documents: typeof import('@/server/db/repositories/documents.repo');
  chunks: typeof import('@/server/db/repositories/document-chunks.repo');
  client: typeof import('@/server/db/client');
  indexes: typeof import('@/server/db/indexes');
  collections: typeof import('@/server/db/collections');
};

let m: Modules;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB_NAME = 'auth_test';
  resetServerEnvCache();

  m = {
    users: await import('@/server/db/repositories/users.repo'),
    documents: await import('@/server/db/repositories/documents.repo'),
    chunks: await import('@/server/db/repositories/document-chunks.repo'),
    client: await import('@/server/db/client'),
    indexes: await import('@/server/db/indexes'),
    collections: await import('@/server/db/collections'),
  };

  await m.indexes.ensureIndexes();
});

afterAll(async () => {
  await m?.client.closeMongoClient();
  await mongo?.stop();
});

beforeEach(async () => {
  const db = await m.client.getDb();
  for (const c of await db.collections()) await c.deleteMany({});
});

describe('the user record a Google sign-in produces', () => {
  it('stores the fields the dashboard needs, and timestamps', async () => {
    const user = await m.users.createUser({
      email: 'mac@example.com',
      name: 'Mac',
      image: 'https://lh3.googleusercontent.com/a/example',
    });

    expect(user._id).toBeInstanceOf(ObjectId);
    expect(user.email).toBe('mac@example.com');
    expect(user.name).toBe('Mac');
    expect(user.image).toContain('https://');
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('never stores anything resembling a password or a token', async () => {
    // OAuth means we never see a password. The adapter is also configured to
    // discard Google's access and refresh tokens, because this app never calls
    // Google APIs on the user's behalf and a stored refresh token is a
    // long-lived key to someone's account.
    const user = await m.users.createUser({ email: 'mac@example.com' });
    const stored = await m.users.findUserById(user._id);
    const serialized = JSON.stringify(stored);

    for (const field of ['password', 'access_token', 'refresh_token', 'id_token', 'secret']) {
      expect(serialized).not.toContain(field);
    }
  });

  it('finds an existing user rather than creating a second one', async () => {
    // A returning user has to resolve to the SAME id, or their documents would
    // become invisible to them on their second sign-in.
    const first = await m.users.createUser({ email: 'mac@example.com', name: 'Mac' });
    const found = await m.users.findUserByEmail('mac@example.com');

    expect(found?._id.toHexString()).toBe(first._id.toHexString());
  });

  it('treats a differently-cased email as the same account', async () => {
    const created = await m.users.createUser({ email: 'Mac@Example.COM' });
    const found = await m.users.findUserByEmail('mac@example.com');

    expect(found?._id.toHexString()).toBe(created._id.toHexString());
  });

  it('refuses a duplicate email at the database level', async () => {
    await m.users.createUser({ email: 'mac@example.com' });
    await expect(m.users.createUser({ email: 'mac@example.com' })).rejects.toThrow();
  });

  it('uses the collection Auth.js is configured to write to', async () => {
    // The adapter is pointed at COLLECTIONS.users. If that drifted, Auth.js
    // would create users in one collection while the repositories read another,
    // and every sign-in would look successful while the dashboard stayed empty.
    expect(m.collections.COLLECTIONS.users).toBe('users');
  });
});

describe('a session user id produces isolation', () => {
  /**
   * The bridge between this phase and the RAG requirement.
   *
   * `requireUser()` returns an ObjectId taken from the server-side session.
   * These tests use two such ids and confirm that the repository layer keeps
   * their data apart, which is the property vector search will inherit when it
   * filters on the same field.
   */
  it('keeps two signed-in users’ documents apart', async () => {
    const alice = await m.users.createUser({ email: 'alice@example.com' });
    const bob = await m.users.createUser({ email: 'bob@example.com' });

    const doc = await m.documents.createDocument({
      userId: alice._id.toHexString(),
      originalName: 'salary-review.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      checksum: 'a'.repeat(64),
    });

    // Alice sees it.
    expect(await m.documents.findDocumentForUser(doc._id, alice._id)).not.toBeNull();
    expect(await m.documents.listDocumentsForUser(alice._id)).toHaveLength(1);

    // Bob, with a perfectly valid session of his own, sees nothing.
    expect(await m.documents.findDocumentForUser(doc._id, bob._id)).toBeNull();
    expect(await m.documents.listDocumentsForUser(bob._id)).toHaveLength(0);
    expect(await m.documents.countDocumentsForUser(bob._id)).toBe(0);
  });

  it('keeps their chunks apart, which is what vector search will filter on', async () => {
    const alice = await m.users.createUser({ email: 'alice@example.com' });
    const bob = await m.users.createUser({ email: 'bob@example.com' });

    const doc = await m.documents.createDocument({
      userId: alice._id.toHexString(),
      originalName: 'private.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      checksum: 'b'.repeat(64),
    });

    await m.chunks.insertDocumentChunks([
      {
        userId: alice._id.toHexString(),
        documentId: doc._id.toHexString(),
        chunkIndex: 0,
        content: 'Confidential settlement terms.',
        tokenCount: 4,
      },
    ]);

    expect(await m.chunks.countChunksForUser(alice._id)).toBe(1);
    expect(await m.chunks.countChunksForUser(bob._id)).toBe(0);
    expect(await m.chunks.listChunksForDocument(doc._id, bob._id)).toHaveLength(0);
    // Bob cannot delete them either.
    expect(await m.chunks.deleteChunksForDocument(doc._id, bob._id)).toBe(0);
    expect(await m.chunks.countChunksForUser(alice._id)).toBe(1);
  });

  it('gives every user a distinct id, so isolation has something to key on', async () => {
    const a = await m.users.createUser({ email: 'a@example.com' });
    const b = await m.users.createUser({ email: 'b@example.com' });

    expect(a._id.equals(b._id)).toBe(false);
  });
});
