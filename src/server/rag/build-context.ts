import 'server-only';

import { estimateTokens } from '@/lib/tokens';
import type { RetrievedPassage } from './retrieve';

/**
 * Fitting the retrieved passages into the space available.
 *
 * ------------------------------------------------------------------
 * The budget nobody thinks about until it breaks
 * ------------------------------------------------------------------
 * A model's context window is a single fixed allowance shared by everything in
 * the request: the instructions, the passages, the question, and the answer it
 * has yet to write. The answer's share is the one that gets squeezed, because
 * it is the only part not yet on the page when the budget is spent.
 *
 * Send five unusually long passages and the model has room to reply with two
 * sentences. It does not error. It stops mid-sentence, `finishReason` comes
 * back as `length`, and the user sees a truncated answer with no explanation.
 *
 * So passages are added in rank order until a ceiling is reached, and the rest
 * are dropped. Dropping the fifth-best passage is a small loss. Truncating the
 * answer is a visible failure.
 *
 * ------------------------------------------------------------------
 * Why rank order rather than fitting as many as possible
 * ------------------------------------------------------------------
 * Taking passages in order and stopping is not the arrangement that fits the
 * most text. A greedy pack that skipped a long third passage to fit two
 * shorter ones would use the budget better.
 *
 * It would also silently drop the third most relevant passage in favour of two
 * weaker ones, purely because of length. Relevance is the thing being
 * optimised; the budget is only a constraint. Simplest correct order wins.
 */

export interface ContextBudget {
  /** The model's total context window. */
  contextWindow: number;
  /** Tokens reserved for the answer. */
  maxOutputTokens: number;
  /** Fraction of the window passages may occupy. */
  share: number;
}

export interface AssembledContext {
  passages: RetrievedPassage[];
  /** Passages retrieved but left out because the budget ran out. */
  dropped: RetrievedPassage[];
  estimatedTokens: number;
  budgetTokens: number;
}

/**
 * How many tokens the passages may use.
 *
 * The smaller of two limits: a configured share of the window, and whatever is
 * genuinely left after the answer's reservation. The second matters when a
 * model has a small window or the output reservation is large, where a
 * percentage of the window alone would happily promise space that does not
 * exist.
 */
export function passageBudget(budget: ContextBudget): number {
  const byShare = Math.floor(budget.contextWindow * budget.share);
  // The remainder after the answer, less a margin for the instructions and the
  // question, which are small but not free.
  const INSTRUCTION_ALLOWANCE = 400;
  const byRemainder = budget.contextWindow - budget.maxOutputTokens - INSTRUCTION_ALLOWANCE;

  return Math.max(Math.min(byShare, byRemainder), 0);
}

/**
 * Takes passages in rank order until the budget is spent.
 *
 * The highest-ranked passage is always included, even if it alone exceeds the
 * budget. Returning nothing because the single best match was long would turn
 * a good result into "I could not find that", which is a worse answer than a
 * slightly cramped one, and the model's own truncation handles the overflow
 * more gracefully than we could.
 */
export function assembleContext(
  passages: RetrievedPassage[],
  budget: ContextBudget,
): AssembledContext {
  const budgetTokens = passageBudget(budget);
  const kept: RetrievedPassage[] = [];
  const dropped: RetrievedPassage[] = [];
  let used = 0;

  for (const passage of passages) {
    // `tokenCount` was computed at ingestion. Recomputed here rather than
    // trusted, because a chunk stored under a different CHUNK_SIZE would carry
    // a count that no longer describes it.
    const tokens = passage.tokenCount || estimateTokens(passage.content);

    if (kept.length > 0 && used + tokens > budgetTokens) {
      dropped.push(passage);
      continue;
    }

    kept.push(passage);
    used += tokens;
  }

  return { passages: kept, dropped, estimatedTokens: used, budgetTokens };
}
