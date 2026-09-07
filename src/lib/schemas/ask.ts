import { z } from 'zod';

/**
 * The contract for POST /api/ai/ask.
 *
 * In `src/lib/` because both sides need it: the route validates against it and
 * the browser imports the types, so a change to the shape is a compile error on
 * the client too. Nothing here touches server modules, so it is safe to bundle.
 *
 * ------------------------------------------------------------------
 * What is deliberately absent from the request
 * ------------------------------------------------------------------
 * There is no `userId` field, and there never will be.
 *
 * The user id comes from the session cookie, resolved server-side. A client
 * that could name the user whose documents to search would be a client that
 * could search anybody's, and no amount of validation on such a field makes it
 * safe: the field itself is the vulnerability.
 */

/**
 * A ceiling on question length.
 *
 * Shorter than the raw chat endpoint's, on purpose. This question gets embedded
 * before anything else happens, and an embedding is one point in space: a long
 * multi-part question averages into a vector that sits between its topics and
 * is close to none of them. Retrieval then returns passages for a question
 * nobody asked.
 *
 * It is a quality limit first and a denial-of-service limit second.
 */
export const MAX_QUESTION_LENGTH = 1000;

export const askRequestSchema = z.object({
  question: z
    .string({ error: 'question is required and must be a string' })
    .trim()
    .min(1, 'question cannot be empty')
    .max(MAX_QUESTION_LENGTH, `question cannot exceed ${MAX_QUESTION_LENGTH} characters`),
});

export type AskRequest = z.infer<typeof askRequestSchema>;

/**
 * One passage the answer was allowed to draw on.
 *
 * Sent to the browser so the reader can check the answer against its source.
 * An answer without its passages is an answer whose mistakes are undetectable,
 * and undetectable mistakes are what this whole system exists to prevent.
 */
export interface AnswerSource {
  /** Position in the ranking, from 1. Matches the [1] markers in the answer. */
  rank: number;
  /** The passage text, so the reader can verify rather than trust. */
  content: string;
  /** The file it came from. */
  sourceName?: string;
  /** Absent for formats without pages. Never invented. */
  pageNumber?: number;
  /** Cosine similarity, 0 to 1. */
  score: number;
}

export interface AskResponse {
  answer: string;
  sources: AnswerSource[];
  /** True when nothing matched, so no model call was made. */
  groundedInNothing: boolean;
  provider: string;
  model: string;
  embeddingModel: string;
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
  timings: { embedMs: number; searchMs: number; generateMs: number; totalMs: number };
  requestId: string;
}
