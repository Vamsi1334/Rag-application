import { z } from 'zod';

import { DOCUMENT_SCOPES, DOCUMENT_STATUSES, MESSAGE_ROLES } from './types';

/**
 * Write-time validation.
 *
 * ------------------------------------------------------------
 * Why validation is here and not as a MongoDB schema validator
 * ------------------------------------------------------------
 * MongoDB can enforce a `$jsonSchema` on a collection, which would catch bad
 * writes from anywhere including a shell session. That is a real benefit, but
 * it means maintaining the same rules twice, in two languages, with no way to
 * keep them in sync. They drift, and a drifted validator is worse than none
 * because it rejects writes the application believes are valid.
 *
 * The application is the only writer here, so one definition at the repository
 * boundary is the better trade. If that ever stops being true, generating the
 * `$jsonSchema` from these Zod schemas is the way to add it without
 * duplication.
 *
 * These validate what a CALLER supplies. Fields the repository sets itself
 * (`_id`, timestamps, counters) are absent on purpose: a caller must not be
 * able to supply them.
 */

/** 24-character hex. Checked again in `toObjectId` before it reaches a query. */
const objectIdString = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'must be a 24-character hex identifier');

export const newUserSchema = z.object({
  email: z.email().max(320).toLowerCase(),
  name: z.string().min(1).max(200).optional(),
  image: z.url({ protocol: /^https?$/ }).max(2048).optional(),
  emailVerified: z.date().nullable().optional(),
});

export const newDocumentSchema = z.object({
  userId: objectIdString,
  /**
   * Defaults to `user`, the private case. A caller has to ask explicitly for
   * `shared`, so a forgotten field can never widen who can read a document.
   */
  scope: z.enum(DOCUMENT_SCOPES).default('user'),
  /**
   * Length-capped because it comes from a filename the user controls and ends
   * up in the UI, in logs and eventually in a citation.
   */
  originalName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  /**
   * A hard ceiling belongs here as well as at the upload route. Repositories
   * are called from more than one place over a project's life, and the one
   * that forgets the check is the one that matters.
   */
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  /** SHA-256, lowercase hex. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a SHA-256 hex digest'),
});

export const documentStatusSchema = z.enum(DOCUMENT_STATUSES);

export const newDocumentChunkSchema = z.object({
  userId: objectIdString,
  documentId: objectIdString,
  chunkIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  /**
   * Optional until the embeddings phase. When present, every value must be a
   * finite number: a NaN reaching the vector index corrupts similarity scores
   * in a way that is very hard to trace back.
   */
  embedding: z.array(z.number().finite()).optional(),
  embeddingModel: z.string().min(1).max(200).optional(),
  scope: z.enum(DOCUMENT_SCOPES).default('user'),
  sourceName: z.string().min(1).max(255).optional(),
  /** 1-based. Never synthesised when the format does not supply one. */
  pageNumber: z.number().int().positive().optional(),
});

export const newConversationSchema = z.object({
  userId: objectIdString,
  title: z.string().min(1).max(200).optional(),
});

export const newMessageSchema = z.object({
  userId: objectIdString,
  conversationId: objectIdString,
  role: z.enum(MESSAGE_ROLES),
  content: z.string().min(1).max(100_000),
});

export type NewUserInput = z.infer<typeof newUserSchema>;
/**
 * `z.input`, not `z.infer`.
 *
 * `z.infer` is the type AFTER parsing, where every defaulted field is filled
 * in and therefore required. That is right for what comes out of `.parse()`
 * and wrong for what a caller passes in: it would force every call site to
 * supply `scope: 'user'` explicitly, which is exactly what the default exists
 * to avoid.
 */
export type NewDocumentInput = z.input<typeof newDocumentSchema>;
export type NewDocumentChunkInput = z.input<typeof newDocumentChunkSchema>;
export type NewConversationInput = z.infer<typeof newConversationSchema>;
export type NewMessageInput = z.infer<typeof newMessageSchema>;
