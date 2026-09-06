import { describe, expect, it } from 'vitest';
import {
  newConversationSchema,
  newDocumentChunkSchema,
  newDocumentSchema,
  newMessageSchema,
  newUserSchema,
} from '@/server/db/schemas';
import { getIndexDefinitions } from '@/server/db/indexes';
import { COLLECTIONS } from '@/server/db/collections';

const VALID_ID = '6537f1a2b3c4d5e6f7890123';
const VALID_CHECKSUM = 'a'.repeat(64);

describe('newUserSchema', () => {
  it('accepts a minimal user and lowercases the email', () => {
    const result = newUserSchema.parse({ email: 'Mac@Example.COM' });
    expect(result.email).toBe('mac@example.com');
  });

  it('rejects a malformed email', () => {
    expect(newUserSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a non-http image URL', () => {
    expect(
      newUserSchema.safeParse({ email: 'a@b.com', image: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });
});

describe('newDocumentSchema', () => {
  const valid = {
    userId: VALID_ID,
    originalName: 'contract.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    checksum: VALID_CHECKSUM,
  };

  it('accepts a well-formed document', () => {
    expect(newDocumentSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an invalid user id', () => {
    expect(newDocumentSchema.safeParse({ ...valid, userId: 'nope' }).success).toBe(false);
    expect(newDocumentSchema.safeParse({ ...valid, userId: { $ne: null } }).success).toBe(false);
  });

  it('enforces a size ceiling', () => {
    expect(newDocumentSchema.safeParse({ ...valid, sizeBytes: 0 }).success).toBe(false);
    expect(
      newDocumentSchema.safeParse({ ...valid, sizeBytes: 51 * 1024 * 1024 }).success,
    ).toBe(false);
  });

  it('caps the filename length, since it comes from the user', () => {
    expect(
      newDocumentSchema.safeParse({ ...valid, originalName: 'a'.repeat(256) }).success,
    ).toBe(false);
  });

  it('requires a real SHA-256 digest', () => {
    expect(newDocumentSchema.safeParse({ ...valid, checksum: 'abc' }).success).toBe(false);
  });

  it('ignores caller-supplied status, which the repository owns', () => {
    const result = newDocumentSchema.parse({ ...valid, status: 'ready', chunkCount: 999 });
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('chunkCount');
  });
});

describe('newDocumentChunkSchema', () => {
  const valid = {
    userId: VALID_ID,
    documentId: VALID_ID,
    chunkIndex: 0,
    content: 'Either party may terminate on ninety days written notice.',
    tokenCount: 12,
  };

  it('accepts a chunk without an embedding', () => {
    expect(newDocumentChunkSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a chunk with an embedding', () => {
    const result = newDocumentChunkSchema.safeParse({
      ...valid,
      embedding: [0.1, -0.2, 0.3],
      embeddingModel: 'nomic-embed-text',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-finite value in an embedding', () => {
    // A NaN reaching the vector index corrupts similarity scores in a way that
    // is very hard to trace back to its source.
    expect(newDocumentChunkSchema.safeParse({ ...valid, embedding: [0.1, NaN] }).success).toBe(
      false,
    );
    expect(
      newDocumentChunkSchema.safeParse({ ...valid, embedding: [0.1, Infinity] }).success,
    ).toBe(false);
  });

  it('rejects empty content', () => {
    expect(newDocumentChunkSchema.safeParse({ ...valid, content: '' }).success).toBe(false);
  });

  it('rejects a negative chunk index', () => {
    expect(newDocumentChunkSchema.safeParse({ ...valid, chunkIndex: -1 }).success).toBe(false);
  });
});

describe('newConversationSchema and newMessageSchema', () => {
  it('accepts a conversation without a title', () => {
    expect(newConversationSchema.safeParse({ userId: VALID_ID }).success).toBe(true);
  });

  it('accepts both message roles and rejects anything else', () => {
    const base = { userId: VALID_ID, conversationId: VALID_ID, content: 'hello' };
    expect(newMessageSchema.safeParse({ ...base, role: 'user' }).success).toBe(true);
    expect(newMessageSchema.safeParse({ ...base, role: 'assistant' }).success).toBe(true);
    // 'system' is not stored: system instructions are built per request and
    // are not part of a user's conversation history.
    expect(newMessageSchema.safeParse({ ...base, role: 'system' }).success).toBe(false);
  });

  it('rejects empty message content', () => {
    expect(
      newMessageSchema.safeParse({
        userId: VALID_ID,
        conversationId: VALID_ID,
        role: 'user',
        content: '',
      }).success,
    ).toBe(false);
  });
});

describe('index definitions', () => {
  const indexes = getIndexDefinitions();

  it('covers every collection', () => {
    for (const name of Object.values(COLLECTIONS)) {
      expect(indexes[name]).toBeDefined();
    }
  });

  it('leads every user-scoped index with userId', () => {
    // A compound index can serve a query on its prefix, so userId first also
    // covers a plain lookup by user. The reverse is not true, and getting the
    // order wrong means a collection scan that grows with every signup.
    for (const name of [COLLECTIONS.documents, COLLECTIONS.conversations]) {
      for (const index of indexes[name]) {
        expect(Object.keys(index.key)[0]).toBe('userId');
      }
    }
  });

  it('scopes document deduplication per user, not globally', () => {
    const dedupe = indexes[COLLECTIONS.documents].find((i) => i.unique && 'checksum' in i.key);

    expect(dedupe).toBeDefined();
    // A global unique index on checksum would leak one user's documents to
    // another as a duplicate-key error on upload.
    expect(Object.keys(dedupe!.key)).toEqual(['userId', 'checksum']);
    // The partial filter lets a user delete a document and upload it again.
    expect(dedupe!.partialFilterExpression).toEqual({ deletedAt: null });
  });

  it('gives every index an explicit name', () => {
    // Auto-generated names come from the key spec, so changing a key silently
    // creates a second index instead of replacing the first.
    for (const specs of Object.values(indexes)) {
      for (const index of specs) {
        expect(index.name).toBeTruthy();
      }
    }
  });
});
