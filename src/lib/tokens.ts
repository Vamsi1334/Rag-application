/**
 * One token estimate, used everywhere.
 *
 * ------------------------------------------------------------------
 * Why this is its own module
 * ------------------------------------------------------------------
 * Two places need to guess how many tokens a piece of text is worth, and they
 * need to agree:
 *
 *   - chunking, deciding how long a passage should be
 *   - the embedding provider, deciding how many passages fit in one request
 *     without breaching the vendor's tokens-per-minute limit
 *
 * If those two used different ratios, chunk sizes and batch budgets would
 * drift apart, and the symptom would be rate-limit errors that appear only on
 * documents of a certain shape. One exported constant makes that impossible.
 *
 * It lives in `lib/` rather than under `server/` because it is pure arithmetic
 * on a string: no configuration, no credentials, nothing to leak. That also
 * keeps the dependency pointing downwards. `server/ai` importing from
 * `server/rag` would have been backwards, since `server/rag` already imports
 * from `server/ai`.
 *
 * ------------------------------------------------------------------
 * Why an estimate and not a tokenizer
 * ------------------------------------------------------------------
 * A real tokenizer means loading model-specific vocabulary to answer a
 * question about budgeting. Roughly four characters per token holds well
 * enough for English prose, and every caller uses it to stay comfortably
 * inside a limit rather than to sit exactly on one.
 *
 * It is wrong in predictable directions: code, tables and CJK text run denser
 * than four characters per token, so the estimate reads low for them. Callers
 * budgeting against a hard vendor limit should leave headroom rather than
 * assume this number is exact. Good enough for budgeting, not for billing.
 */

/** Characters per token, for English prose. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
