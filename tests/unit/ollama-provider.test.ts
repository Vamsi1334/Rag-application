import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOllamaProvider, getOllamaStatus } from '@/server/ai/providers/ollama';
import type { LLMProviderConfig } from '@/server/ai/types';

/**
 * Ollama provider.
 *
 * `fetch` is mocked throughout, so these run in milliseconds and never need a
 * model installed. A real end-to-end check against a running Ollama is a
 * separate exercise; what is verified here is the part that has to be right
 * every time regardless of what the model says: how each failure is
 * classified, and what a user is told about it.
 */

const config: LLMProviderConfig = {
  provider: 'ollama',
  model: 'llama3.2:1b',
  baseUrl: 'http://127.0.0.1:11434',
  temperature: 0.2,
  maxOutputTokens: 1024,
  contextWindow: 8192,
  timeoutMs: 5_000,
};

/** A real response body, copied from a live Ollama call. */
const okBody = {
  model: 'llama3.2:1b',
  message: { role: 'assistant', content: 'A vector database stores data as vectors.' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 35,
  eval_count: 40,
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

    const result = await createOllamaProvider(config).complete({
      messages: [{ role: 'user', content: 'What is a vector database?' }],
    });

    expect(result.text).toBe('A vector database stores data as vectors.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 35, completionTokens: 40 });
  });

  it('sends the configured model, temperature and output ceiling', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await createOllamaProvider(config).complete({
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(body.model).toBe('llama3.2:1b');
    expect(body.stream).toBe(false);
    expect(body.options).toMatchObject({ temperature: 0.2, num_predict: 1024 });
  });

  it('sets num_ctx explicitly', async () => {
    // Ollama defaults its context window to 2048 whatever the model supports,
    // silently truncating longer prompts. Without this the configured context
    // window would be a lie, and the truncation is invisible: you get a
    // plausible answer that ignored half the input.
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await createOllamaProvider(config).complete({
      messages: [{ role: 'user', content: 'hello' }],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.options.num_ctx).toBe(8192);
  });

  it('lets a per-request temperature override the configured one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await createOllamaProvider(config).complete({
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.9,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.options.temperature).toBe(0.9);
  });

  it('normalizes a trailing slash on the base URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await createOllamaProvider({ ...config, baseUrl: 'http://127.0.0.1:11434/' }).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://127.0.0.1:11434/api/chat');
  });

  it('maps a truncated answer to finishReason "length"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...okBody, done_reason: 'length' }));

    const result = await createOllamaProvider(config).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.finishReason).toBe('length');
  });
});

describe('error handling', () => {
  it('reports a clear message when Ollama is not running', async () => {
    // fetch rejects with TypeError when the connection itself fails.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      createOllamaProvider(config).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
      httpStatus: 503,
      safeMessage: expect.stringContaining('Ollama is running'),
    });
  });

  it('tells the user how to install a missing model', async () => {
    // The most common first-run failure, and the one where a generic
    // "upstream unavailable" sends someone looking in the wrong place.
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "model 'llama3.2:1b' not found" }, 404),
    );

    await expect(
      createOllamaProvider(config).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      code: 'LLM_MODEL_NOT_FOUND',
      safeMessage: expect.stringContaining('ollama pull llama3.2:1b'),
    });
  });

  it('maps a timeout to its own code', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    fetchMock.mockRejectedValue(timeout);

    await expect(
      createOllamaProvider(config).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT', httpStatus: 504 });
  });

  it('rejects a 200 whose body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>proxy error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(
      createOllamaProvider(config).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('rejects a 200 with no message content', async () => {
    // Without this check the answer becomes `undefined` several layers away,
    // which is far harder to trace than a failure at the boundary.
    fetchMock.mockResolvedValue(jsonResponse({ done: true }));

    await expect(
      createOllamaProvider(config).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('handles a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'internal' }, 500));

    await expect(
      createOllamaProvider(config).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE', httpStatus: 502 });
  });

  it("never puts the provider's own error text in the user-facing message", async () => {
    // Ollama's messages are harmless, but this mapping has to be safe for the
    // hosted providers coming later, whose errors can carry request ids,
    // account identifiers or fragments of the prompt.
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: 'internal server error: /home/mac/.ollama/models trace=req_abc123 key=sk-secret' },
        500,
      ),
    );

    try {
      await createOllamaProvider(config).complete({
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const { safeMessage, message } = error as { safeMessage: string; message: string };

      for (const leak of ['/home/mac', 'req_abc123', 'sk-secret']) {
        expect(safeMessage).not.toContain(leak);
      }
      // The detail survives on the internal message, for the logs.
      expect(message).toContain('req_abc123');
    }
  });
});

describe('stream', () => {
  function ndjsonResponse(lines: string[]): Response {
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

  it('yields each token then a final chunk with usage', async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        '{"message":{"content":"A "},"done":false}\n',
        '{"message":{"content":"vector"},"done":false}\n',
        '{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":2}\n',
      ]),
    );

    const chunks = [];
    for await (const chunk of createOllamaProvider(config).stream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('A vector');
    expect(chunks.at(-1)?.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
    expect(chunks.at(-1)?.finishReason).toBe('stop');
  });

  it('reassembles a JSON object split across two network chunks', async () => {
    // The transport can split anywhere, including mid-object. Parsing each
    // network chunk independently would throw on perfectly valid output.
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        '{"message":{"con',
        'tent":"split"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"stop"}\n',
      ]),
    );

    const chunks = [];
    for await (const chunk of createOllamaProvider(config).stream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('split');
  });

  it('skips a malformed line rather than killing the stream', async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        '{"message":{"content":"good"},"done":false}\n',
        'not json at all\n',
        '{"message":{"content":""},"done":true,"done_reason":"stop"}\n',
      ]),
    );

    const chunks = [];
    for await (const chunk of createOllamaProvider(config).stream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('good');
  });
});

describe('countTokens', () => {
  it('estimates from character length', () => {
    const provider = createOllamaProvider(config);
    expect(provider.countTokens('abcd')).toBe(1);
    expect(provider.countTokens('a'.repeat(400))).toBe(100);
  });
});

describe('getOllamaStatus', () => {
  it('lists installed models when reachable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ models: [{ name: 'llama3.2:1b' }, { name: 'nomic-embed-text:latest' }] }),
    );

    await expect(getOllamaStatus('http://127.0.0.1:11434')).resolves.toEqual({
      reachable: true,
      models: ['llama3.2:1b', 'nomic-embed-text:latest'],
    });
  });

  it('answers rather than throwing when the service is down', async () => {
    // A health probe that throws forces every caller into a try/catch and can
    // take down the page that exists to report the problem.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(getOllamaStatus('http://127.0.0.1:11434')).resolves.toEqual({
      reachable: false,
      models: [],
    });
  });
});
