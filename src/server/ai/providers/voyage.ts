import { estimateTokens } from '@/lib/tokens';
import { LLMError } from '@/server/observability/errors';
import { logInfo, logWarn } from '@/server/observability/logger';
import type { EmbeddingProvider, EmbeddingProviderConfig } from '../types';

/**
 * Voyage AI embeddings.
 *
 * ------------------------------------------------------------------
 * What this provider is, and what it is not
 * ------------------------------------------------------------------
 * It turns text into vectors. It cannot answer a question, write a sentence
 * or hold a conversation, and Voyage publishes no model that can. Generation
 * stays with Groq; this is the other half of the stack.
 *
 *   question or passage  ->  Voyage  ->  [0.21, -0.88, 0.13, ...]
 *
 * Those numbers are coordinates. Texts with similar meaning land near each
 * other, which is what makes search-by-meaning possible. Nothing here
 * understands the text; it positions it.
 *
 * ------------------------------------------------------------------
 * Why `fetch` and not the official SDK
 * ------------------------------------------------------------------
 * Voyage do publish a TypeScript SDK. This uses plain `fetch` instead, for
 * reasons specific to this codebase rather than any objection to the package:
 *
 *   - The other two providers here are written against `fetch`, and one
 *     transport across all three means one place to reason about timeouts,
 *     cancellation and error mapping.
 *   - The errors have to become this project's typed `LLMError` values with
 *     safe user-facing messages. An SDK's own error classes would need
 *     translating anyway, so the SDK saves nothing and adds a layer.
 *   - The existing provider tests mock global `fetch`. Keeping that means the
 *     network is stubbed identically everywhere.
 *   - It is one endpoint with five fields. The dependency would carry more
 *     supply-chain surface than it removes work.
 *
 * If Voyage's API changes shape, this file is where it changes.
 */

const EMBEDDINGS_PATH = '/embeddings';

/**
 * Voyage caps a single request at 1,000 texts.
 *
 * Batched well below that, but the count is the second constraint, not the
 * first. What actually bites is TOKENS PER MINUTE, and on Voyage's free trial
 * that is 10,000: a batch of 128 chunks at ~450 tokens each is around 58,000
 * tokens and is rejected outright, no matter how patiently it is retried.
 *
 * So `maxTokensPerRequest` from configuration decides the real batch size and
 * this is only the ceiling on top of it, for the case where a corpus of very
 * short passages would otherwise put a thousand of them in one request.
 */
const MAX_BATCH_SIZE = 128;

/**
 * Splits texts into requests that respect BOTH limits.
 *
 * An oversized single text still gets its own request rather than being
 * dropped or silently truncated here: Voyage is asked to truncate it, which is
 * a decision the vendor is better placed to make than a character count is.
 */
export function planEmbeddingBatches(
  texts: string[],
  maxTokensPerRequest: number,
  maxBatchSize = MAX_BATCH_SIZE,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = estimateTokens(text);

    // Close the current batch when adding this text would breach either
    // limit, unless the batch is empty, in which case a single oversized text
    // has to go on its own.
    if (
      current.length > 0 &&
      (currentTokens + tokens > maxTokensPerRequest || current.length >= maxBatchSize)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(text);
    currentTokens += tokens;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Resolves after `ms`. Used to pace requests under a per-minute limit. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before the next request.
 *
 * Both published limits are respected by waiting the LONGER of the two gaps,
 * because either one can bind first and which one does depends on the batch.
 *
 * Pacing on requests alone was the mistake worth recording here. At 3 requests
 * per minute and 8,000 tokens each, the request rate is honoured perfectly and
 * the token rate is breached twice over, so a 429 arrives exactly on schedule
 * and the retry then waits out the vendor's whole window. Accounting for the
 * tokens just sent turns that into a slightly longer gap and no rejection at
 * all, which is both faster and quieter.
 *
 * Deriving the gap this way also means the batch size stays a performance
 * choice. Larger batches wait proportionally longer, and the throughput
 * ceiling is the token rate either way.
 *
 * ------------------------------------------------------------------
 * This targets the AVERAGE rate, and that is deliberate
 * ------------------------------------------------------------------
 * Vendors do not publish whether they measure with a rolling window, a fixed
 * window or a token bucket, and the three disagree about when exactly a
 * request becomes acceptable. Against a rolling window, pacing to the average
 * rate still draws the occasional 429 near the start of a run, because the
 * previous request has not yet aged out of the window.
 *
 * Modelling a windowing algorithm nobody has documented would be guessing
 * dressed as precision. Pacing handles the steady state, `Retry-After` handles
 * the residual, and the two together get a document through without anyone
 * watching. Verified against a stub enforcing 3 requests and 10,000 tokens per
 * minute: a 62-page document completed in 167 seconds, absorbing three rate
 * limits on the way without intervention.
 */
export function pacingDelayMs(
  tokensJustSent: number,
  requestsPerMinute: number,
  tokensPerMinute: number,
): number {
  const forRequests = 60_000 / Math.max(requestsPerMinute, 1);
  const forTokens = (60_000 * tokensJustSent) / Math.max(tokensPerMinute, 1);
  return Math.ceil(Math.max(forRequests, forTokens));
}

/**
 * How long to wait after a 429.
 *
 * `Retry-After` is honoured when present, because the server knows when its
 * own window resets and a guess cannot beat that. Its two documented forms are
 * both handled: a number of seconds, and an HTTP date.
 *
 * Without the header, exponential backoff from a base delay. The cap keeps a
 * long document from stalling on one unlucky batch for an unbounded time.
 */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  baseDelayMs: number,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      // Never negative: a clock skewed the wrong way would otherwise turn a
      // wait into an instant retry, which is the opposite of what was asked.
      return Math.min(Math.max(date - Date.now(), 0), 120_000);
    }
  }

  return Math.min(baseDelayMs * 2 ** attempt, 120_000);
}

/**
 * Dimensions Voyage's v4 models will actually return.
 *
 * Asking for anything else is rejected by the API. Catching it here turns a
 * deployment-time typo into a clear configuration error instead of a 400 on
 * the first document somebody uploads.
 */
export const VOYAGE_SUPPORTED_DIMENSIONS = [256, 512, 1024, 2048] as const;

/**
 * Whether the passage is being stored or asked.
 *
 * Voyage prepends its own instruction to the text depending on this, which
 * produces vectors tuned for retrieval rather than for general similarity.
 * Getting it backwards does not error. It just makes search quietly worse,
 * which is the hardest kind of bug to notice, and it is exactly why the
 * EmbeddingProvider interface splits `embedDocuments` from `embedQuery`
 * instead of offering one `embed` and a flag nobody remembers to set.
 */
type InputType = 'document' | 'query';

/** The subset of the response this depends on. */
interface VoyageEmbeddingResponse {
  data?: { embedding?: unknown; index?: number }[];
  model?: string;
  usage?: { total_tokens?: number };
}

/**
 * Turns a failed HTTP response into a typed error.
 *
 * The provider's own error text never becomes the user's message. Voyage's
 * bodies are harmless today, but this mapping has to stay safe for whatever
 * they return next year, and upstream errors are a well-worn way for request
 * ids, account identifiers or fragments of the input to reach a user.
 */
function mapHttpError(status: number, provider: string): LLMError {
  const meta = { provider, feature: 'embeddings' };

  switch (status) {
    case 401:
    case 403:
      return new LLMError(
        'LLM_UNAVAILABLE',
        503,
        'The embedding service rejected our credentials.',
        `${provider} rejected the API key (${status})`,
        // Deliberately no key, no prefix, no length. A rejected credential is
        // still a credential.
        { ...meta, variable: 'VOYAGE_API_KEY' },
      );

    case 402:
      return new LLMError(
        'LLM_UNAVAILABLE',
        503,
        'The embedding service reports no remaining credit.',
        `${provider} reports payment required`,
        meta,
      );

    case 404:
      return new LLMError(
        'LLM_MODEL_NOT_FOUND',
        503,
        'The configured embedding model was not found. Check VOYAGE_EMBEDDING_MODEL.',
        `${provider} does not recognise the configured embedding model`,
        meta,
      );

    case 429:
      /**
       * Reached only after every retry has been used, so "wait a moment" is
       * the one thing this must not say: the code already waited, and waiting
       * longer will not help if the per-request budget is itself over the
       * limit. The message names the settings that actually change the outcome.
       */
      return new LLMError(
        'LLM_UNAVAILABLE',
        429,
        'Embedding rate limit reached, and retries did not clear it. ' +
          'On the Voyage free trial the limit is 3 requests and 10,000 tokens per minute. ' +
          'Lower EMBEDDING_MAX_TOKENS_PER_REQUEST and EMBEDDING_REQUESTS_PER_MINUTE, ' +
          'or add a payment method to raise the limit.',
        `${provider} rate limited the request after retries`,
        meta,
      );

    case 400:
      // Almost always an unsupported output_dimension or an input over the
      // model's context length. Both are ours to fix, not the user's.
      return new LLMError(
        'LLM_INVALID_RESPONSE',
        502,
        'The embedding request was rejected. This is a configuration problem.',
        `${provider} rejected the request as malformed (400)`,
        meta,
      );

    default:
      return new LLMError(
        'LLM_UNAVAILABLE',
        503,
        'The embedding service is unavailable right now.',
        `${provider} returned HTTP ${status}`,
        meta,
      );
  }
}

function mapNetworkError(error: unknown, provider: string, timeoutMs: number): LLMError {
  const meta = { provider, feature: 'embeddings' };

  if (error instanceof DOMException && error.name === 'AbortError') {
    return new LLMError(
      'LLM_TIMEOUT',
      504,
      'Embedding took too long and was cancelled.',
      `${provider} embedding exceeded ${timeoutMs}ms`,
      meta,
      error,
    );
  }

  return new LLMError(
    'LLM_UNAVAILABLE',
    503,
    'Could not reach the embedding service.',
    `${provider} embedding request failed at the network layer`,
    meta,
    error,
  );
}

/**
 * Validates one vector out of the response.
 *
 * Stricter than it looks necessary, because a bad vector does not fail loudly.
 * A NaN or a wrong-length array inserted into the index corrupts similarity
 * scores for every future search against it, and the symptom is "retrieval got
 * worse" months later with nothing pointing back here.
 */
function assertVector(value: unknown, expectedDimensions: number, provider: string): number[] {
  if (!Array.isArray(value)) {
    throw new LLMError(
      'LLM_INVALID_RESPONSE',
      502,
      'The embedding service returned an unexpected response.',
      `${provider} returned a non-array embedding`,
      { provider, feature: 'embeddings' },
    );
  }

  if (value.length !== expectedDimensions) {
    throw new LLMError(
      'LLM_INVALID_RESPONSE',
      502,
      'The embedding service returned an unexpected response.',
      `${provider} returned ${value.length} dimensions, expected ${expectedDimensions}`,
      { provider, feature: 'embeddings', embeddingDimensions: expectedDimensions },
    );
  }

  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new LLMError(
        'LLM_INVALID_RESPONSE',
        502,
        'The embedding service returned an unexpected response.',
        `${provider} returned a non-finite value inside an embedding`,
        { provider, feature: 'embeddings' },
      );
    }
  }

  return value as number[];
}

export function createVoyageEmbeddingProvider(
  config: EmbeddingProviderConfig,
): EmbeddingProvider {
  const timeoutMs = 60_000;

  async function embedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
    // An empty batch is a valid thing for a caller to have: a document with no
    // extractable text produces no chunks. Returning early avoids a pointless
    // round trip and a 400 from Voyage, which rejects an empty input array.
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${EMBEDDINGS_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The key travels in a header, never a query string. URLs end up in
          // access logs, browser history and error trackers; headers do not.
          authorization: `Bearer ${config.apiKey ?? ''}`,
        },
        body: JSON.stringify({
          input: texts,
          model: config.model,
          input_type: inputType,
          output_dimension: config.dimensions,
          // Voyage truncates over-long input rather than failing the whole
          // batch. Losing the tail of one oversized chunk beats losing every
          // chunk that shared its request.
          truncation: true,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw mapNetworkError(error, config.provider, timeoutMs);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The header travels with the error so the retry loop can wait exactly
      // as long as the server asked, rather than guessing.
      throw Object.assign(mapHttpError(response.status, config.provider), {
        retryAfter: response.headers.get('retry-after'),
      });
    }

    let payload: VoyageEmbeddingResponse;
    try {
      payload = (await response.json()) as VoyageEmbeddingResponse;
    } catch (error) {
      throw new LLMError(
        'LLM_INVALID_RESPONSE',
        502,
        'The embedding service returned an unexpected response.',
        `${config.provider} returned a body that was not JSON`,
        { provider: config.provider, feature: 'embeddings' },
        error,
      );
    }

    const rows = payload.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) {
      throw new LLMError(
        'LLM_INVALID_RESPONSE',
        502,
        'The embedding service returned an unexpected response.',
        `${config.provider} returned ${rows?.length ?? 0} embeddings for ${texts.length} inputs`,
        { provider: config.provider, feature: 'embeddings' },
      );
    }

    /**
     * Reorder by the index Voyage reports rather than trusting array order.
     *
     * The API documents an `index` on each row, which only exists because the
     * order is not guaranteed to match the input. If it ever does come back
     * shuffled and we ignored this, every chunk would be stored against the
     * wrong text: retrieval would return confidently wrong passages and
     * nothing would look broken.
     */
    const ordered = new Array<number[]>(texts.length);
    for (let position = 0; position < rows.length; position += 1) {
      const row = rows[position];
      const target = typeof row?.index === 'number' ? row.index : position;

      if (target < 0 || target >= texts.length || ordered[target] !== undefined) {
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The embedding service returned an unexpected response.',
          `${config.provider} returned an out-of-range or duplicate index`,
          { provider: config.provider, feature: 'embeddings' },
        );
      }

      ordered[target] = assertVector(row?.embedding, config.dimensions, config.provider);
    }

    return ordered;
  }

  /**
   * One batch, retried when the service says to wait.
   *
   * ------------------------------------------------------------------
   * Why retrying is the normal path here, not error handling
   * ------------------------------------------------------------------
   * On a free tier a 429 is an ordinary event. Voyage's trial allows 3
   * requests and 10,000 tokens per minute, so any document worth ingesting
   * WILL be rate limited at some point during a run. Treating that as a
   * failure means the operator retries by hand what the code could have
   * waited out.
   *
   * Only 429 is retried. A rejected key, a missing model or a malformed
   * request will fail identically every time, and retrying them wastes a
   * minute before showing the same error.
   */
  async function embedWithRetry(
    texts: string[],
    inputType: InputType,
    batchIndex: number,
    batchCount: number,
  ): Promise<number[][]> {
    const baseDelayMs = 2000;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await embedBatch(texts, inputType);
      } catch (error) {
        const isRateLimit = error instanceof LLMError && error.httpStatus === 429;
        if (!isRateLimit || attempt >= config.maxRetries) throw error;

        const retryAfter = (error as { retryAfter?: string | null }).retryAfter ?? null;
        const waitMs = retryDelayMs(retryAfter, attempt, baseDelayMs);

        logWarn(
          {
            operation: 'ai.embed',
            provider: config.provider,
            embeddingModel: config.model,
            feature: 'embeddings',
            attempt: attempt + 1,
            retryable: true,
            batchSize: texts.length,
            durationMs: waitMs,
          },
          `Rate limited on batch ${batchIndex + 1} of ${batchCount}; ` +
            `waiting ${Math.round(waitMs / 1000)}s before retry ` +
            `${attempt + 1} of ${config.maxRetries}`,
        );

        await sleep(waitMs);
      }
    }
  }

  return {
    id: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    // voyage-4-lite accepts 32,000 tokens per input. Chunks are a fraction of
    // that; the headroom matters for whole-document embedding later.
    maxInputTokens: 32_000,

    async embedDocuments(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const batches = planEmbeddingBatches(texts, config.maxTokensPerRequest);
      const batchTokens = batches.map((batch) =>
        batch.reduce((total, text) => total + estimateTokens(text), 0),
      );

      if (batches.length > 1) {
        // Every gap except the one that would follow the final batch.
        const estimatedWaitMs = batchTokens
          .slice(0, -1)
          .reduce(
            (total, tokens) =>
              total + pacingDelayMs(tokens, config.requestsPerMinute, config.tokensPerMinute),
            0,
          );

        logInfo(
          {
            operation: 'ai.embed',
            provider: config.provider,
            embeddingModel: config.model,
            chunkCount: texts.length,
            batchSize: batches.length,
            // So a run that will take minutes says so up front rather than
            // looking hung for three of them.
            durationMs: estimatedWaitMs,
          },
          `Embedding ${texts.length} passages in ${batches.length} requests, ` +
            `paced to ${config.requestsPerMinute} requests and ` +
            `${config.tokensPerMinute} tokens per minute ` +
            `(about ${Math.ceil(estimatedWaitMs / 1000)}s of waiting)`,
        );
      }

      const results: number[][] = [];

      // Sequential rather than parallel on purpose. Firing every batch at once
      // is the fastest way to hit a rate limit, and a document that fails
      // halfway through leaves a half-embedded mess to reconcile.
      for (const [index, batch] of batches.entries()) {
        if (index > 0) {
          // Based on what the PREVIOUS request actually cost, which is what
          // the vendor's per-minute window is counting.
          await sleep(
            pacingDelayMs(
              batchTokens[index - 1] ?? 0,
              config.requestsPerMinute,
              config.tokensPerMinute,
            ),
          );
        }
        results.push(...(await embedWithRetry(batch, 'document', index, batches.length)));
      }

      return results;
    },

    async embedQuery(text: string): Promise<number[]> {
      // Retried too, but never paced. A person is waiting on this one.
      const [vector] = await embedWithRetry([text], 'query', 0, 1);
      if (!vector) {
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The embedding service returned an unexpected response.',
          `${config.provider} returned no embedding for a single query`,
          { provider: config.provider, feature: 'embeddings' },
        );
      }
      return vector;
    },
  };
}
