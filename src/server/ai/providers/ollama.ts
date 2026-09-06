import { LLMError } from '@/server/observability/errors';
import type {
  Completion,
  CompletionRequest,
  FinishReason,
  LLMProvider,
  LLMProviderConfig,
  StreamChunk,
} from '../types';

/**
 * The Ollama provider.
 *
 * ---------------------------------------------------------------
 * CONCEPT: Ollama is not a model. It is the thing that runs models.
 * ---------------------------------------------------------------
 * Ollama is a small server that runs on your machine, downloads model files,
 * loads them into memory, and exposes an HTTP API on port 11434. The model
 * (`llama3.2:1b` here) is a separate multi-gigabyte file of learned weights.
 *
 * So this file is not "talking to an AI". It is making an ordinary HTTP POST
 * to a local server, exactly as it would to any other API. That is the whole
 * trick, and it is why swapping in Groq later is a different URL and a header
 * rather than a different architecture.
 *
 * Nothing outside this file knows Ollama exists. The application asks the
 * registry for "the configured LLM provider" and gets back something matching
 * the `LLMProvider` interface.
 */

const CHAT_PATH = '/api/chat';
const TAGS_PATH = '/api/tags';

/** The subset of Ollama's response we rely on. */
interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  /** Tokens in the prompt. Ollama's name for it, kept at the boundary only. */
  prompt_eval_count?: number;
  /** Tokens generated. */
  eval_count?: number;
}

function mapFinishReason(reason: string | undefined): FinishReason {
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
 * Turns any failure into a typed error with a message safe to show a user.
 *
 * Every branch decides two things separately: what the user is told, and what
 * the logs record. The provider's own error text never becomes the user's
 * message. Ollama's happens to be harmless, but this mapping has to be safe
 * for the hosted providers we will add, whose errors can carry request ids,
 * account identifiers or fragments of the prompt.
 */
function toLLMError(error: unknown, model: string, timeoutMs: number): LLMError {
  // A timeout fires as an AbortError from AbortSignal.timeout().
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new LLMError(
      'LLM_TIMEOUT',
      504,
      'The model took too long to respond. Try a shorter question.',
      `Ollama request exceeded ${timeoutMs}ms`,
      { provider: 'ollama', model, durationMs: timeoutMs },
      error,
    );
  }

  if (error instanceof LLMError) return error;

  /**
   * `fetch` rejects with a TypeError when the connection itself fails, which
   * for a local service almost always means the process is not running.
   * The underlying cause carries ECONNREFUSED, and that is a fine thing to log
   * but a useless thing to show someone.
   */
  if (error instanceof TypeError) {
    return new LLMError(
      'LLM_UNAVAILABLE',
      503,
      'The local model service is not reachable. Make sure Ollama is running.',
      `Could not connect to Ollama: ${error.message}`,
      { provider: 'ollama', model },
      error,
    );
  }

  return new LLMError(
    'LLM_UNAVAILABLE',
    502,
    'The model service failed to answer.',
    error instanceof Error ? error.message : 'Unknown provider error',
    { provider: 'ollama', model },
    error,
  );
}

/** Maps a non-2xx response, reading the body only to classify it. */
async function toHttpError(response: Response, model: string): Promise<LLMError> {
  let providerMessage = '';
  try {
    const text = await response.text();
    providerMessage = text.slice(0, 500);
  } catch {
    providerMessage = '(body unreadable)';
  }

  // Ollama answers 404 with {"error":"model 'x' not found"} when the model has
  // not been pulled. It is by far the most common first-run failure, and
  // "an upstream service is unavailable" would send someone hunting in
  // completely the wrong place.
  if (response.status === 404) {
    return new LLMError(
      'LLM_MODEL_NOT_FOUND',
      503,
      `The model "${model}" is not installed. Pull it with: ollama pull ${model}`,
      `Ollama returned 404 for model ${model}: ${providerMessage}`,
      { provider: 'ollama', model, statusCode: 404 },
    );
  }

  return new LLMError(
    'LLM_UNAVAILABLE',
    502,
    'The model service failed to answer.',
    `Ollama returned ${response.status}: ${providerMessage}`,
    { provider: 'ollama', model, statusCode: response.status },
  );
}

/**
 * Combines the caller's cancellation with our own timeout.
 *
 * Two different things can end a request: the user navigating away, and the
 * model taking too long. Both need to abort the same fetch, and they mean
 * different things afterwards, so they are distinguishable at the catch site.
 */
function buildSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
}

export function createOllamaProvider(config: LLMProviderConfig): LLMProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${CHAT_PATH}`;
  /**
   * From configuration, not a constant. A local model on a CPU is slow, and
   * the FIRST request after idle also pays to load several gigabytes of
   * weights into memory: in testing that load took nine seconds on its own
   * while generation took three. A short timeout would fail exactly the
   * request that was always going to be slowest.
   */
  const timeoutMs = config.timeoutMs;

  function requestBody(request: CompletionRequest, stream: boolean) {
    return {
      model: config.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      options: {
        temperature: request.temperature ?? config.temperature,
        // Ollama's name for the output-token ceiling.
        num_predict: request.maxOutputTokens ?? config.maxOutputTokens,
        // Ollama defaults its context window to 2048 regardless of what the
        // model supports, silently truncating anything longer. Setting it
        // explicitly is what makes the configured context window real.
        num_ctx: config.contextWindow,
      },
    };
  }

  return {
    id: 'ollama',
    model: config.model,
    contextWindow: config.contextWindow,

    /**
     * Approximate token count.
     *
     * Roughly four characters per token, which holds well enough for English
     * prose to budget a prompt. It is NOT exact: every model family tokenizes
     * differently, and the same text is a different number of tokens to Llama
     * than to GPT. A real tokenizer arrives when context budgeting needs to be
     * precise; until then this is honest about being an estimate.
     */
    countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },

    async complete(request: CompletionRequest): Promise<Completion> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody(request, false)),
          signal: buildSignal(timeoutMs, request.signal),
        });
      } catch (error) {
        throw toLLMError(error, config.model, timeoutMs);
      }

      if (!response.ok) throw await toHttpError(response, config.model);

      let payload: OllamaChatResponse;
      try {
        payload = (await response.json()) as OllamaChatResponse;
      } catch (error) {
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The model returned an unreadable response.',
          'Ollama response was not valid JSON',
          { provider: 'ollama', model: config.model },
          error,
        );
      }

      const text = payload.message?.content;
      if (typeof text !== 'string') {
        // A 200 with the wrong shape is worse than an error status, because
        // without this check it becomes `undefined` several layers away.
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The model returned an unreadable response.',
          'Ollama response had no message content',
          { provider: 'ollama', model: config.model },
        );
      }

      return {
        text,
        finishReason: mapFinishReason(payload.done_reason),
        usage: {
          promptTokens: payload.prompt_eval_count ?? 0,
          completionTokens: payload.eval_count ?? 0,
        },
      };
    },

    /**
     * Token-by-token generation.
     *
     * Ollama streams newline-delimited JSON: one object per token, with the
     * final one carrying `done: true` and the usage counts. Implemented here
     * because the interface requires it and the shape is worth having settled;
     * the UI does not use it yet, and wiring it through to the browser is its
     * own phase.
     */
    async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody(request, true)),
          signal: buildSignal(timeoutMs, request.signal),
        });
      } catch (error) {
        throw toLLMError(error, config.model, timeoutMs);
      }

      if (!response.ok) throw await toHttpError(response, config.model);
      if (!response.body) {
        throw new LLMError(
          'LLM_INVALID_RESPONSE',
          502,
          'The model returned an unreadable response.',
          'Ollama streaming response had no body',
          { provider: 'ollama', model: config.model },
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // A chunk can split a JSON object in half, so the trailing partial
          // line is kept in the buffer until its newline arrives.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;

            let parsed: OllamaChatResponse;
            try {
              parsed = JSON.parse(line) as OllamaChatResponse;
            } catch {
              // One malformed line should not kill a stream that is otherwise
              // producing a good answer.
              continue;
            }

            const delta = parsed.message?.content ?? '';
            if (parsed.done) {
              yield {
                delta,
                finishReason: mapFinishReason(parsed.done_reason),
                usage: {
                  promptTokens: parsed.prompt_eval_count ?? 0,
                  completionTokens: parsed.eval_count ?? 0,
                },
              };
            } else if (delta) {
              yield { delta };
            }
          }
        }
      } finally {
        // Releases the connection even if the consumer stops iterating early.
        reader.releaseLock();
      }
    },
  };
}

export interface OllamaStatus {
  reachable: boolean;
  models: string[];
}

/**
 * Asks Ollama what it has installed.
 *
 * Used by the health report so the app can say "Ollama is running but the
 * configured model is not pulled", which is a different problem from "Ollama
 * is not running" and has a different fix.
 */
export async function getOllamaStatus(
  baseUrl: string,
  timeoutMs = 3000,
): Promise<OllamaStatus> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${TAGS_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, models: [] };

    const payload = (await response.json()) as { models?: { name?: string }[] };
    const models = (payload.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === 'string');

    return { reachable: true, models };
  } catch {
    // A health probe never throws: an unreachable service is an answer, not an
    // error, and the caller has to render something either way.
    return { reachable: false, models: [] };
  }
}
