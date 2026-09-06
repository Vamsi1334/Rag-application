import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

import { resetServerEnvCache } from '@/server/config/env';

/**
 * Repository integration tests, against a real MongoDB.
 *
 * A mocked database proves that the code calls the functions it was written to
 * call. It cannot prove that a unique index actually rejects a duplicate, that
 * a partial filter behaves as expected, or that an ownership filter really
 * excludes another user's rows. Those are database behaviours, so they need a
 * database.
 *
 * `mongodb-memory-server` downloads a real mongod on first run and starts it
 * per test file. Later, when vector search arrives, those specific tests will
 * need a real Atlas cluster instead: `$vectorSearch` runs in Atlas's search
 * process, which is not part of mongod.
 */

let mongo: MongoMemoryServer;

/** Imported after the environment is set, since the modules read config. */
type Repos = {
  documents: typeof import('@/server/db/repositories/documents.repo');
  chunks: typeof import('@/server/db/repositories/document-chunks.repo');
  conversations: typeof import('@/server/db/repositories/conversations.repo');
  messages: typeof import('@/server/db/repositories/messages.repo');
  users: typeof import('@/server/db/repositories/users.repo');
  client: typeof import('@/server/db/client');
  indexes: typeof import('@/server/db/indexes');
};

let repos: Repos;

/** Two separate users. Every isolation test below runs B against A's data. */
const userA = new ObjectId().toHexString();
const userB = new ObjectId().toHexString();

function documentInput(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    originalName: 'contract.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    // Unique per call so the per-user dedupe index does not fire unintentionally.
    checksum: new ObjectId().toHexString().padEnd(64, '0').slice(0, 64),
    ...overrides,
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();

  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB_NAME = 'ai_document_assistant_test';
  resetServerEnvCache();

  repos = {
    documents: await import('@/server/db/repositories/documents.repo'),
    chunks: await import('@/server/db/repositories/document-chunks.repo'),
    conversations: await import('@/server/db/repositories/conversations.repo'),
    messages: await import('@/server/db/repositories/messages.repo'),
    users: await import('@/server/db/repositories/users.repo'),
    client: await import('@/server/db/client'),
    indexes: await import('@/server/db/indexes'),
  };

  await repos.indexes.ensureIndexes();
});

afterAll(async () => {
  await repos?.client.closeMongoClient();
  await mongo?.stop();
});

beforeEach(async () => {
  const db = await repos.client.getDb();
  const collections = await db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

// ---------------------------------------------------------------------------

describe('connection', () => {
  it('reports the database as configured and reachable', async () => {
    expect(repos.client.isDatabaseConfigured()).toBe(true);

    const result = await repos.client.pingDatabase();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reuses one client across calls rather than opening a pool per request', async () => {
    // The cached promise is the thing that prevents pool exhaustion under hot
    // reload in development and per-invocation connects in production.
    const [first, second] = await Promise.all([
      repos.client.getMongoClient(),
      repos.client.getMongoClient(),
    ]);
    expect(first).toBe(second);
  });
});

describe('indexes', () => {
  it('creates them idempotently', async () => {
    const first = await repos.indexes.ensureIndexes();
    const second = await repos.indexes.ensureIndexes();
    expect(second.created).toBe(first.created);
  });

  it('enforces per-user document deduplication', async () => {
    const input = documentInput(userA);
    await repos.documents.createDocument(input);

    await expect(repos.documents.createDocument(input)).rejects.toThrow();
  });

  it('lets a DIFFERENT user upload the same file', async () => {
    // A global unique index on checksum would reject this and, worse, would
    // tell user B that user A holds that exact file.
    const checksum = 'b'.repeat(64);
    await repos.documents.createDocument(documentInput(userA, { checksum }));

    const forB = await repos.documents.createDocument(documentInput(userB, { checksum }));
    expect(forB.checksum).toBe(checksum);
  });

  it('lets a user re-upload a file after deleting it', async () => {
    // This is what the partial filter on deletedAt buys. Without it the
    // tombstone would block the re-upload permanently.
    const checksum = 'c'.repeat(64);
    const doc = await repos.documents.createDocument(documentInput(userA, { checksum }));
    await repos.documents.softDeleteDocumentForUser(doc._id, userA);

    const again = await repos.documents.createDocument(documentInput(userA, { checksum }));
    expect(again._id.equals(doc._id)).toBe(false);
  });
});

describe('documents', () => {
  it('creates a document at the start of the pipeline', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));

    expect(doc.status).toBe('uploaded');
    expect(doc.chunkCount).toBe(0);
    expect(doc.deletedAt).toBeNull();
    expect(doc.userId.toHexString()).toBe(userA);
  });

  it('advances status and records a safe error', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));

    const failed = await repos.documents.updateDocumentStatusForUser(doc._id, userA, 'failed', {
      error: { code: 'EXTRACTION_FAILED', safeMessage: 'This PDF has no readable text.' },
    });

    expect(failed?.status).toBe('failed');
    expect(failed?.error?.code).toBe('EXTRACTION_FAILED');
  });

  it('clears a previous error when the status advances again', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));
    await repos.documents.updateDocumentStatusForUser(doc._id, userA, 'failed', {
      error: { code: 'EXTRACTION_FAILED', safeMessage: 'nope' },
    });

    const retried = await repos.documents.updateDocumentStatusForUser(doc._id, userA, 'extracting');
    expect(retried?.error).toBeUndefined();
  });

  it('hides soft-deleted documents from every read path', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));
    expect(await repos.documents.softDeleteDocumentForUser(doc._id, userA)).toBe(true);

    expect(await repos.documents.findDocumentForUser(doc._id, userA)).toBeNull();
    expect(await repos.documents.listDocumentsForUser(userA)).toHaveLength(0);
    expect(await repos.documents.countDocumentsForUser(userA)).toBe(0);
  });

  it('clamps an oversized list limit instead of trusting it', async () => {
    for (let i = 0; i < 5; i++) {
      await repos.documents.createDocument(documentInput(userA));
    }
    const results = await repos.documents.listDocumentsForUser(userA, { limit: 100_000 });
    expect(results.length).toBeLessThanOrEqual(100);
  });
});

describe('chunks, conversations and messages', () => {
  it('stores and reads back chunks in order', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));
    const inserted = await repos.chunks.insertDocumentChunks([
      { userId: userA, documentId: doc._id.toHexString(), chunkIndex: 1, content: 'second', tokenCount: 2 },
      { userId: userA, documentId: doc._id.toHexString(), chunkIndex: 0, content: 'first', tokenCount: 2 },
    ]);

    expect(inserted).toBe(2);
    const chunks = await repos.chunks.listChunksForDocument(doc._id, userA);
    expect(chunks.map((c) => c.content)).toEqual(['first', 'second']);
  });

  it('rejects a duplicate chunk index within a document', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));
    const chunk = {
      userId: userA,
      documentId: doc._id.toHexString(),
      chunkIndex: 0,
      content: 'x',
      tokenCount: 1,
    };
    await repos.chunks.insertDocumentChunks([chunk]);

    await expect(repos.chunks.insertDocumentChunks([chunk])).rejects.toThrow();
  });

  it('keeps the conversation counter in step when messages are added', async () => {
    const conversation = await repos.conversations.createConversation({ userId: userA });

    await repos.messages.createMessage({
      userId: userA,
      conversationId: conversation._id.toHexString(),
      role: 'user',
      content: 'What is the notice period?',
    });
    await repos.messages.createMessage({
      userId: userA,
      conversationId: conversation._id.toHexString(),
      role: 'assistant',
      content: 'Ninety days.',
    });

    const updated = await repos.conversations.findConversationForUser(conversation._id, userA);
    expect(updated?.messageCount).toBe(2);

    const messages = await repos.messages.listMessagesForConversation(conversation._id, userA);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

// ---------------------------------------------------------------------------
// The suite that matters most
// ---------------------------------------------------------------------------

describe('cross-user isolation', () => {
  /**
   * User B goes after every one of user A's records, by id, through every
   * function that reads or writes user-owned data.
   *
   * This is the test the whole repository design exists to pass. Every leak in
   * a multi-tenant application is some version of "a query that forgot to
   * filter by owner", and it is invisible in normal use because you only ever
   * see your own data while developing. This suite is what makes the failure
   * loud.
   *
   * Note the expectations: `null`, `[]`, `0`, `false`. Nothing throws. A
   * distinguishable error would confirm the record exists, which is enough to
   * enumerate another user's ids.
   */

  it('cannot read another user’s document', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));

    expect(await repos.documents.findDocumentForUser(doc._id, userB)).toBeNull();
    expect(await repos.documents.listDocumentsForUser(userB)).toHaveLength(0);
    expect(await repos.documents.countDocumentsForUser(userB)).toBe(0);
    expect(
      await repos.documents.findDocumentByChecksumForUser(doc.checksum, userB),
    ).toBeNull();
  });

  it('cannot modify another user’s document', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));

    expect(
      await repos.documents.updateDocumentStatusForUser(doc._id, userB, 'ready'),
    ).toBeNull();
    expect(await repos.documents.softDeleteDocumentForUser(doc._id, userB)).toBe(false);

    // A still has it, untouched.
    const stillThere = await repos.documents.findDocumentForUser(doc._id, userA);
    expect(stillThere?.status).toBe('uploaded');
    expect(stillThere?.deletedAt).toBeNull();
  });

  it('cannot read or delete another user’s chunks', async () => {
    const doc = await repos.documents.createDocument(documentInput(userA));
    await repos.chunks.insertDocumentChunks([
      {
        userId: userA,
        documentId: doc._id.toHexString(),
        chunkIndex: 0,
        content: 'Confidential settlement terms.',
        tokenCount: 4,
      },
    ]);

    expect(await repos.chunks.listChunksForDocument(doc._id, userB)).toHaveLength(0);
    expect(await repos.chunks.countChunksForDocument(doc._id, userB)).toBe(0);
    expect(await repos.chunks.countChunksForUser(userB)).toBe(0);
    expect(await repos.chunks.deleteChunksForDocument(doc._id, userB)).toBe(0);

    // A's chunk survived B's delete attempt.
    expect(await repos.chunks.countChunksForDocument(doc._id, userA)).toBe(1);
  });

  it('cannot read, rename or delete another user’s conversation', async () => {
    const conversation = await repos.conversations.createConversation({
      userId: userA,
      title: 'Private matter',
    });

    expect(await repos.conversations.findConversationForUser(conversation._id, userB)).toBeNull();
    expect(await repos.conversations.listConversationsForUser(userB)).toHaveLength(0);
    expect(
      await repos.conversations.renameConversationForUser(conversation._id, userB, 'hijacked'),
    ).toBeNull();
    expect(
      await repos.conversations.softDeleteConversationForUser(conversation._id, userB),
    ).toBe(false);

    const untouched = await repos.conversations.findConversationForUser(conversation._id, userA);
    expect(untouched?.title).toBe('Private matter');
  });

  it('cannot write a message into another user’s conversation', async () => {
    // The attack this blocks: B supplies its own userId with A's
    // conversationId. Without the parent-ownership check the row would land in
    // A's thread and then pass every later ownership filter, because the row
    // claims to belong to B.
    const conversation = await repos.conversations.createConversation({ userId: userA });

    await expect(
      repos.messages.createMessage({
        userId: userB,
        conversationId: conversation._id.toHexString(),
        role: 'user',
        content: 'injected',
      }),
    ).rejects.toThrow(/not found/i);

    expect(await repos.messages.countMessagesForConversation(conversation._id, userA)).toBe(0);
  });

  it('cannot read another user’s messages', async () => {
    const conversation = await repos.conversations.createConversation({ userId: userA });
    await repos.messages.createMessage({
      userId: userA,
      conversationId: conversation._id.toHexString(),
      role: 'user',
      content: 'What did the settlement say?',
    });

    expect(
      await repos.messages.listMessagesForConversation(conversation._id, userB),
    ).toHaveLength(0);
    expect(await repos.messages.countMessagesForConversation(conversation._id, userB)).toBe(0);
    expect(await repos.messages.deleteMessagesForConversation(conversation._id, userB)).toBe(0);

    expect(await repos.messages.countMessagesForConversation(conversation._id, userA)).toBe(1);
  });

  it('rejects an operator object supplied where an id is expected', async () => {
    // Without id parsing, { $ne: null } as a userId would match every row.
    const doc = await repos.documents.createDocument(documentInput(userA));

    await expect(
      repos.documents.findDocumentForUser(doc._id, { $ne: null } as never),
    ).rejects.toThrow(/not a valid identifier/);

    await expect(
      repos.documents.findDocumentForUser({ $ne: null } as never, userA),
    ).rejects.toThrow(/not a valid identifier/);
  });
});

describe('users', () => {
  it('creates and finds a user by id and email', async () => {
    const user = await repos.users.createUser({ email: 'Mac@Example.com', name: 'Mac' });

    expect(user.email).toBe('mac@example.com');
    expect((await repos.users.findUserById(user._id))?.email).toBe('mac@example.com');
    // Case-insensitive lookup, since a person does not think of MAC@ and mac@
    // as different accounts.
    expect((await repos.users.findUserByEmail('MAC@EXAMPLE.COM'))?._id).toStrictEqual(user._id);
  });

  it('enforces one account per email address', async () => {
    await repos.users.createUser({ email: 'dup@example.com' });
    await expect(repos.users.createUser({ email: 'dup@example.com' })).rejects.toThrow();
  });
});
