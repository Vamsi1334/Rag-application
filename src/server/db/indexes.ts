import 'server-only';

import type { Db, IndexDescription } from 'mongodb';

import { logInfo, logWarn } from '@/server/observability/logger';
import { COLLECTIONS, type CollectionName } from './collections';
import { getDb } from './client';
import { driverErrorName, safeDriverMessage } from './redact';

/**
 * Index definitions.
 *
 * -------------------------------------
 * Why indexes are code, not dashboard clicks
 * -------------------------------------
 * An index is part of the schema. Creating one by clicking in the Atlas UI
 * means development, preview and production drift apart, and the difference
 * only shows up as a query that is fast locally and times out in production.
 * Defined here, they are reviewed in pull requests and applied identically
 * everywhere.
 *
 * `createIndexes` is idempotent: an index that already exists with the same
 * definition is left alone. Running this repeatedly is safe and cheap.
 *
 * ---------------------------------------
 * Why nearly every index starts with userId
 * ---------------------------------------
 * Every query for user-owned data filters on `userId`, so it belongs first in
 * the compound key. A prefix of a compound index can be used on its own, so
 * `{ userId: 1, createdAt: -1 }` also serves a plain lookup by `userId`; the
 * reverse is not true. Getting the order wrong means full collection scans
 * that grow with every user who signs up.
 */

const INDEXES: Record<CollectionName, IndexDescription[]> = {
  [COLLECTIONS.users]: [
    // One account per email address. Auth.js relies on this to link a Google
    // sign-in to an existing user rather than creating a duplicate.
    { key: { email: 1 }, name: 'email_unique', unique: true },
  ],

  [COLLECTIONS.documents]: [
    // The document list: this user's documents, newest first.
    { key: { userId: 1, createdAt: -1 }, name: 'user_recent' },
    // Finding work to do: everything of this user's still being processed.
    { key: { userId: 1, status: 1 }, name: 'user_status' },
    /**
     * Deduplication. Re-uploading a file the user already has is a no-op
     * rather than a second copy with a second set of embeddings.
     *
     * Unique per USER, not globally: two people may legitimately hold the same
     * file, and a global constraint would leak the existence of one user's
     * document to another as a duplicate-key error.
     *
     * The partial filter excludes soft-deleted rows, so a user can delete a
     * document and upload it again. Without it the tombstone would block the
     * re-upload forever.
     */
    {
      key: { userId: 1, checksum: 1 },
      name: 'user_checksum_unique_active',
      unique: true,
      partialFilterExpression: { deletedAt: null },
    },
  ],

  [COLLECTIONS.documentChunks]: [
    // Reading a document's chunks back in order.
    { key: { documentId: 1, chunkIndex: 1 }, name: 'document_chunk_order', unique: true },
    // Deleting or counting everything a user owns.
    { key: { userId: 1 }, name: 'user' },
    /**
     * The Atlas Vector Search index is NOT defined here.
     *
     * It is a different kind of index, created through a separate Atlas API
     * rather than `createIndexes`, and it needs `userId` declared as a filter
     * field so a search can be constrained to one user's chunks. It arrives
     * with the embeddings phase, in its own script.
     */
  ],

  [COLLECTIONS.conversations]: [
    // The conversation sidebar: this user's threads, most recent first.
    { key: { userId: 1, lastMessageAt: -1 }, name: 'user_recent' },
  ],

  [COLLECTIONS.messages]: [
    // Reading a thread in order, and paginating it.
    { key: { conversationId: 1, createdAt: 1 }, name: 'conversation_order' },
    // Ownership checks and per-user cleanup without joining to conversations.
    { key: { userId: 1, createdAt: -1 }, name: 'user_recent' },
  ],
};

export interface EnsureIndexesResult {
  created: number;
  collections: number;
}

/**
 * Creates every index that does not already exist.
 *
 * Safe to run repeatedly. Called automatically at startup in development; in
 * production it belongs in the deploy pipeline, because building an index on a
 * large collection is not something that should happen while requests are
 * arriving.
 */
export async function ensureIndexes(database?: Db): Promise<EnsureIndexesResult> {
  const db = database ?? (await getDb());
  let created = 0;

  for (const [collectionName, specs] of Object.entries(INDEXES)) {
    if (specs.length === 0) continue;
    const names = await db.collection(collectionName).createIndexes(specs);
    created += names.length;
  }

  logInfo(
    { operation: 'db.ensureIndexes', status: 'ok' },
    `Ensured ${created} indexes across ${Object.keys(INDEXES).length} collections`,
  );

  return { created, collections: Object.keys(INDEXES).length };
}

/**
 * Index creation that never takes the server down with it.
 *
 * Used at startup. A cluster that is briefly unreachable, or credentials that
 * are not set yet, should not stop the application from booting; the health
 * endpoint is what reports that, and the failure is logged either way.
 */
export async function ensureIndexesSafely(): Promise<void> {
  try {
    await ensureIndexes();
  } catch (error) {
    logWarn(
      { operation: 'db.ensureIndexes', status: 'failed', errorType: driverErrorName(error) },
      `Could not ensure indexes: ${safeDriverMessage(error)}`,
    );
  }
}

/** Exposed for tests, so the definitions can be asserted without a database. */
export function getIndexDefinitions(): Record<CollectionName, IndexDescription[]> {
  return INDEXES;
}
