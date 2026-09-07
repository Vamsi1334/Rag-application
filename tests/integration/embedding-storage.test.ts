import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

import { resetServerEnvCache } from '@/server/config/env';
import { chunkText } from '@/server/rag/chunking';

/**
 * Storing embeddings, against a real MongoDB.
 *
 * The question this file answers is not "does the code run". It is: once
 * vectors are in the database, can one user's passages reach another user's
 * answers?
 *
 * That has to be tested against a real database because it depends on real
 * behaviour: whether a filter actually excludes rows, whether a unique index
 * really fires, whether a validation rule really rejects. A mock would happily
 * confirm whatever the code believes about itself.
 *
 * Note the limit. `$vectorSearch` runs inside Atlas's search process, which is
 * not part of mongod, so the ranking itself cannot be tested here. What CAN be
 * tested is the thing that makes the search safe: that every chunk carries a
 * userId, that ownership filters exclude other people's rows, and that a
 * caller cannot write a chunk owned by someone else.
 */

let mongo: MongoMemoryServer;

type Modules = {
  chunks: typeof import('@/server/db/repositories/document-chunks.repo');
  documents: typeof import('@/server/db/repositories/documents.repo');
  collections: typeof import('@/server/db/collections');
  client: typeof import('@/server/db/client');
  indexes: typeof import('@/server/db/indexes');
};

let mod: Modules;

const userA = new ObjectId().toHexString();
const userB = new ObjectId().toHexString();

const DIMENSIONS = 256;

function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => (seed + i) / 1000);
}

function documentInput(userId: string) {
  return {
    userId,
    originalName: 'seo-guide.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    checksum: new ObjectId().toHexString().padEnd(64, '0').slice(0, 64),
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB_NAME = 'embedding_storage_test';
  resetServerEnvCache();

  mod = {
    chunks: await import('@/server/db/repositories/document-chunks.repo'),
    documents: await import('@/server/db/repositories/documents.repo'),
    collections: await import('@/server/db/collections'),
    client: await import('@/server/db/client'),
    indexes: await import('@/server/db/indexes'),
  };

  await mod.indexes.ensureIndexes();
}, 120_000);

afterAll(async () => {
  await mod?.client.closeMongoClient();
  await mongo?.stop();
});

beforeEach(async () => {
  const collection = await mod.collections.documentChunksCollection();
  await collection.deleteMany({});
  const documents = await mod.collections.documentsCollection();
  await documents.deleteMany({});
});

describe('storing a chunk with its vector', () => {
  it('round-trips the embedding and records which model produced it', async () => {
    const document = await mod.documents.createDocument(documentInput(userA));

    await mod.chunks.insertDocumentChunks([
      {
        userId: userA,
        documentId: document._id.toHexString(),
        chunkIndex: 0,
        content: 'Search intent decides which page ranks.',
        tokenCount: 8,
        embedding: vector(1),
        embeddingModel: 'voyage-4-lite',
      },
    ]);

    const stored = await mod.chunks.listChunksForDocument(document._id, userA);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.embedding).toHaveLength(DIMENSIONS);
    /**
     * The field that makes a model change survivable.
     *
     * Vectors from two different models are coordinates in unrelated spaces.
     * Comparing them returns a number that looks like a score and is noise,
     * and nothing errors. Recording the model per chunk is what lets a
     * migration find the stale rows instead of silently corrupting search.
     */
    expect(stored[0]?.embeddingModel).toBe('voyage-4-lite');
  });

  it('rejects a vector containing a non-finite number', async () => {
    const document = await mod.documents.createDocument(documentInput(userA));
    const poisoned = vector(1);
    poisoned[3] = Number.NaN;

    await expect(
      mod.chunks.insertDocumentChunks([
        {
          userId: userA,
          documentId: document._id.toHexString(),
          chunkIndex: 0,
          content: 'text',
          tokenCount: 1,
          embedding: poisoned,
        },
      ]),
    ).rejects.toThrow();
  });

  it('stores a whole document worth of chunks in order', async () => {
    const document = await mod.documents.createDocument(documentInput(userA));
    const source = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i} explains one idea about inbound marketing clearly.`,
    ).join('\n\n');

    const produced = chunkText(source, { chunkSize: 200, overlap: 40 });
    expect(produced.length).toBeGreaterThan(1);

    await mod.chunks.insertDocumentChunks(
      produced.map((chunk) => ({
        userId: userA,
        documentId: document._id.toHexString(),
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: vector(chunk.chunkIndex),
        embeddingModel: 'voyage-4-lite',
      })),
    );

    const stored = await mod.chunks.listChunksForDocument(document._id, userA);

    expect(stored).toHaveLength(produced.length);
    expect(stored.map((c) => c.chunkIndex)).toEqual(produced.map((_, i) => i));
  });
});

describe('user isolation', () => {
  it('does not return another user chunks, even with the right document id', async () => {
    // The whole application in one assertion. User B knows A's document id and
    // still gets nothing.
    const document = await mod.documents.createDocument(documentInput(userA));

    await mod.chunks.insertDocumentChunks([
      {
        userId: userA,
        documentId: document._id.toHexString(),
        chunkIndex: 0,
        content: 'Private revenue figures for the quarter.',
        tokenCount: 8,
        embedding: vector(1),
      },
    ]);

    const asOwner = await mod.chunks.listChunksForDocument(document._id, userA);
    const asIntruder = await mod.chunks.listChunksForDocument(document._id, userB);

    expect(asOwner).toHaveLength(1);
    expect(asIntruder).toEqual([]);
  });

  it('counts only the caller own chunks', async () => {
    const docA = await mod.documents.createDocument(documentInput(userA));
    const docB = await mod.documents.createDocument(documentInput(userB));

    await mod.chunks.insertDocumentChunks([
      {
        userId: userA,
        documentId: docA._id.toHexString(),
        chunkIndex: 0,
        content: 'A',
        tokenCount: 1,
        embedding: vector(1),
      },
      {
        userId: userB,
        documentId: docB._id.toHexString(),
        chunkIndex: 0,
        content: 'B',
        tokenCount: 1,
        embedding: vector(2),
      },
    ]);

    expect(await mod.chunks.countChunksForUser(userA)).toBe(1);
    expect(await mod.chunks.countChunksForUser(userB)).toBe(1);
  });

  it('cannot delete another user chunks', async () => {
    const document = await mod.documents.createDocument(documentInput(userA));

    await mod.chunks.insertDocumentChunks([
      {
        userId: userA,
        documentId: document._id.toHexString(),
        chunkIndex: 0,
        content: 'A',
        tokenCount: 1,
        embedding: vector(1),
      },
    ]);

    const deleted = await mod.chunks.deleteChunksForDocument(document._id, userB);

    expect(deleted).toBe(0);
    expect(await mod.chunks.countChunksForUser(userA)).toBe(1);
  });

  it('stores userId on the chunk itself, not only on its parent document', async () => {
    /**
     * Not redundancy. The Atlas vector index declares `userId` as a filter
     * field, and a filter can only reference a field present on the row being
     * searched. Deriving ownership from the parent document would make it
     * impossible to constrain the search, forcing the filter to run after
     * ranking, which returns partial results and risks another user's text
     * reaching a prompt.
     */
    const document = await mod.documents.createDocument(documentInput(userA));

    await mod.chunks.insertDocumentChunks([
      {
        userId: userA,
        documentId: document._id.toHexString(),
        chunkIndex: 0,
        content: 'A',
        tokenCount: 1,
        embedding: vector(1),
      },
    ]);

    const collection = await mod.collections.documentChunksCollection();
    const raw = await collection.findOne({ documentId: document._id });

    expect(raw?.userId).toBeInstanceOf(ObjectId);
    expect(raw?.userId.toHexString()).toBe(userA);
  });
});

describe('ownership cannot be forged', () => {
  it('rejects a userId that is a query operator rather than an id', async () => {
    // `{"userId": {"$ne": null}}` reaching a filter would match every row in
    // the collection. Every id goes through toObjectId for this reason.
    const document = await mod.documents.createDocument(documentInput(userA));

    await expect(
      mod.chunks.insertDocumentChunks([
        {
          userId: { $ne: null } as unknown as string,
          documentId: document._id.toHexString(),
          chunkIndex: 0,
          content: 'A',
          tokenCount: 1,
          embedding: vector(1),
        },
      ]),
    ).rejects.toThrow();
  });

  it('rejects a malformed userId outright', async () => {
    const document = await mod.documents.createDocument(documentInput(userA));

    await expect(
      mod.chunks.insertDocumentChunks([
        {
          userId: 'not-an-object-id',
          documentId: document._id.toHexString(),
          chunkIndex: 0,
          content: 'A',
          tokenCount: 1,
          embedding: vector(1),
        },
      ]),
    ).rejects.toThrow();
  });
});
