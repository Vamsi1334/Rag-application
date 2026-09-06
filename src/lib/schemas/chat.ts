import { z } from 'zod';

/**
 * The contract for POST /api/ai/chat.
 *
 * Lives in `src/lib/` rather than `src/server/` because both sides need it:
 * the route validates against it, and the browser imports the types so a
 * change to the shape is a compile error on the client too. That is the point
 * of keeping API types separate from database types.
 *
 * Nothing here touches the server modules, so it is safe to bundle.
 */

/**
 * A hard ceiling on input length.
 *
 * Not arbitrary. Every character becomes tokens, tokens become the model's
 * work, and on a local CPU that work is measured in seconds. Without a cap,
 * one paste of a long document turns into a request that occupies the only
 * model instance for minutes. It is a denial-of-service limit as much as a
 * validation rule.
 *
 * Roughly 1,000 tokens at four characters each, comfortably inside the
 * default 8k context window with room for the answer.
 */
export const MAX_MESSAGE_LENGTH = 4000;

export const chatRequestSchema = z.object({
  message: z
    .string({ error: 'message is required and must be a string' })
    // Trim first: a message of only spaces is empty to a person and should be
    // rejected as such, rather than sent to the model as whitespace.
    .trim()
    .min(1, 'message cannot be empty')
    .max(MAX_MESSAGE_LENGTH, `message cannot exceed ${MAX_MESSAGE_LENGTH} characters`),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface ChatResponse {
  answer: string;
  /** Which provider and model produced it. Useful when comparing models. */
  provider: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  /** Wall-clock time, including model load if it was cold. */
  durationMs: number;
  finishReason: string;
  requestId: string;
}

/** The error shape every route returns, matching the global handler. */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}
