import 'server-only';

import type { ObjectId } from 'mongodb';

import { documentChunksCollection } from '../collections';
import { toObjectId } from '../ids';
import { newDocumentChunkSchema, type NewDocumentChunkInput } from '../schemas';
import type { DocumentChunkDoc } from '../types';

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
      chunkIndex: parsed.chunkIndex,
      content: parsed.content,
      tokenCount: parsed.tokenCount,
      ...(parsed.embedding ? { embedding: parsed.embedding } : {}),
      ...(parsed.embeddingModel ? { embeddingModel: parsed.embeddingModel } : {}),
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
