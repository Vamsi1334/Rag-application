import type { ObjectId } from 'mongodb';

/**
 * Database entity types.
 *
 * ---------------------------------------------------------
 * Why these are NOT the types the API sends and receives
 * ---------------------------------------------------------
 * These describe rows exactly as MongoDB stores them: `ObjectId` instances,
 * real `Date` objects, internal fields such as `deletedAt`, and columns a user
 * should never see. They are the shape of the storage layer.
 *
 * API request and response types are different in three ways: ids are strings
 * (JSON has no ObjectId), dates are ISO strings, and internal fields are
 * dropped. Those types live in `src/lib/schemas/`, which is browser-safe.
 *
 * Collapsing the two is the mistake that leaks `deletedAt`, internal error
 * detail, or another user's id into an API response, because someone returned
 * a database row directly. Keeping them apart forces a deliberate mapping step
 * where the decision about what to expose is made once, visibly.
 *
 * The types below are minimal on purpose. Fields belonging to features that do
 * not exist yet are noted rather than added, so nothing is speculative.
 */

/** Fields every collection carries. */
export interface BaseDoc {
  _id: ObjectId;
  createdAt: Date;
}

/**
 * Fields on anything a user owns.
 *
 * `userId` is the tenant key for the whole application. Every query against a
 * collection carrying it must filter on it.
 */
export interface OwnedDoc extends BaseDoc {
  userId: ObjectId;
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/**
 * A person who signed in.
 *
 * The root of every ownership chain: documents, chunks, conversations and
 * messages all trace back to a `_id` here.
 *
 * In the authentication phase, Auth.js takes over creating and updating these
 * rows through its MongoDB adapter, and adds its own `accounts` and `sessions`
 * collections alongside. The shape below is deliberately compatible with what
 * that adapter writes, so the two do not fight.
 */
export interface UserDoc extends BaseDoc {
  email: string;
  name?: string | undefined;
  image?: string | undefined;
  /** Set by Auth.js. Google accounts arrive already verified. */
  emailVerified?: Date | null | undefined;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/**
 * The ingestion state machine.
 *
 * A document moves forward one step at a time, and each step is resumable. A
 * large file cannot be extracted, chunked and embedded inside a single request
 * without timing out, so the row records where it got to.
 */
export const DOCUMENT_STATUSES = [
  'uploaded',
  'extracting',
  'extracted',
  'chunking',
  'chunked',
  'embedding',
  'ready',
  'failed',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Statuses from which no further work happens without intervention. */
export const TERMINAL_DOCUMENT_STATUSES: readonly DocumentStatus[] = ['ready', 'failed'];

/**
 * An uploaded file and how far its processing got.
 *
 * Owned by exactly one user. Never shared, never made public.
 *
 * Added later: `storageKey` when file storage lands, `pageCount` and
 * `progress` with real ingestion, `embeddingModel` with embeddings.
 */
export interface DocumentDoc extends OwnedDoc {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * SHA-256 of the file contents.
   *
   * Makes re-uploading the same file a no-op rather than a second copy with a
   * second set of embeddings. Unique per user, not globally: two people may
   * legitimately hold the same file, and each owns their own copy.
   */
  checksum: string;
  status: DocumentStatus;
  /**
   * Why processing failed, in a form safe to show the user.
   *
   * Deliberately not the raw driver or parser error, which can carry file
   * contents or internal paths.
   */
  error?: { code: string; safeMessage: string; at: Date } | undefined;
  chunkCount: number;
  updatedAt: Date;
  /**
   * Soft delete.
   *
   * A hard delete during processing would leave chunks pointing at a document
   * that no longer exists. Marking the row instead lets the pipeline finish or
   * abort cleanly, and cleanup happens separately.
   */
  deletedAt: Date | null;
}

// ---------------------------------------------------------------------------
// document_chunks
// ---------------------------------------------------------------------------

/**
 * One searchable passage of a document.
 *
 * A whole document cannot be searched or fed to a model directly: it is too
 * long for either. It is split into overlapping passages, and the passage is
 * the unit that gets embedded, retrieved and cited.
 *
 * This will become the largest collection in the application by a wide margin,
 * and it is where the vector index lives.
 *
 * Added later: `embedding` is written in the embeddings phase, and `pageNumber`
 * plus `headingPath` in the chunking phase, when citations need them.
 */
export interface DocumentChunkDoc extends OwnedDoc {
  documentId: ObjectId;
  /** Position within the document. Lets neighbouring chunks be fetched. */
  chunkIndex: number;
  content: string;
  /** Precomputed so prompt budgeting needs no tokenizer at query time. */
  tokenCount: number;
  /**
   * The vector. Absent until the embeddings phase runs.
   *
   * `userId` above is what makes vector search safe: it is declared as a
   * filter field on the Atlas index so a search can be constrained to one
   * user's chunks. Filtering after the search instead would return the global
   * top matches and then discard other people's, which silently returns
   * partial results and can put another user's text in a prompt.
   */
  embedding?: number[] | undefined;
  /** Which model produced the vector, so a model change can be migrated. */
  embeddingModel?: string | undefined;
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

/**
 * A chat thread.
 *
 * Groups messages so a user can return to an earlier line of questioning, and
 * so follow-up questions have history to resolve against.
 *
 * Added later: `documentIds` to scope a thread to specific documents, and
 * `summary` for condensing long threads.
 */
export interface ConversationDoc extends OwnedDoc {
  title: string;
  /**
   * Denormalized counters.
   *
   * The sidebar lists conversations by recency with a message count. Computing
   * that per conversation would be one aggregation per row on every page load;
   * keeping it on the row makes the list a single indexed query.
   */
  messageCount: number;
  lastMessageAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * One turn in a conversation.
 *
 * A separate collection rather than an array inside the conversation, for two
 * reasons: a MongoDB document is capped at 16 MB and a long thread with
 * retrieved context would approach it, and messages need to be paginated
 * rather than loaded whole.
 *
 * Added later: `citations` and retrieval telemetry when RAG produces answers.
 */
export interface MessageDoc extends OwnedDoc {
  conversationId: ObjectId;
  /**
   * `userId` is stored here as well as on the conversation.
   *
   * Denormalizing it means a message's owner can be checked without joining to
   * its conversation, so the ownership filter is one index lookup on every
   * query rather than a lookup plus a join.
   */
  role: MessageRole;
  content: string;
}

// ---------------------------------------------------------------------------
// Insert shapes
// ---------------------------------------------------------------------------

/**
 * What a caller supplies when creating a row.
 *
 * `_id` and the timestamps are set by the repository, never by the caller, so
 * they cannot be forged or accidentally omitted.
 */
export type NewUser = Omit<UserDoc, '_id' | 'createdAt' | 'updatedAt'>;

export type NewDocument = Omit<
  DocumentDoc,
  '_id' | 'createdAt' | 'updatedAt' | 'status' | 'chunkCount' | 'deletedAt' | 'error'
>;

export type NewDocumentChunk = Omit<DocumentChunkDoc, '_id' | 'createdAt'>;

export type NewConversation = Omit<
  ConversationDoc,
  '_id' | 'createdAt' | 'updatedAt' | 'messageCount' | 'lastMessageAt' | 'deletedAt' | 'title'
> & { title?: string | undefined };

export type NewMessage = Omit<MessageDoc, '_id' | 'createdAt'>;
