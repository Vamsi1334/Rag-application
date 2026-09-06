import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigurationError,
  LLMError,
  UnauthorizedError,
} from '@/server/observability/errors';
import type { ApiErrorResponse, ChatResponse } from '@/lib/schemas/chat';
import type { Completion, CompletionRequest, LLMProvider } from '@/server/ai/types';
import type { LogFields } from '@/server/observability/logger';

/**
 * POST /api/ai/chat.
 *
 * The endpoint spends money on someone else's behalf, so the questions these
 * tests ask are, in order of importance:
 *
 *   1. Can an anonymous caller reach the model? (No.)
 *   2. Is the session checked BEFORE any work is done? (Yes.)
 *   3. Does anything the user typed, or any credential, reach the logs or an
 *      error body? (No.)
 *
 * The provider is faked. Whether Groq itself works is not this file's
 * business; that is proved by a real request against a running server.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const requireUserMock = vi.fn();
vi.mock('@/server/auth/require-user', () => ({
  requireUser: requireUserMock,
  getOptionalUser: vi.fn(),
}));

const getLLMProviderMock = vi.fn();
vi.mock('@/server/ai/factory', () => ({
  getLLMProvider: getLLMProviderMock,
  getLLMConfig: vi.fn(),
  getEmbeddingProvider: vi.fn(),
  getEmbeddingConfig: vi.fn(),
  resolveModel: vi.fn(),
}));

// Mocked so the fields the route hands the logger can be inspected directly,
// which is the only way to prove a value never reaches a log line rather than
// merely being redacted once it gets there.
const logInfoMock = vi.fn();
const logErrorMock = vi.fn();
vi.mock('@/server/observability/logger', () => ({
  logInfo: logInfoMock,
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: logErrorMock,
  getLogger: vi.fn(),
  isExpectedFailure: vi.fn(),
}));

const { POST } = await import('@/app/api/ai/chat/route');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = '6537f1a2b3c4d5e6f7890123';

function signedIn(): void {
  requireUserMock.mockResolvedValue({
    userId: { toHexString: () => USER_ID },
    userIdString: USER_ID,
    email: 'mac@example.com',
    name: 'Mac',
    image: null,
  });
}

function signedOut(): void {
  requireUserMock.mockRejectedValue(
    new UnauthorizedError('No authenticated session', { operation: 'auth.requireUser' }),
  );
}

function fakeProvider(completion?: Partial<Completion>): LLMProvider {
  return {
    id: 'groq',
    model: 'openai/gpt-oss-120b',
    contextWindow: 8192,
    complete: vi.fn(
      async (_request: CompletionRequest): Promise<Completion> => ({
        text: 'A vector database stores embeddings.',
        finishReason: 'stop',
        usage: { promptTokens: 11, completionTokens: 7 },
        ...completion,
      }),
    ),
    stream: async function* () {
      return;
    },
    countTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

function post(body: unknown, init?: RequestInit): Request {
  return new Request('http://localhost:3000/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

beforeEach(() => {
  getLLMProviderMock.mockReturnValue(fakeProvider());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('answers 401 when there is no session', async () => {
    signedOut();

    const response = await POST(post({ message: 'What is a vector database?' }));
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBe('You need to sign in to do that.');
  });

  it('never reaches the model without a session', async () => {
    signedOut();

    await POST(post({ message: 'What is a vector database?' }));

    // The important assertion. A 401 that still called the provider would have
    // spent a request from the rate limit on an anonymous caller.
    expect(getLLMProviderMock).not.toHaveBeenCalled();
  });

  it('checks the session before it reads the body', async () => {
    signedOut();

    // Unparseable JSON. If the body were read first this would be a 400, and
    // an anonymous caller would have learned something about the endpoint and
    // made the server do work.
    const response = await POST(post('{ not json'));

    expect(response.status).toBe(401);
  });

  it('answers a signed-in caller', async () => {
    signedIn();

    const response = await POST(post({ message: 'What is a vector database?' }));
    const body = (await response.json()) as ChatResponse;

    expect(response.status).toBe(200);
    expect(body.answer).toBe('A vector database stores embeddings.');
    expect(body.provider).toBe('groq');
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
    expect(body.finishReason).toBe('stop');
    expect(body.requestId).toMatch(/^[a-f0-9]{16}$/);
  });

  it('sends exactly what the user asked, and nothing added', async () => {
    signedIn();
    const provider = fakeProvider();
    getLLMProviderMock.mockReturnValue(provider);

    await POST(post({ message: '  What is a vector database?  ' }));

    expect(provider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        // Trimmed by the schema before it ever reaches the model.
        messages: [{ role: 'user', content: 'What is a vector database?' }],
      }),
    );
  });

  it('never caches an answer, which belongs to one user', async () => {
    signedIn();

    const response = await POST(post({ message: 'hello' }));

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('validation', () => {
  beforeEach(signedIn);

  it('rejects a body that is not JSON', async () => {
    const response = await POST(post('{ not json'));
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a missing message', async () => {
    const response = await POST(post({}));
    expect(response.status).toBe(400);
  });

  it('rejects a message of only whitespace', async () => {
    const response = await POST(post({ message: '     ' }));
    expect(response.status).toBe(400);
  });

  it('rejects a message past the length ceiling', async () => {
    const response = await POST(post({ message: 'a'.repeat(4001) }));

    expect(response.status).toBe(400);
    expect(getLLMProviderMock).not.toHaveBeenCalled();
  });

  it('rejects a message that is not a string', async () => {
    const response = await POST(post({ message: { $ne: null } }));
    expect(response.status).toBe(400);
  });
});

describe('provider failures', () => {
  beforeEach(signedIn);

  it('turns a missing GROQ_API_KEY into a 500 that names nothing', async () => {
    // What the real factory throws when LLM_PROVIDER=groq and no key is set.
    getLLMProviderMock.mockImplementation(() => {
      throw new ConfigurationError('GROQ_API_KEY is required for the "groq" provider.', {
        variable: 'GROQ_API_KEY',
        provider: 'groq',
      });
    });

    const response = await POST(post({ message: 'hello' }));
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expect(body.error.code).toBe('CONFIGURATION_ERROR');
    // The operator needs to know which variable is missing. The caller does
    // not, and telling them maps the deployment's configuration for free.
    expect(JSON.stringify(body)).not.toContain('GROQ_API_KEY');
    expect(body.error.message).toBe('The server is not configured correctly.');

    // The detail is not lost, it is only redirected: it goes to the logs,
    // where the person who can fix it will look.
    expect(logErrorMock).toHaveBeenCalledOnce();
  });

  it('passes a provider rate limit through as 429', async () => {
    // Groq's free tier is rate limited per minute and per day, so this is the
    // failure a learner is most likely to hit. It must not arrive as a 500.
    getLLMProviderMock.mockReturnValue({
      ...fakeProvider(),
      complete: vi.fn().mockRejectedValue(
        new LLMError(
          'LLM_UNAVAILABLE',
          429,
          'Rate limit reached on the free tier. Wait a moment and try again.',
          'groq rate limited the request',
          { provider: 'groq' },
        ),
      ),
    });

    const response = await POST(post({ message: 'hello' }));
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(429);
    expect(body.error.message).toBe(
      'Rate limit reached on the free tier. Wait a moment and try again.',
    );
  });

  it('never leaks the provider own error text to the caller', async () => {
    getLLMProviderMock.mockReturnValue({
      ...fakeProvider(),
      complete: vi
        .fn()
        .mockRejectedValue(new Error('401 Invalid API Key: gsk_liveKeyValueHere')),
    });

    const response = await POST(post({ message: 'hello' }));
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('gsk_');
    expect(body.error.message).toBe('Something went wrong on our end.');
  });
});

describe('logging', () => {
  it('records who made the call, and what it cost', async () => {
    signedIn();

    await POST(post({ message: 'What is a vector database?' }));

    const completionLog = logInfoMock.mock.calls.find(
      (call) => (call[0] as LogFields).operation === 'ai.chat',
    );

    expect(completionLog).toBeDefined();
    expect(completionLog?.[0]).toMatchObject({
      operation: 'ai.chat',
      userId: USER_ID,
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      promptTokens: 11,
      completionTokens: 7,
      finishReason: 'stop',
    });
  });

  it('logs an id, never an email address', async () => {
    signedIn();

    await POST(post({ message: 'hello' }));

    const logged = JSON.stringify(logInfoMock.mock.calls);
    expect(logged).toContain(USER_ID);
    expect(logged).not.toContain('mac@example.com');
  });

  it('never hands the question or the answer to the logger', async () => {
    signedIn();

    await POST(post({ message: 'my salary is 90000, is that good' }));

    // Redaction would drop these anyway. This asserts the stronger property:
    // the route does not pass them in the first place, so the guarantee does
    // not depend on the allowlist staying correct.
    const logged = JSON.stringify([...logInfoMock.mock.calls, ...logErrorMock.mock.calls]);
    expect(logged).not.toContain('salary');
    expect(logged).not.toContain('A vector database stores embeddings.');
  });

  it('logs nothing about the caller when there is no session', async () => {
    signedOut();

    await POST(post({ message: 'hello' }));

    const logged = JSON.stringify([...logInfoMock.mock.calls, ...logErrorMock.mock.calls]);
    expect(logged).not.toContain(USER_ID);
  });
});
