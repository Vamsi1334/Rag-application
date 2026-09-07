import 'server-only';

import type { Document, ObjectId } from 'mongodb';

import { ConfigurationError } from '@/server/observability/errors';
import { documentChunksCollection } from '../collections';
import { toObjectId } from '../ids';
import { driverErrorName, safeDriverMessage } from '../redact';
import { newDocumentChunkSchema, type NewDocumentChunkInput } from '../schemas';
import { KNOWLEDGE_BASE_OWNER_ID, type DocumentChunkDoc } from '../types';
import { VECTOR_INDEX_NAME } from '../vector-index';

/**
 * Document chunks.
 *
 * The collection that will grow fastest: one row per passage, so a hundred
 * documents becomes tens of thousands of rows. Every query here is indexed and
 * bounded for that reason.
 *
 * `userId` is stored on every chunk even though it can be derived from the
 * parent document. That is deliberate, and it is not just about avoiding a
 * join: the vector search in a later phase filters on `userId` inside the
 * search itself, which requires the field to be present on the chunk. Adding
 * it later would mean backfilling the largest collection in the application.
 */

export async function insertDocumentChunks(
  inputs: NewDocumentChunkInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;

  const now = new Date();
  const docs = inputs.map((input) => {
    const parsed = newDocumentChunkSchema.parse(input);
    return {
      userId: toObjectId(parsed.userId, 'userId'),
      documentId: toObjectId(parsed.documentId, 'documentId'),
      scope: parsed.scope,
      chunkIndex: parsed.chunkIndex,
      content: parsed.content,
      tokenCount: parsed.tokenCount,
      ...(parsed.embedding ? { embedding: parsed.embedding } : {}),
      ...(parsed.embeddingModel ? { embeddingModel: parsed.embeddingModel } : {}),
      ...(parsed.sourceName ? { sourceName: parsed.sourceName } : {}),
      // Only when the format actually supplied one. Never invented.
      ...(parsed.pageNumber ? { pageNumber: parsed.pageNumber } : {}),
      createdAt: now,
    };
  });

  const collection = await documentChunksCollection();
  // Ordered inserts stop at the first failure and leave the rest unwritten.
  // Unordered lets the good rows land, which matters when a batch is being
  // retried after a partial failure.
  const result = await collection.insertMany(docs as DocumentChunkDoc[], { ordered: false });
  return result.insertedCount;
}

/**
 * A chunk that a vector search matched, with its similarity score.
 *
 * Deliberately not the whole `DocumentChunkDoc`. The vector itself is 256
 * numbers that no caller downstream reads, and carrying it through retrieval,
 * context assembly and into a response body would be a kilobyte per passage
 * that exists only to be ignored.
 */
export interface ScoredChunk {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  sourceName?: string | undefined;
  pageNumber?: number | undefined;
  /** Cosine similarity, 0 to 1. Higher is closer in meaning. */
  score: number;
}

export interface VectorSearchOptions {
  /** How many passages to return. */
  limit: number;
  /**
   * How many candidates Atlas considers before ranking.
   *
   * Vector search is approximate: it narrows to a candidate pool and then
   * scores it, so a pool barely larger than the limit finds the nearest
   * neighbours it happened to look at rather than the nearest that exist.
   * Atlas suggests 10 to 20 times the limit. Higher costs latency, lower costs
   * recall, and recall failures are invisible: you get five results either
   * way, they are just quietly worse.
   */
  numCandidates?: number;
  /** Restricts the search to one document. */
  documentId?: ObjectId | string;
}

/**
 * Builds the aggregation pipeline for a vector search.
 *
 * ===================================================================
 * WHY THIS IS A SEPARATE, EXPORTED, PURE FUNCTION
 * ===================================================================
 * `$vectorSearch` only runs inside Atlas Search, which is a different process
 * from mongod and is absent from the in-memory MongoDB the tests use. So the
 * one thing that most needs testing here, THAT THE OWNERSHIP FILTER IS
 * PRESENT AND CORRECT, cannot be tested by running a query.
 *
 * Pulling the pipeline out as a pure function means the filter can be asserted
 * exactly, without Atlas, in a millisecond. A test can prove that the filter
 * exists, that it lives INSIDE the `$vectorSearch` stage rather than in a
 * later `$match`, and that it names the caller and the shared knowledge base
 * and nobody else.
 *
 * The alternative was leaving the security boundary of the whole application
 * as the one line no test could reach.
 * ===================================================================
 */
export function buildVectorSearchPipeline(
  queryVector: number[],
  userId: ObjectId | string,
  options: VectorSearchOptions,
): Document[] {
  const limit = Math.min(Math.max(options.limit, 1), 100);
  const numCandidates = Math.min(Math.max(options.numCandidates ?? limit * 10, limit), 10_000);

  /**
   * The security boundary of this application, in one expression.
   *
   * Two owners are visible to a search: the person asking, and the shared
   * company knowledge base. Nobody else, ever.
   *
   * This is why shared documents carry a sentinel owner id rather than a null
   * one. As `$in` over a single field it is one filter that Atlas applies
   * BEFORE ranking, so the caller gets the top N of the rows they may see. The
   * nullable alternative would need an `$or` across two fields, which every
   * future query would have to remember to write correctly.
   */
  const ownership = {
    userId: { $in: [toObjectId(userId, 'userId'), toObjectId(KNOWLEDGE_BASE_OWNER_ID, 'userId')] },
  };

  return [
    {
      // Must be the first stage. Atlas rejects a pipeline where it is not.
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        numCandidates,
        limit,
        /**
         * INSIDE the search, not after it.
         *
         * A `$match` on the next stage would look equivalent and be a serious
         * bug: Atlas would find the global nearest neighbours across every
         * user, and only then would rows be discarded. Ask for five, get the
         * global five, drop four that belong to other people, answer from one.
         * Retrieval quality collapses silently, and any slip in that later
         * stage puts another user's text into a prompt.
         */
        filter: {
          ...ownership,
          ...(options.documentId
            ? { documentId: toObjectId(options.documentId, 'documentId') }
            : {}),
        },
      },
    },
    {
      // Named fields only. `embedding` is deliberately absent: 256 numbers per
      // passage that nothing downstream reads.
      $project: {
        _id: 1,
        documentId: 1,
        chunkIndex: 1,
        content: 1,
        tokenCount: 1,
        sourceName: 1,
        pageNumber: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];
}

/**
 * Turns a vector-search failure into something the reader can act on.
 *
 * ------------------------------------------------------------------
 * Why this needs its own mapping
 * ------------------------------------------------------------------
 * There are exactly two ways this query fails that are not bugs, and both are
 * states a person can fix in a few minutes. Left as a generic 500 they read as
 * "the product is broken", and the real reason sits in a log nobody thought to
 * open.
 *
 *   - The deployment has no Atlas Search at all. A local mongod, or an
 *     in-memory server in a test, rejects `$vectorSearch` outright.
 *   - The index is missing, misnamed, or still building. Atlas builds search
 *     indexes asynchronously, so a freshly created one is genuinely absent for
 *     a while, and a typo in its name looks identical.
 *
 * The safe message names the state, never the index, the host or the query.
 */
export function mapVectorSearchError(error: unknown): Error {
  const detail = safeDriverMessage(error);

  const noSearchSupport = /\$vectorSearch|\$search/i.test(detail) && /requires|configuration|Atlas/i.test(detail);
  const missingIndex = /index not found|unknown index|no such index|IndexNotFound/i.test(detail);

  if (noSearchSupport || missingIndex) {
    return new ConfigurationError(
      `Vector search is unavailable: ${detail}`,
      {
        operation: 'db.vectorSearch',
        indexName: VECTOR_INDEX_NAME,
        errorType: driverErrorName(error),
      },
      'Document search is not available right now. The search index is missing, ' +
        'still building, or this database does not support vector search.',
    );
  }

  return error instanceof Error ? error : new Error(detail);
}

/**
 * Finds the passages closest in meaning to a query vector.
 *
 * `userId` is required, like every other function in this file. The search sees
 * that user's own chunks and the shared knowledge base, and nothing else.
 */
export async function searchChunksByVector(
  queryVector: number[],
  userId: ObjectId | string,
  options: VectorSearchOptions,
): Promise<ScoredChunk[]> {
  const collection = await documentChunksCollection();
  const pipeline = buildVectorSearchPipeline(queryVector, userId, options);

  let rows: (DocumentChunkDoc & { score: number })[];
  try {
    rows = await collection
      .aggregate<DocumentChunkDoc & { score: number }>(pipeline)
      .toArray();
  } catch (error) {
    throw mapVectorSearchError(error);
  }

  return rows.map((row) => ({
    chunkId: row._id.toHexString(),
    documentId: row.documentId.toHexString(),
    chunkIndex: row.chunkIndex,
    content: row.content,
    tokenCount: row.tokenCount,
    ...(row.sourceName ? { sourceName: row.sourceName } : {}),
    ...(row.pageNumber ? { pageNumber: row.pageNumber } : {}),
    score: row.score,
  }));
}

export async function listChunksForDocument(
  documentId: ObjectId | string,
  userId: ObjectId | string,
): Promise<DocumentChunkDoc[]> {
  const collection = await documentChunksCollection();
  return collection
    .find({
      documentId: toObjectId(documentId, 'documentId'),
      userId: toObjectId(userId, 'userId'),
    })
    .sort({ chunkIndex: 1 })
    .toArray();
}

export async function countChunksForDocument(
  documentId: ObjectId | string,
  userId: ObjectId | string,
): Promise<number> {
  const collection = await documentChunksCollection();
  return collection.countDocuments({
    documentId: toObjectId(documentId, 'documentId'),
    userId: toObjectId(userId, 'userId'),
  });
}

export async function countChunksForUser(userId: ObjectId | string): Promise<number> {
  const collection = await documentChunksCollection();
  return collection.countDocuments({ userId: toObjectId(userId, 'userId') });
}

/**
 * Removes every chunk of a document.
 *
 * Chunks are hard deleted rather than soft deleted, unlike documents. They
 * carry no state worth keeping, they are the bulk of the stored data, and they
 * are fully reproducible by reprocessing the original file. Keeping tombstones
 * for them would mean carrying the largest collection's dead weight forever.
 *
 * Also how re-processing works: delete, then re-insert.
 */
export async function deleteChunksForDocument(
  documentId: ObjectId | string,
  userId: ObjectId | string,
): Promise<number> {
  const collection = await documentChunksCollection();
  const result = await collection.deleteMany({
    documentId: toObjectId(documentId, 'documentId'),
    userId: toObjectId(userId, 'userId'),
  });
  return result.deletedCount;
}
