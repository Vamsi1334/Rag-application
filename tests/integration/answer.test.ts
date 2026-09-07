import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

/**
 * The answer pipeline, against a real database.
 *
 * ------------------------------------------------------------------
 * What this can and cannot reach
 * ------------------------------------------------------------------
 * `$vectorSearch` runs inside Atlas Search, which is not part of mongod and is
 * therefore absent here. So the ranking itself cannot be exercised, and the
 * search is stubbed at the repository boundary.
 *
 * The shape of the query that WOULD be sent is asserted exactly in
 * `tests/unit/vector-search-filter.test.ts`, which is where the ownership
 * filter is pinned down. What this file covers is everything around the
 * search: that a question is embedded as a QUERY rather than a document, that
 * an empty result never reaches the model, that the passages the model was
 * given come back to the caller, and that neither the question nor the
 * document text is ever written to a log.
 */

const DIMENSIONS = 256;
const FAKE_VOYAGE_KEY = 'pa-test-key-not-real';
const FAKE_GROQ_KEY = 'gsk-test-key-not-real';

/** Swappable stub for the vector search, since Atlas Search is not available. */
const searchStub: {
  current: (() => Promise<
    import('@/server/db/repositories/document-chunks.repo').ScoredChunk[]
  >) | null;
} = { current: null };

/**
 * The logger, captured rather than silenced.
 *
 * Inspecting the FIELDS handed to the logger is stronger than reading its
 * output, because it proves the calling code never passes private content in
 * the first place. Asserting on rendered output would only prove that
 * redaction happened to strip it this time, and redaction is a safety net, not
 * the design.
 */
const logInfoMock = vi.fn();
const logWarnMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock('@/server/observability/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/observability/logger')>();
  return {
    ...actual,
    logInfo: logInfoMock,
    logWarn: logWarnMock,
    logError: logErrorMock,
  };
});

vi.mock('@/server/db/repositories/document-chunks.repo', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/server/db/repositories/document-chunks.repo')>();
  return {
    ...actual,
    searchChunksByVector: async (...args: unknown[]) =>
      searchStub.current
        ? searchStub.current()
        : (actual.searchChunksByVector as (...a: unknown[]) => Promise<unknown>)(...args),
  };
});

let mongo: MongoMemoryServer;

type Modules = {
  answer: typeof import('@/server/rag/answer');
  client: typeof import('@/server/db/client');
};

let mod: Modules;

const fetchMock = vi.fn();
const user = new ObjectId().toHexString();

function vector(seed: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => (seed + i) / 10_000);
}

function chunk(rank: number, content: string) {
  return {
    chunkId: new ObjectId().toHexString(),
    documentId: new ObjectId().toHexString(),
    chunkIndex: rank - 1,
    content,
    tokenCount: Math.ceil(content.length / 4),
    sourceName: 'growth-os.pdf',
    pageNumber: rank,
    score: 0.9 - rank * 0.05,
  };
}

/** Answers an embedding call the way Voyage does, and a chat call like Groq. */
function stubProviders(answerText = 'Search intent decides which page ranks [1].'): void {
  fetchMock.mockImplementation((url: string, init: RequestInit) => {
    if (String(url).includes('/embeddings')) {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            model: 'voyage-4-lite',
            data: body.input.map((_text, index) => ({
              object: 'embedding',
              index,
              embedding: vector(index + 1),
            })),
            usage: { total_tokens: 8 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{ index: 0, message: { role: 'assistant', content: answerText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });
}

/** The body of the embedding request, so input_type can be asserted. */
function embeddingRequestBody(): { input: string[]; input_type: string } {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/embeddings'));
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

/** The body of the chat request, so the prompt can be asserted. */
function chatRequestBody(): { messages: { role: string; content: string }[] } {
  const call = fetchMock.mock.calls.find(([url]) => !String(url).includes('/embeddings'));
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();

  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB_NAME = 'answer_test';
  process.env.EMBEDDING_PROVIDER = 'voyage';
  process.env.EMBEDDING_DIMENSIONS = String(DIMENSIONS);
  process.env.VOYAGE_API_KEY = FAKE_VOYAGE_KEY;
  process.env.EMBEDDING_REQUESTS_PER_MINUTE = '10000';
  process.env.EMBEDDING_TOKENS_PER_MINUTE = '100000000';
  process.env.EMBEDDING_MAX_RETRIES = '0';
  process.env.LLM_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = FAKE_GROQ_KEY;
  process.env.LLM_CONTEXT_WINDOW = '8192';
  process.env.LLM_MAX_OUTPUT_TOKENS = '2048';
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.LLM_API_KEY;

  const { resetServerEnvCache } = await import('@/server/config/env');
  resetServerEnvCache();

  mod = {
    answer: await import('@/server/rag/answer'),
    client: await import('@/server/db/client'),
  };
}, 120_000);

afterAll(async () => {
  await mod?.client.closeMongoClient();
  await mongo?.stop();
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  logInfoMock.mockReset();
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  searchStub.current = null;
  vi.unstubAllGlobals();
});

describe('answering from retrieved passages', () => {
  it('embeds the question, searches, and answers from what came back', async () => {
    stubProviders();
    searchStub.current = async () => [
      chunk(1, 'Search intent decides which page ranks for a query.'),
      chunk(2, 'Answer engines quote sources that state claims plainly.'),
    ];

    const result = await mod.answer.answerQuestion({
      question: 'What decides which page ranks?',
      userId: user,
    });

    expect(result.answer).toContain('Search intent');
    expect(result.passages).toHaveLength(2);
    expect(result.groundedInNothing).toBe(false);
    expect(result.usage.promptTokens).toBe(120);
  });

  it('marks the question as a query, not as a document', async () => {
    /**
     * Voyage embeds a passage and a question differently on purpose, and the
     * two are designed to line up. Getting this backwards does not error; it
     * silently makes every search worse, which is the hardest kind of bug to
     * notice and the easiest to introduce.
     */
    stubProviders();
    searchStub.current = async () => [chunk(1, 'text')];

    await mod.answer.answerQuestion({ question: 'what is AEO', userId: user });

    expect(embeddingRequestBody().input_type).toBe('query');
  });

  it('gives the model the passages and the grounding instruction', async () => {
    stubProviders();
    searchStub.current = async () => [chunk(1, 'Answer engines quote sources plainly.')];

    await mod.answer.answerQuestion({ question: 'how do answer engines work', userId: user });

    const { messages } = chatRequestBody();
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const userMessage = messages.find((m) => m.role === 'user')?.content ?? '';

    expect(system).toMatch(/only the passages/i);
    expect(userMessage).toContain('Answer engines quote sources plainly.');
    expect(userMessage).toContain('how do answer engines work');
  });

  it('returns the passages so the answer can be checked', async () => {
    // An answer without its sources is an answer whose mistakes are
    // undetectable, and the mistakes are why this machinery exists.
    stubProviders();
    searchStub.current = async () => [chunk(1, 'A specific claim from the document.')];

    const result = await mod.answer.answerQuestion({ question: 'q', userId: user });

    expect(result.passages[0]?.content).toBe('A specific claim from the document.');
    expect(result.passages[0]?.rank).toBe(1);
    expect(result.passages[0]?.pageNumber).toBe(1);
  });

  it('ranks passages from 1, matching the citation markers', async () => {
    stubProviders();
    searchStub.current = async () => [chunk(1, 'first'), chunk(2, 'second'), chunk(3, 'third')];

    const result = await mod.answer.answerQuestion({ question: 'q', userId: user });

    expect(result.passages.map((p) => p.rank)).toEqual([1, 2, 3]);
  });
});

describe('when nothing matches', () => {
  it('does not call the model at all', async () => {
    /**
     * The most important behaviour in this file.
     *
     * Calling the model with no passages spends a request to produce exactly
     * the failure this application exists to prevent: a confident paragraph
     * invented from training data with no document behind it. An empty corpus,
     * which is the state of every new deployment, would otherwise answer every
     * question fluently and wrongly.
     */
    stubProviders();
    searchStub.current = async () => [];

    const result = await mod.answer.answerQuestion({ question: 'anything', userId: user });

    expect(result.groundedInNothing).toBe(true);
    expect(result.passages).toEqual([]);

    // The embedding call happened; the chat call did not.
    const chatCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('/embeddings'));
    expect(chatCalls).toHaveLength(0);
  });

  it('says it could not find anything, rather than guessing', async () => {
    stubProviders();
    searchStub.current = async () => [];

    const result = await mod.answer.answerQuestion({ question: 'anything', userId: user });

    expect(result.answer).toMatch(/could not find/i);
    expect(result.usage.completionTokens).toBe(0);
  });
});

describe('what is handed to the logger', () => {
  /** Everything the pipeline passed to any logging function, as one string. */
  function loggedText(): string {
    return JSON.stringify([
      ...logInfoMock.mock.calls,
      ...logWarnMock.mock.calls,
      ...logErrorMock.mock.calls,
    ]);
  }

  it('never passes the question, the passages or the answer', async () => {
    /**
     * Three distinct kinds of private content pass through this function, and
     * none of them belongs in a log: the user's question, the company's
     * document text, and the generated answer.
     *
     * Asserted at the call site rather than on rendered output, so this proves
     * the content is never handed over at all. Passing it and relying on the
     * redaction allowlist to drop it would also produce a clean log today, and
     * would break the moment somebody added a field name to that allowlist for
     * an unrelated reason.
     */
    const QUESTION = 'zebra-marker-question-phrase';
    const PASSAGE = 'giraffe-marker-passage-phrase';
    const ANSWER = 'okapi-marker-answer-phrase';

    stubProviders(ANSWER);
    searchStub.current = async () => [chunk(1, PASSAGE)];

    const result = await mod.answer.answerQuestion({ question: QUESTION, userId: user });
    expect(result.answer).toBe(ANSWER);

    const logged = loggedText();

    expect(logged).not.toContain(QUESTION);
    expect(logged).not.toContain(PASSAGE);
    expect(logged).not.toContain(ANSWER);
    // Proof the assertions above are not passing on an empty string.
    expect(logged).toMatch(/rag\.(retrieve|answer)/);
  });

  it('does log the shape of the work, which is what diagnosis needs', async () => {
    /**
     * The other half of the rule. Logging nothing would satisfy the test above
     * and leave nobody able to answer "why is retrieval bad for this user".
     *
     * `topScore` is the field that makes retrieval quality visible without any
     * content: five passages all scoring around 0.4 is a corpus that does not
     * cover the question, and that is diagnosable from a log line alone.
     */
    stubProviders();
    searchStub.current = async () => [chunk(1, 'text'), chunk(2, 'more text')];

    await mod.answer.answerQuestion({ question: 'q', userId: user });

    const retrieval = logInfoMock.mock.calls.find(
      ([fields]) => (fields as { operation: string }).operation === 'rag.retrieve',
    )?.[0] as Record<string, unknown>;

    expect(retrieval.resultsReturned).toBe(2);
    expect(retrieval.topScore).toBeGreaterThan(0);
    expect(retrieval.embeddingModel).toBe('voyage-4-lite');
  });

  it('never passes either API key', async () => {
    stubProviders();
    searchStub.current = async () => [chunk(1, 'text')];

    const result = await mod.answer.answerQuestion({ question: 'q', userId: user });

    const everything = loggedText() + JSON.stringify(result);
    expect(everything).not.toContain(FAKE_VOYAGE_KEY);
    expect(everything).not.toContain(FAKE_GROQ_KEY);
  });
});
