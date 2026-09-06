import { LLMError } from '@/server/observability/errors';
import type { ProviderId } from '@/server/config/providers';
import type {
  Completion,
  CompletionRequest,
  FinishReason,
  LLMProvider,
  LLMProviderConfig,
  StreamChunk,
} from '../types';

/**
 * One provider, three vendors.
 *
 * ------------------------------------------------------------------
 * Why this is not three separate files
 * ------------------------------------------------------------------
 * Groq, OpenRouter and OpenAI all speak the same HTTP API. OpenAI defined
 * `POST /chat/completions` with a particular request and response shape, and
 * it became the de facto standard, so the others implemented it deliberately.
 *
 * The differences between them are entirely configuration:
 *
 *   vendor      base URL                            model name
 *   Groq        https://api.groq.com/openai/v1      openai/gpt-oss-120b
 *   OpenRouter  https://openrouter.ai/api/v1        meta-llama/llama-3.3-70b-instruct
 *   OpenAI      https://api.openai.com/v1           gpt-4o-mini
 *
 * Same path, same body, same auth header, same response. So there is one
 * implementation, and adding a fourth vendor that speaks this dialect is a
 * catalog entry rather than any code at all.
 *
 * Ollama gets its own file because it is genuinely different: no auth, a
 * different response shape, and options like `num_ctx` that have no
 * equivalent here.
 */

const CHAT_PATH = '/chat/completions';

/** The subset of the response we rely on. */
interface ChatCompletionResponse {
  choices?: {
    message?: { role?: string; content?: string | null };
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    default:
      return 'stop';
  }
}

/**
 * Turns any failure into a typed error with a safe message.
 *
 * The status codes are where hosted providers differ most from a local one,
 * and each needs a different action from whoever sees it:
 *
 *   401  the key is wrong or missing        fix configuration
 *   402  out of credit                      top up or switch provider
 *   404  that model name does not exist     fix the model name
 *   429  rate limited                       wait, or switch model
 *   5xx  their problem                      retry later
 *
 * Collapsing these into "an upstream service is unavailable" would send
 * someone hunting in entirely the wrong place, which is why the mapping is
 * explicit.
 *
 * What never crosses over is the provider's own error text. Theirs can carry
 * request ids, organization ids and, on some providers, a fragment of the
 * prompt that tripped a filter. All of it is logged; none of it is shown.
 */
async function toHttpError(
  response: Response,
  provider: ProviderId,
  model: string,
): Promise<LLMError> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    detail = '(body unreadable)';
  }

  const meta = { provider, model, statusCode: response.status };

  switch (response.status) {
    case 401:
    case 403:
      return new LLMError(
        'LLM_UNAVAILABLE',
        503,
        `The ${provider} API key is missing or invalid. Check your configuration.`,
        `${provider} rejected the credentials (${response.status}): ${detail}`,
        meta,
      );

    case 402:
      return new LLMError(
        'LLM_UNAVAILABLE',
        503,
        `The ${provider} account has no remaining credit.`,
        `${provider} reported payment required: ${detail}`,
        meta,
      );

    case 404:
      return new LLMError(
        'LLM_MODEL_NOT_FOUND',
        503,
        `The model "${model}" is not available on ${provider}. Check the model name.`,
        `${provider} returned 404 for model ${model}: ${detail}`,
        meta,
      );

    case 429:
      // The most common failure on a free tier, and entirely expected. It is
      // not a bug, and the message says so rather than implying something
      // broke.
      return new LLMError(
        'LLM_UNAVAILABLE',
        429,
        'Rate limit reached on the free tier. Wait a moment and try again.',
        `${provider} rate limited the request: ${detail}`,
        meta,
      );

    default:
      return new LLMError(
        'LLM_UNAVAILABLE',
        502,
        'The model service failed to answer.',
        `${provider} returned ${response.status}: ${detail}`,
        meta,
      );
  }
}

function toLLMError(
  error: unknown,
  provider: ProviderId,
  model: string,
  timeoutMs: number,
): LLMError {
  if (error instanceof LLMError) return error;

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new LLMError(
      'LLM_TIMEOUT',
      504,
      'The model took too long to respond. Try a shorter question.',
      `${provider} request exceeded ${timeoutMs}ms`,
      { provider, model, durationMs: timeoutMs },
      error,
    );
  }

  // Unlike a local provider, a TypeError here means the internet is down or
  // DNS failed, not that a service needs starting.
  if (error instanceof TypeError) {
    return new LLMError(
      'LLM_UNAVAILABLE',
      503,
      'Could not reach the model service. Check your internet connection.',
      `Network failure calling ${provider}: ${error.message}`,
      { provider, model },
      error,
    );
  }

  return new LLMError(
    'LLM_UNAVAILABLE',
    502,
    'The model service failed to answer.',
    error instanceof Error ? error.message : 'Unknown provider error',
    { provider, model },
    error,
  );
}

function buildSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
}

export function createOpenAICompatibleProvider(config: LLMProviderConfig): LLMProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${CHAT_PATH}`;
  const { provider, model, timeoutMs } = config;

  /**
   * The API key goes in a header, never a query string.
   *
   * Query strings end up in browser history, proxy logs, server access logs
   * and referrer headers. Headers do not. This is also why the key only ever
   * exists in server-side code: this file is under `src/server/`, so importing
   * it from a client component fails the build.
   */
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };

  function requestBody(request: CompletionRequest, stream: boolean) {
    return {
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      temperature: request.temperature ?? config.temperature,
      max_tokens: request.maxOutputTokens ?? config.maxOutputTokens,
    };
  }

  return {
    id: provider,
    model,
    contextWindow: config.contextWindow,

    /**
     * Approximate token count, roughly four characters per token.
     *
     * Deliberately the same rough estimate the Ollama provider uses. Being
     * consistently approximate is better than being differently wrong per
     * provider, and the real tokenizer arrives when context budgeting needs
     * precision. Every model family tokenizes differently anyway.
     */
    countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },

    async complete(request: CompletionRequest): Promise<Completion> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody(request, false)),
          signal: buildSignal(timeoutMs, request.signal),
        });
      } catch (error) {
        throw toLLMError(error, provider, model, timeoutMs);
      }

      if (!response.ok) throw await toHttpError(response, provider, model);

      let payload: ChatCompletionResponse;
      try {
        payload = (await response.json()) as ChatCompletionResponse;
      } catch (error) {
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The model returned an unreadable response.',
          `${provider} response was not valid JSON`,
          { provider, model },
          error,
        );
      }

      const choice = payload.choices?.[0];
      const text = choice?.message?.content;

      if (typeof text !== 'string') {
        // A 200 with the wrong shape is worse than an error status: without
        // this check it becomes `undefined` several layers away, where the
        // cause is far harder to find.
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The model returned an unreadable response.',
          `${provider} response had no message content`,
          { provider, model },
        );
      }

      return {
        text,
        finishReason: mapFinishReason(choice?.finish_reason),
        usage: {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
        },
      };
    },

    /**
     * Token-by-token generation over Server-Sent Events.
     *
     * A different wire format from Ollama's newline-delimited JSON: each event
     * is a `data: {...}` line, blank lines separate events, and the stream ends
     * with the literal `data: [DONE]` rather than a flag on the final object.
     * Hiding that difference behind one interface is the entire point of the
     * provider layer.
     */
    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody(request, true)),
          signal: buildSignal(timeoutMs, request.signal),
        });
      } catch (error) {
        throw toLLMError(error, provider, model, timeoutMs);
      }

      if (!response.ok) throw await toHttpError(response, provider, model);
      if (!response.body) {
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The model returned an unreadable response.',
          `${provider} streaming response had no body`,
          { provider, model },
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finishReason: FinishReason = 'stop';
      let usage = { promptTokens: 0, completionTokens: 0 };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // A network chunk can split an event in half, so the trailing
          // partial line stays in the buffer until its newline arrives.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const raw of lines) {
            const line = raw.trim();
            if (!line || !line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;

            let parsed: ChatCompletionResponse;
            try {
              parsed = JSON.parse(data) as ChatCompletionResponse;
            } catch {
              // One malformed event should not kill a stream that is
              // otherwise producing a good answer.
              continue;
            }

            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
              };
            }

            const delta = choice?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) yield { delta };
          }
        }
      } finally {
        // Releases the connection even if the consumer stops iterating early.
        reader.releaseLock();
      }

      // Usage arrives on a final event that carries no text, so the totals are
      // emitted once at the end rather than being attached to a token.
      yield { delta: '', finishReason, usage };
    },
  };
}
