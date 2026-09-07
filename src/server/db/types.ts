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
// Ownership scope
// ---------------------------------------------------------------------------

/**
 * Who a document is for.
 *
 * `user`   one person uploaded it and only they can reach it
 * `shared` the company knowledge base, readable by every signed-in user
 *
 * ------------------------------------------------------------------
 * Why shared documents still carry a userId
 * ------------------------------------------------------------------
 * The obvious alternative is to make `userId` optional and null for shared
 * rows. That was rejected, and the reason is worth writing down because it
 * looks like the cleaner option at first glance.
 *
 * `userId` is the filter field on the Atlas vector index, and that filter is
 * the security boundary of this application. With a sentinel owner, a search
 * across both a user's own documents and the shared knowledge base is:
 *
 *     userId: { $in: [theUser, KNOWLEDGE_BASE_OWNER_ID] }
 *
 * One field, one operator. With a nullable column it becomes an `$or` across
 * two fields, and every future query has to remember to include the second
 * branch. Ownership bugs live in exactly that kind of forgetting, and the cost
 * of one is another user's document text reaching somebody's answer.
 *
 * So the sentinel is not pretending a person owns the knowledge base. It is
 * keeping one uniform mechanism for "which rows may this search see", with
 * `scope` recording the intent explicitly for every other kind of query.
 */
export const DOCUMENT_SCOPES = ['user', 'shared'] as const;
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number];

/**
 * The synthetic owner of shared knowledge-base rows.
 *
 * Deliberately not a generated ObjectId. A real one encodes a timestamp and a
 * machine identifier, so it looks like a genuine account; this is visibly
 * synthetic at a glance in Atlas, in a log line, and in a query.
 *
 * No user can ever be issued this id: Auth.js generates real ObjectIds, and
 * one made of twenty-three zeroes is not reachable by that path.
 */
export const KNOWLEDGE_BASE_OWNER_ID = '000000000000000000000001';

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
  /**
   * Whether this belongs to one person or to the shared knowledge base.
   *
   * Optional in the type because rows written before this field existed do not
   * have it. Absent means `user`, which is the safe default: an old row is
   * treated as private rather than accidentally becoming readable by everyone.
   */
  scope?: DocumentScope | undefined;
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
  /** Mirrors the parent document. Absent means `user`. */
  scope?: DocumentScope | undefined;
  /** Position within the document. Lets neighbouring chunks be fetched. */
  chunkIndex: number;
  content: string;
  /**
   * The document's name, copied onto the chunk.
   *
   * Denormalised so a citation can be rendered from the chunk alone. Retrieval
   * returns chunks, and joining back to the parent document for every one of
   * them just to print a filename would be a lookup per result.
   */
  sourceName?: string | undefined;
  /**
   * 1-based page the chunk came from, where the format provides it.
   *
   * Absent for plain text and Markdown, which have no pages. Never guessed: a
   * citation pointing at an invented page number is worse than one with no
   * page at all, because it looks checkable and is not.
   */
  pageNumber?: number | undefined;
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
