import 'server-only';

import type { ObjectId } from 'mongodb';

import { documentsCollection } from '../collections';
import { toObjectId } from '../ids';
import { newDocumentSchema, type NewDocumentInput } from '../schemas';
import type { DocumentDoc, DocumentStatus } from '../types';

/**
 * Documents.
 *
 * =====================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * =====================================================================
 * There is no `findDocumentById(id)` in this codebase. There is only
 * `findDocumentForUser(id, userId)`, and it returns `null` when the owner does
 * not match.
 *
 * The reason is that authorization checks written in route handlers get
 * forgotten. Not usually, not by careless people, but eventually, in the
 * fourteenth handler someone adds in a hurry. Making `userId` a required
 * parameter of the data layer means the check cannot be forgotten: the code
 * does not compile without it.
 *
 * Note also that a document belonging to someone else produces `null`, which
 * callers turn into a 404, not a 403. Saying "forbidden" would confirm that
 * the id exists, which lets an attacker enumerate other people's documents by
 * watching for the status code to change.
 * =====================================================================
 */

/** Rows a user should see. Excludes soft-deleted ones. */
function activeFilter(userId: ObjectId) {
  return { userId, deletedAt: null };
}

export async function createDocument(input: NewDocumentInput): Promise<DocumentDoc> {
  const parsed = newDocumentSchema.parse(input);
  const now = new Date();

  const doc: Omit<DocumentDoc, '_id'> = {
    userId: toObjectId(parsed.userId, 'userId'),
    scope: parsed.scope,
    originalName: parsed.originalName,
    mimeType: parsed.mimeType,
    sizeBytes: parsed.sizeBytes,
    checksum: parsed.checksum.toLowerCase(),
    // The caller cannot choose these. A new document always starts at the
    // beginning of the pipeline with nothing processed.
    status: 'uploaded',
    chunkCount: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const collection = await documentsCollection();
  const result = await collection.insertOne(doc as DocumentDoc);
  return { ...doc, _id: result.insertedId } as DocumentDoc;
}

export async function findDocumentForUser(
  documentId: ObjectId | string,
  userId: ObjectId | string,
): Promise<DocumentDoc | null> {
  const collection = await documentsCollection();
  return collection.findOne({
    _id: toObjectId(documentId, 'documentId'),
    ...activeFilter(toObjectId(userId, 'userId')),
  });
}

export interface ListDocumentsOptions {
  limit?: number;
  /** Cursor pagination: return documents created before this one. */
  before?: Date;
}

export async function listDocumentsForUser(
  userId: ObjectId | string,
  options: ListDocumentsOptions = {},
): Promise<DocumentDoc[]> {
  // Clamped rather than trusted. An unbounded limit taken from a query string
  // is a denial-of-service vector and an accidental way to load a whole
  // collection into memory.
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const collection = await documentsCollection();

  return collection
    .find({
      ...activeFilter(toObjectId(userId, 'userId')),
      ...(options.before ? { createdAt: { $lt: options.before } } : {}),
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/** Used to make a re-upload of an identical file a no-op. */
export async function findDocumentByChecksumForUser(
  checksum: string,
  userId: ObjectId | string,
): Promise<DocumentDoc | null> {
  const collection = await documentsCollection();
  return collection.findOne({
    checksum: checksum.toLowerCase(),
    ...activeFilter(toObjectId(userId, 'userId')),
  });
}

export async function countDocumentsForUser(userId: ObjectId | string): Promise<number> {
  const collection = await documentsCollection();
  return collection.countDocuments(activeFilter(toObjectId(userId, 'userId')));
}

export interface UpdateStatusOptions {
  chunkCount?: number;
  /** Safe to show the user. Never the raw parser or driver message. */
  error?: { code: string; safeMessage: string };
}

/**
 * Advances a document through the ingestion pipeline.
 *
 * Returns the updated row, or `null` if it does not exist or belongs to
 * someone else. The ownership filter is part of the update, so a mismatched
 * user modifies nothing rather than being caught by a separate check.
 */
export async function updateDocumentStatusForUser(
  documentId: ObjectId | string,
  userId: ObjectId | string,
  status: DocumentStatus,
  options: UpdateStatusOptions = {},
): Promise<DocumentDoc | null> {
  const collection = await documentsCollection();

  return collection.findOneAndUpdate(
    {
      _id: toObjectId(documentId, 'documentId'),
      ...activeFilter(toObjectId(userId, 'userId')),
    },
    {
      $set: {
        status,
        updatedAt: new Date(),
        ...(options.chunkCount !== undefined ? { chunkCount: options.chunkCount } : {}),
        ...(options.error ? { error: { ...options.error, at: new Date() } } : {}),
      },
      ...(options.error ? {} : { $unset: { error: '' } }),
    },
    { returnDocument: 'after' },
  );
}

/**
 * Soft delete.
 *
 * A hard delete mid-processing would leave chunks pointing at a document that
 * no longer exists, and the pipeline would fail confusingly on the next step.
 * Marking the row hides it immediately while letting cleanup happen separately.
 */
export async function softDeleteDocumentForUser(
  documentId: ObjectId | string,
  userId: ObjectId | string,
): Promise<boolean> {
  const collection = await documentsCollection();

  const result = await collection.updateOne(
    {
      _id: toObjectId(documentId, 'documentId'),
      ...activeFilter(toObjectId(userId, 'userId')),
    },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } },
  );

  return result.modifiedCount === 1;
}
