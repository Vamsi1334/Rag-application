import 'server-only';

import type { ObjectId } from 'mongodb';

import {
  searchChunksByVector,
  type ScoredChunk,
} from '@/server/db/repositories/document-chunks.repo';
import { getServerEnv } from '@/server/config/env';
import { logInfo } from '@/server/observability/logger';
import { embedSearchQuery } from './embedding-service';

/**
 * Finding the passages that might answer a question.
 *
 * ------------------------------------------------------------------
 * What retrieval actually is
 * ------------------------------------------------------------------
 * The question is turned into a vector by the same model that made the vectors
 * for every stored passage. Then the database finds the stored vectors closest
 * to it, and closeness in that space means closeness in meaning.
 *
 * This is why a question can find a passage that shares no words with it. Ask
 * "how do I get cited by ChatGPT" and a passage about answer engine
 * optimisation scores highly, because both landed in the same region of the
 * space, not because any keyword matched.
 *
 * ------------------------------------------------------------------
 * The two halves have to agree
 * ------------------------------------------------------------------
 * `embedSearchQuery` marks the text as a QUERY, while ingestion marked each
 * passage as a DOCUMENT. Voyage embeds them differently on purpose, and the
 * two are designed to line up. Getting that backwards does not error; it
 * silently makes every search worse.
 *
 * More seriously, both halves must use the SAME MODEL. Vectors from two models
 * are coordinates in unrelated spaces, so comparing them returns a number that
 * looks like a score and is noise. Nothing throws. That is why the model name
 * is stored on every chunk.
 */

/** A passage the search returned, ready to be shown to the model or the user. */
export interface RetrievedPassage extends ScoredChunk {
  /**
   * Position in the ranking, from 1.
   *
   * The model is told to cite by this number, so it stays attached from here
   * all the way to the rendered answer.
   */
  rank: number;
}

export interface RetrieveOptions {
  question: string;
  /** From the session, server-side. Never from the request body. */
  userId: ObjectId | string;
  /** Defaults to RETRIEVAL_TOP_K. */
  limit?: number;
  /** Restricts the search to one document. */
  documentId?: ObjectId | string;
}

export interface RetrievalResult {
  passages: RetrievedPassage[];
  /** Milliseconds spent embedding the question. */
  embedMs: number;
  /** Milliseconds spent in the vector search. */
  searchMs: number;
  embeddingModel: string;
}

/**
 * Embeds a question and returns the closest stored passages.
 *
 * Returns an empty list when there is nothing to find, which is a normal
 * outcome and not an error: a corpus that has not been ingested yet, or a
 * question about something the document does not cover.
 */
export async function retrievePassages(options: RetrieveOptions): Promise<RetrievalResult> {
  const env = getServerEnv();
  const limit = options.limit ?? env.RETRIEVAL_TOP_K;

  const embedStartedAt = Date.now();
  const embedded = await embedSearchQuery(options.question);
  const embedMs = Date.now() - embedStartedAt;

  const searchStartedAt = Date.now();
  const chunks = await searchChunksByVector(embedded.vector, options.userId, {
    limit,
    ...(options.documentId ? { documentId: options.documentId } : {}),
  });
  const searchMs = Date.now() - searchStartedAt;

  const passages = chunks.map((chunk, index) => ({ ...chunk, rank: index + 1 }));

  /**
   * Counts and scores, never the question and never the passages.
   *
   * The question is the user's, and the passages are the document's. What is
   * useful for diagnosis is how many came back and how well they scored: a
   * search returning five passages all scoring 0.4 is a corpus that does not
   * cover the question, and that is visible here without recording either.
   */
  logInfo(
    {
      operation: 'rag.retrieve',
      embeddingModel: embedded.model,
      candidatesRequested: limit,
      resultsReturned: passages.length,
      topScore: passages[0]?.score ?? 0,
      indexName: 'chunk_embedding_vector_index',
      durationMs: embedMs + searchMs,
    },
    'Retrieved passages',
  );

  return { passages, embedMs, searchMs, embeddingModel: embedded.model };
}
