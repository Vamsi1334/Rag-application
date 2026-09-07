import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVoyageEmbeddingProvider } from '@/server/ai/providers/voyage';
import type { EmbeddingProviderConfig } from '@/server/ai/types';

/**
 * The Voyage embedding provider.
 *
 * Every test mocks `fetch`. No real key exists here and none is needed: the
 * value below is obviously fake, and one test asserts it never leaves the
 * Authorization header.
 *
 * The tests worth reading twice are the ones about ordering and dimension
 * validation. Both failures are silent in production: a shuffled response
 * stores every chunk against the wrong text, and a wrong-length vector
 * corrupts similarity scores for every later search. Neither throws on its
 * own, so they have to be caught here.
 */

const DIMENSIONS = 256;

const config: EmbeddingProviderConfig = {
  provider: 'voyage',
  model: 'voyage-4-lite',
  baseUrl: 'https://api.voyageai.com/v1',
  apiKey: 'pa-test-key-not-real',
  dimensions: DIMENSIONS,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
  // Generous, so the existing tests keep exercising one request per call.
  // The batching and pacing tests below build their own narrower configs.
  maxTokensPerRequest: 1_000_000,
  // 10,000 per minute is a six-millisecond gap: pacing stays wired up and
  // measurable without any test waiting on a real clock.
  requestsPerMinute: 10_000,
  tokensPerMinute: 100_000_000,
  maxRetries: 0,
};

/** A vector of the right shape, seeded so different rows are distinguishable. */
function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => (seed + i) / 1000);
}

function okResponse(rows: { embedding: number[]; index: number }[]): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: rows.map((row) => ({ object: 'embedding', ...row })),
      model: 'voyage-4-lite',
      usage: { total_tokens: 12 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('embedding text', () => {
  it('embeds a single query and returns one vector', async () => {
    fetchMock.mockResolvedValue(okResponse([{ embedding: vector(1), index: 0 }]));

    const result = await createVoyageEmbeddingProvider(config).embedQuery('what is AEO');

    expect(result).toHaveLength(DIMENSIONS);
    expect(result[0]).toBeCloseTo(0.001);
  });

  it('embeds several documents in one request', async () => {
    fetchMock.mockResolvedValue(
      okResponse([
        { embedding: vector(1), index: 0 },
        { embedding: vector(2), index: 1 },
        { embedding: vector(3), index: 2 },
      ]),
    );

    const result = await createVoyageEmbeddingProvider(config).embedDocuments(['a', 'b', 'c']);

    expect(result).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns early for an empty batch without calling the API', async () => {
    // A document with no extractable text produces no chunks. That is a valid
    // state, and Voyage rejects an empty input array, so it must not be sent.
    const result = await createVoyageEmbeddingProvider(config).embedDocuments([]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the request it sends', () => {
  beforeEach(() => {
    // A fresh Response per call. A body can only be read once, so a single
    // shared instance fails the second time it is used.
    fetchMock.mockImplementation(() =>
      Promise.resolve(okResponse([{ embedding: vector(1), index: 0 }])),
    );
  });

  it('marks stored passages and questions differently', async () => {
    const provider = createVoyageEmbeddingProvider(config);

    await provider.embedDocuments(['a stored passage']);
    const documentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    await provider.embedQuery('a question');
    const queryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));

    // The asymmetry that makes retrieval work. Getting these the wrong way
    // round does not error, it just quietly degrades every search.
    expect(documentBody.input_type).toBe('document');
    expect(queryBody.input_type).toBe('query');
  });

  it('asks for the configured dimensions rather than the default', async () => {
    await createVoyageEmbeddingProvider(config).embedQuery('hello');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    // Voyage returns 1024 unless told otherwise. Storing 1024-long vectors in
    // a 256 index fails, and four times the storage on a 512MB cluster.
    expect(body.output_dimension).toBe(DIMENSIONS);
    expect(body.model).toBe('voyage-4-lite');
  });

  it('does not prepend the Ollama-style task prefixes', async () => {
    await createVoyageEmbeddingProvider(config).embedDocuments(['plain text']);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    // Voyage adds its own instruction server-side via input_type. Prepending
    // nomic's prefix as well would give the model two competing hints.
    expect(body.input[0]).toBe('plain text');
    expect(body.input[0]).not.toContain('search_document');
  });

  it('sends the key in a header and never in the URL or body', async () => {
    await createVoyageEmbeddingProvider(config).embedQuery('hello');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;

    expect(headers.authorization).toBe('Bearer pa-test-key-not-real');
    // URLs reach access logs, browser history and error trackers. Headers do not.
    expect(String(url)).not.toContain('pa-test-key-not-real');
    expect(String((init as RequestInit).body)).not.toContain('pa-test-key-not-real');
  });

  it('splits a large set into several requests', async () => {
    // 300 chunks exceeds the internal batch size, so this must not become one
    // enormous request that trips the per-request token ceiling.
    const texts = Array.from({ length: 300 }, (_, i) => `chunk ${i}`);

    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return Promise.resolve(
        okResponse(body.input.map((_text, index) => ({ embedding: vector(index), index }))),
      );
    });

    const result = await createVoyageEmbeddingProvider(config).embedDocuments(texts);

    expect(result).toHaveLength(300);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('response handling', () => {
  it('reorders by the index Voyage reports, not by array position', async () => {
    // The API documents an `index` per row precisely because order is not
    // guaranteed. Ignoring it would store every chunk against the wrong text,
    // and retrieval would return confidently wrong passages forever.
    fetchMock.mockResolvedValue(
      okResponse([
        { embedding: vector(300), index: 2 },
        { embedding: vector(100), index: 0 },
        { embedding: vector(200), index: 1 },
      ]),
    );

    const result = await createVoyageEmbeddingProvider(config).embedDocuments(['a', 'b', 'c']);

    expect(result[0]?.[0]).toBeCloseTo(0.1);
    expect(result[1]?.[0]).toBeCloseTo(0.2);
    expect(result[2]?.[0]).toBeCloseTo(0.3);
  });

  it('rejects a vector of the wrong length', async () => {
    fetchMock.mockResolvedValue(okResponse([{ embedding: [0.1, 0.2, 0.3], index: 0 }]));

    await expect(
      createVoyageEmbeddingProvider(config).embedQuery('hello'),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('rejects a vector containing a non-finite number', async () => {
    // A NaN in the index corrupts similarity scores in a way that is nearly
    // impossible to trace back to its source months later.
    const poisoned = vector(1);
    poisoned[5] = Number.NaN;
    fetchMock.mockResolvedValue(okResponse([{ embedding: poisoned, index: 0 }]));

    await expect(
      createVoyageEmbeddingProvider(config).embedQuery('hello'),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('rejects a response with the wrong number of vectors', async () => {
    fetchMock.mockResolvedValue(okResponse([{ embedding: vector(1), index: 0 }]));

    await expect(
      createVoyageEmbeddingProvider(config).embedDocuments(['a', 'b']),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('rejects a body that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway error</html>', { status: 200 }));

    await expect(
      createVoyageEmbeddingProvider(config).embedQuery('hello'),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });
});

describe('failures', () => {
  const cases: { status: number; code: string; label: string }[] = [
    { status: 401, code: 'LLM_UNAVAILABLE', label: 'an invalid API key' },
    { status: 403, code: 'LLM_UNAVAILABLE', label: 'a forbidden key' },
    { status: 402, code: 'LLM_UNAVAILABLE', label: 'exhausted credit' },
    { status: 404, code: 'LLM_MODEL_NOT_FOUND', label: 'an unknown model' },
    { status: 429, code: 'LLM_UNAVAILABLE', label: 'a rate limit' },
    { status: 400, code: 'LLM_INVALID_RESPONSE', label: 'a malformed request' },
    { status: 500, code: 'LLM_UNAVAILABLE', label: 'a server error' },
  ];

  for (const { status, code, label } of cases) {
    it(`maps ${label} (${status}) to ${code}`, async () => {
      fetchMock.mockResolvedValue(new Response('{"detail":"nope"}', { status }));

      await expect(
        createVoyageEmbeddingProvider(config).embedQuery('hello'),
      ).rejects.toMatchObject({ code });
    });
  }

  it('names the variable to fix when the key is rejected', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    try {
      await createVoyageEmbeddingProvider(config).embedQuery('hello');
      expect.unreachable('should have thrown');
    } catch (error) {
      const appError = error as { logMeta: { variable?: string }; safeMessage: string };
      // The log says which variable. The user-facing message does not, and
      // neither carries any part of the key.
      expect(appError.logMeta.variable).toBe('VOYAGE_API_KEY');
      expect(appError.safeMessage).not.toContain('pa-test-key-not-real');
      expect(appError.safeMessage).not.toContain('VOYAGE_API_KEY');
    }
  });

  it('never leaks the provider own error text to the user', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"detail":"key pa-test-key-not-real is invalid"}', { status: 401 }),
    );

    try {
      await createVoyageEmbeddingProvider(config).embedQuery('hello');
      expect.unreachable('should have thrown');
    } catch (error) {
      const appError = error as { safeMessage: string; message: string };
      expect(appError.safeMessage).not.toContain('pa-test-key-not-real');
      expect(appError.message).not.toContain('pa-test-key-not-real');
    }
  });

  it('maps a network failure to an unavailable error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      createVoyageEmbeddingProvider(config).embedQuery('hello'),
    ).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });

  it('maps an aborted request to a timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    await expect(
      createVoyageEmbeddingProvider(config).embedQuery('hello'),
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
  });
});

describe('staying inside the rate limit', () => {
  /**
   * The bug this section exists because of.
   *
   * Ingesting a real 62-page PDF produced 49 chunks, batched by COUNT into a
   * single request of roughly 17,000 estimated tokens. Voyage's free trial
   * allows 3 requests and 10,000 tokens per minute, so the request was refused
   * on arrival, every time, and no amount of retrying could have helped: the
   * request itself was over the ceiling.
   *
   * Batching by count alone is what turned arithmetic into what looked like
   * bad luck. These tests are about the token budget, the pacing that keeps
   * requests inside the per-minute allowance, and the retry that rides out the
   * 429s that still happen.
   */

  /** ~1,000 estimated tokens each, at four characters per token. */
  function passage(index: number): string {
    return `${index} `.padEnd(4000, 'word ');
  }

  function respondToWhateverIsAsked(): void {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return Promise.resolve(
        okResponse(body.input.map((_text, index) => ({ embedding: vector(index), index }))),
      );
    });
  }

  it('splits by estimated tokens, not by chunk count', async () => {
    respondToWhateverIsAsked();

    // Ten passages of ~1,000 tokens against a 3,000-token budget: four
    // requests. Count-based batching would have sent one.
    const provider = createVoyageEmbeddingProvider({
      ...config,
      maxTokensPerRequest: 3000,
    });

    await provider.embedDocuments(Array.from({ length: 10 }, (_, i) => passage(i)));

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);

    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      const tokens = input.reduce((total, text) => total + Math.ceil(text.length / 4), 0);
      // The whole point: no single request may exceed the budget.
      expect(tokens).toBeLessThanOrEqual(3000);
    }
  });

  it('keeps every passage, in order, across the split', async () => {
    // A batching bug that dropped or reordered passages would be invisible
    // until retrieval started returning the wrong text months later.
    respondToWhateverIsAsked();

    const texts = Array.from({ length: 10 }, (_, i) => passage(i));
    const provider = createVoyageEmbeddingProvider({ ...config, maxTokensPerRequest: 3000 });

    const result = await provider.embedDocuments(texts);

    expect(result).toHaveLength(texts.length);

    const sent = (fetchMock.mock.calls as [string, RequestInit][]).flatMap(
      ([, init]) => (JSON.parse(String(init.body)) as { input: string[] }).input,
    );
    expect(sent).toEqual(texts);
  });

  it('gives an oversized passage its own request rather than dropping it', async () => {
    respondToWhateverIsAsked();

    const huge = 'x'.repeat(40_000); // ~10,000 tokens, over the budget alone
    const provider = createVoyageEmbeddingProvider({ ...config, maxTokensPerRequest: 3000 });

    const result = await provider.embedDocuments(['short', huge, 'also short']);

    // Truncation is Voyage's decision, asked for in the request body. Silently
    // discarding the passage here would lose part of a document with nothing
    // reporting that it happened.
    expect(result).toHaveLength(3);
    const bodies = (fetchMock.mock.calls as [string, RequestInit][]).map(
      ([, init]) => (JSON.parse(String(init.body)) as { input: string[] }).input,
    );
    expect(bodies.some((input) => input.length === 1 && input[0] === huge)).toBe(true);
  });

  it('paces requests to the configured rate', async () => {
    respondToWhateverIsAsked();

    // 600 per minute is a 100ms gap. Three requests means two gaps.
    const provider = createVoyageEmbeddingProvider({
      ...config,
      maxTokensPerRequest: 1200,
      requestsPerMinute: 600,
    });

    const startedAt = Date.now();
    await provider.embedDocuments(Array.from({ length: 3 }, (_, i) => passage(i)));
    const elapsed = Date.now() - startedAt;

    expect(fetchMock.mock.calls).toHaveLength(3);
    // Without pacing this is a handful of milliseconds.
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it('does not pace a single request', async () => {
    // A question a person is waiting on must not be delayed by a limit that
    // only matters when embedding a whole document.
    respondToWhateverIsAsked();

    const provider = createVoyageEmbeddingProvider({ ...config, requestsPerMinute: 3 });

    const startedAt = Date.now();
    await provider.embedQuery('what is answer engine optimisation');

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('riding out a rate limit', () => {
  function rateLimitedThenOk(failures: number, headers?: Record<string, string>): void {
    let calls = 0;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      calls += 1;
      if (calls <= failures) {
        return Promise.resolve(new Response('{"detail":"slow down"}', { status: 429, headers }));
      }
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return Promise.resolve(
        okResponse(body.input.map((_text, index) => ({ embedding: vector(index), index }))),
      );
    });
  }

  it('retries a 429 and succeeds', async () => {
    // On a free tier a 429 is an ordinary event, not an exceptional one.
    // Failing the whole document because of one means an operator retries by
    // hand what the code could have waited out.
    rateLimitedThenOk(2, { 'retry-after': '0' });

    const provider = createVoyageEmbeddingProvider({ ...config, maxRetries: 3 });
    const result = await provider.embedQuery('hello');

    expect(result).toHaveLength(DIMENSIONS);
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  it('gives up after the configured number of retries', async () => {
    rateLimitedThenOk(99, { 'retry-after': '0' });

    const provider = createVoyageEmbeddingProvider({ ...config, maxRetries: 2 });

    await expect(provider.embedQuery('hello')).rejects.toMatchObject({ httpStatus: 429 });
    // The first attempt plus two retries.
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  it('says what to change, rather than telling the operator to wait', async () => {
    /**
     * The message is only ever seen AFTER the code has already waited, so
     * "try again in a moment" is actively misleading: if the per-request
     * budget is itself over the limit, no amount of waiting helps.
     */
    rateLimitedThenOk(99, { 'retry-after': '0' });

    try {
      await createVoyageEmbeddingProvider({ ...config, maxRetries: 0 }).embedQuery('hello');
      expect.unreachable('should have thrown');
    } catch (error) {
      const { safeMessage } = error as { safeMessage: string };
      expect(safeMessage).toMatch(/EMBEDDING_MAX_TOKENS_PER_REQUEST/);
      expect(safeMessage).toMatch(/payment method/);
      expect(safeMessage).not.toMatch(/wait a moment/i);
    }
  });

  it('does not retry a rejected key', async () => {
    // It would fail identically every time, and burn a minute of backoff
    // before showing the same error.
    fetchMock.mockResolvedValue(new Response('{"detail":"nope"}', { status: 401 }));

    const provider = createVoyageEmbeddingProvider({ ...config, maxRetries: 4 });

    await expect(provider.embedQuery('hello')).rejects.toMatchObject({ httpStatus: 503 });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });
});
