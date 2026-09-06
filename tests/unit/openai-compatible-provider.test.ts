import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider } from '@/server/ai/providers/openai-compatible';
import type { LLMProviderConfig } from '@/server/ai/types';

/**
 * The OpenAI-compatible provider, which serves Groq, OpenRouter and OpenAI.
 *
 * `fetch` is mocked, so none of this needs an API key or spends free-tier
 * quota. What is verified is the part that has to be right regardless of what
 * the model says: the request shape, the SSE parsing, and above all what a
 * user is told when each kind of failure happens.
 */

const groqConfig: LLMProviderConfig = {
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'gsk_test_key_not_real',
  temperature: 0.2,
  maxOutputTokens: 1024,
  contextWindow: 131072,
  timeoutMs: 30_000,
};

const okBody = {
  choices: [
    {
      message: { role: 'assistant', content: 'A vector database stores data as vectors.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 35, completion_tokens: 40 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('complete', () => {
  it('returns the answer and token usage', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    const result = await createOpenAICompatibleProvider(groqConfig).complete({
      messages: [{ role: 'user', content: 'What is a vector database?' }],
    });

    expect(result.text).toBe('A vector database stores data as vectors.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 35, completionTokens: 40 });
  });

  it('calls the right endpoint with the right body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await createOpenAICompatibleProvider(groqConfig).complete({
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1024);
  });

  it('sends the key as a bearer header, never in the URL', async () => {
    // A key in a query string ends up in browser history, proxy logs, server
    // access logs and referrer headers. A header does not.
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await createOpenAICompatibleProvider(groqConfig).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers.authorization).toBe('Bearer gsk_test_key_not_real');
    expect(url).not.toContain('gsk_test_key_not_real');
    expect(String(init.body)).not.toContain('gsk_test_key_not_real');
  });

  it('serves a different vendor from the same implementation', async () => {
    // The whole point: only the base URL and model change.
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    const provider = createOpenAICompatibleProvider({
      ...groqConfig,
      provider: 'openrouter',
      model: 'meta-llama/llama-3.3-70b-instruct',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(provider.id).toBe('openrouter');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });

  it('omits the auth header when no key is configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    const { apiKey: _unused, ...noKey } = groqConfig;
    await createOpenAICompatibleProvider(noKey).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('maps a truncated answer to finishReason "length"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ...okBody, choices: [{ ...okBody.choices[0], finish_reason: 'length' }] }),
    );

    const result = await createOpenAICompatibleProvider(groqConfig).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.finishReason).toBe('length');
  });
});

describe('error handling', () => {
  /**
   * Each status needs a different action from whoever reads it, which is why
   * they are not collapsed into one generic upstream error.
   */
  const cases: [number, string, RegExp][] = [
    [401, 'LLM_UNAVAILABLE', /API key is missing or invalid/i],
    [403, 'LLM_UNAVAILABLE', /API key is missing or invalid/i],
    [402, 'LLM_UNAVAILABLE', /no remaining credit/i],
    [404, 'LLM_MODEL_NOT_FOUND', /not available on groq/i],
    [429, 'LLM_UNAVAILABLE', /rate limit reached/i],
    [500, 'LLM_UNAVAILABLE', /failed to answer/i],
  ];

  for (const [status, code, messagePattern] of cases) {
    it(`maps HTTP ${status} to ${code} with an actionable message`, async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'provider detail' } }, status));

      await expect(
        createOpenAICompatibleProvider(groqConfig).complete({
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ).rejects.toMatchObject({ code, safeMessage: expect.stringMatching(messagePattern) });
    });
  }

  it('returns 429 upward on a rate limit, so callers can back off', async () => {
    // The most common free-tier outcome. It is expected behaviour, not a bug,
    // and the status it surfaces as should say so.
    fetchMock.mockResolvedValue(jsonResponse({ error: 'rate_limit_exceeded' }, 429));

    await expect(
      createOpenAICompatibleProvider(groqConfig).complete({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ httpStatus: 429 });
  });

  it("never puts the provider's own error text in the user-facing message", async () => {
    // Hosted providers put request ids, organization ids and sometimes a
    // fragment of the offending prompt into their error bodies.
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: 'org_abc123 request req_xyz789 flagged content: "my private salary figure"',
          },
        },
        400,
      ),
    );

    try {
      await createOpenAICompatibleProvider(groqConfig).complete({
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const { safeMessage, message } = error as { safeMessage: string; message: string };

      for (const leak of ['org_abc123', 'req_xyz789', 'private salary']) {
        expect(safeMessage).not.toContain(leak);
      }
      // The detail survives internally, for the logs.
      expect(message).toContain('req_xyz789');
    }
  });

  it('reports a network failure as connectivity, not as a stopped service', async () => {
    // The opposite of the local provider: nothing needs starting here, the
    // internet or DNS is the problem.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      createOpenAICompatibleProvider(groqConfig).complete({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
      safeMessage: expect.stringContaining('internet connection'),
    });
  });

  it('maps a timeout to its own code', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(
      createOpenAICompatibleProvider(groqConfig).complete({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT', httpStatus: 504 });
  });

  it('rejects a 200 with no message content', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [] }));

    await expect(
      createOpenAICompatibleProvider(groqConfig).complete({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('rejects a 200 whose body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway error</html>', { status: 200 }));

    await expect(
      createOpenAICompatibleProvider(groqConfig).complete({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });
});

describe('stream', () => {
  function sseResponse(lines: string[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }

  it('parses Server-Sent Events into tokens', async () => {
    // A different wire format from Ollama's newline-delimited JSON: `data:`
    // prefixes and a literal [DONE] terminator rather than a flag.
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"A "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"vector"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = [];
    for await (const chunk of createOpenAICompatibleProvider(groqConfig).stream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('A vector');
    expect(chunks.at(-1)?.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
    expect(chunks.at(-1)?.finishReason).toBe('stop');
  });

  it('reassembles an event split across two network chunks', async () => {
    // The transport can split anywhere, including mid-JSON. Parsing each
    // network chunk independently would throw on perfectly valid output.
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"con',
        'tent":"split"}}]}\n\ndata: [DONE]\n\n',
      ]),
    );

    const chunks = [];
    for await (const chunk of createOpenAICompatibleProvider(groqConfig).stream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('split');
  });

  it('ignores [DONE] and malformed events rather than failing', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"good"}}]}\n\n',
        'data: not json\n\n',
        ': a comment line\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const chunks = [];
    for await (const chunk of createOpenAICompatibleProvider(groqConfig).stream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('good');
  });

  it('surfaces an auth failure before streaming starts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid key' }, 401));

    const iterate = async () => {
      for await (const _ of createOpenAICompatibleProvider(groqConfig).stream({
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // consume
      }
    };

    await expect(iterate()).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });
});
