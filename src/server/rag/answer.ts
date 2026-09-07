import 'server-only';

import type { ObjectId } from 'mongodb';

import { getLLMProvider } from '@/server/ai/factory';
import { getServerEnv } from '@/server/config/env';
import { logInfo } from '@/server/observability/logger';
import { assembleContext } from './build-context';
import {
  buildGroundedPrompt,
  GROUNDED_ANSWER_SYSTEM_PROMPT,
  NO_PASSAGES_ANSWER,
} from './prompts';
import { retrievePassages, type RetrievedPassage } from './retrieve';

/**
 * Question in, grounded answer out.
 *
 * ------------------------------------------------------------------
 * The whole of RAG, in four steps
 * ------------------------------------------------------------------
 *   1. Embed the question, so it can be compared with stored passages.
 *   2. Search for the passages closest to it in meaning.
 *   3. Put those passages in front of the model with instructions to use only
 *      them.
 *   4. Return the answer along with which passages it was allowed to see.
 *
 * Step 3 is the whole idea. The model is not being taught anything and nothing
 * is being fine-tuned. It is being handed the relevant page of the document at
 * the moment it is asked, exactly as you would hand a colleague the page
 * rather than expecting them to have memorised the file.
 *
 * ------------------------------------------------------------------
 * Why the passages come back to the caller
 * ------------------------------------------------------------------
 * The response carries the passages, not just the answer. That is what makes
 * the answer checkable: the reader can see the text it came from and judge for
 * themselves, instead of trusting a fluent paragraph.
 *
 * A RAG system that returns only prose is a system whose mistakes are
 * undetectable, and the mistakes are the reason all this machinery exists.
 */

export interface AnswerOptions {
  question: string;
  /** From the session, server-side. Never from the request body. */
  userId: ObjectId | string;
  /** Restricts the search to one document. */
  documentId?: ObjectId | string;
  signal?: AbortSignal;
}

export interface AnswerResult {
  answer: string;
  /** The passages the model was given. Empty when nothing matched. */
  passages: RetrievedPassage[];
  /** True when retrieval found nothing and no model call was made. */
  groundedInNothing: boolean;
  provider: string;
  model: string;
  embeddingModel: string;
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
  timings: { embedMs: number; searchMs: number; generateMs: number; totalMs: number };
}

export async function answerQuestion(options: AnswerOptions): Promise<AnswerResult> {
  const startedAt = Date.now();
  const env = getServerEnv();
  const provider = getLLMProvider();

  // ---- 1 and 2: embed, then search -----------------------------------------
  const retrieval = await retrievePassages({
    question: options.question,
    userId: options.userId,
    ...(options.documentId ? { documentId: options.documentId } : {}),
  });

  /**
   * Nothing matched, so nothing is asked.
   *
   * Calling the model with an empty passage list would be worse than useless.
   * It would spend a request to produce the one kind of answer this whole
   * application exists to prevent: a confident paragraph invented from
   * training data, with no document behind it.
   *
   * This is also the honest outcome for a corpus that has not been ingested
   * yet, which is exactly the state a new deployment is in.
   */
  if (retrieval.passages.length === 0) {
    logInfo(
      {
        operation: 'rag.answer',
        status: 'no_results',
        resultsReturned: 0,
        embeddingModel: retrieval.embeddingModel,
        durationMs: Date.now() - startedAt,
      },
      'No passages matched; skipping the model call',
    );

    return {
      answer: NO_PASSAGES_ANSWER,
      passages: [],
      groundedInNothing: true,
      provider: provider.id,
      model: provider.model,
      embeddingModel: retrieval.embeddingModel,
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
      timings: {
        embedMs: retrieval.embedMs,
        searchMs: retrieval.searchMs,
        generateMs: 0,
        totalMs: Date.now() - startedAt,
      },
    };
  }

  // ---- 3: fit them in the context window -----------------------------------
  const context = assembleContext(retrieval.passages, {
    contextWindow: env.LLM_CONTEXT_WINDOW,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    share: env.RETRIEVAL_CONTEXT_SHARE,
  });

  if (context.dropped.length > 0) {
    logInfo(
      {
        operation: 'rag.answer',
        status: 'context_trimmed',
        resultsReturned: context.passages.length,
        tokenCount: context.estimatedTokens,
        limit: context.budgetTokens,
      },
      'Dropped the lowest-ranked passages to stay inside the context budget',
    );
  }

  // ---- 4: ask ---------------------------------------------------------------
  const generateStartedAt = Date.now();

  const completion = await provider.complete({
    messages: [
      { role: 'system', content: GROUNDED_ANSWER_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildGroundedPrompt({
          question: options.question,
          passages: context.passages,
        }),
      },
    ],
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const generateMs = Date.now() - generateStartedAt;
  const totalMs = Date.now() - startedAt;

  /**
   * Shape only. Not the question, not the passages, not the answer.
   *
   * Everything here is a number, a model name or a score. `topScore` is the
   * useful one for judging retrieval without seeing any content: five passages
   * all scoring around 0.4 means the corpus does not cover the question, and
   * that shows up here without a single word of the document being written to
   * a log.
   */
  logInfo(
    {
      operation: 'rag.answer',
      status: 'completed',
      provider: provider.id,
      model: provider.model,
      embeddingModel: retrieval.embeddingModel,
      resultsReturned: context.passages.length,
      topScore: context.passages[0]?.score ?? 0,
      promptTokens: completion.usage.promptTokens,
      completionTokens: completion.usage.completionTokens,
      finishReason: completion.finishReason,
      durationMs: totalMs,
    },
    'Answered from retrieved passages',
  );

  return {
    answer: completion.text,
    passages: context.passages,
    groundedInNothing: false,
    provider: provider.id,
    model: provider.model,
    embeddingModel: retrieval.embeddingModel,
    usage: completion.usage,
    finishReason: completion.finishReason,
    timings: { embedMs: retrieval.embedMs, searchMs: retrieval.searchMs, generateMs, totalMs },
  };
}
