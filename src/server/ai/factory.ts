import 'server-only';

import { getServerEnv } from '@/server/config/env';
import type { ServerEnv } from '@/server/config/env.schema';
import { getProviderDescriptor, type ProviderId } from '@/server/config/providers';
import { ConfigurationError } from '@/server/observability/errors';
import { registerProviders } from './providers';
import { createEmbeddingProvider, createLLMProvider } from './registry';
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  LLMProvider,
  LLMProviderConfig,
} from './types';

/**
 * Turns environment variables into a provider instance.
 *
 * This is the only file that knows both what the configuration says and what
 * the registry offers. Everything else asks for `getLLMProvider()` and does
 * not care what came back.
 *
 * Ollama is implemented. Every other provider in the catalog still throws a
 * clear NotImplementedError, which is the correct behaviour: the wiring is
 * provably in place, and adding a vendor is one file plus one registration.
 */

/**
 * Where each provider's own model variable lives.
 *
 * Model names are not portable, so `LLM_PROVIDER=groq` with a leftover
 * `llama3.2:1b` would produce a confusing 404 from Groq. Giving each provider
 * its own variable means switching providers is genuinely one line.
 */
const PROVIDER_MODEL_ENV = {
  ollama: 'OLLAMA_MODEL',
  groq: 'GROQ_MODEL',
  openrouter: 'OPENROUTER_MODEL',
  openai: 'OPENAI_MODEL',
  google: 'GOOGLE_AI_MODEL',
} as const satisfies Partial<Record<ProviderId, keyof ServerEnv>>;

/**
 * Where each provider's credential lives.
 *
 * Per provider rather than one shared key, so several can be configured at
 * once and switching LLM_PROVIDER stays a genuine one-line change. Sending
 * Groq's key to OpenAI would just be a 401, but it is the kind of 401 that
 * costs an hour.
 */
const PROVIDER_KEY_ENV = {
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_AI_API_KEY',
  voyage: 'VOYAGE_API_KEY',
} as const satisfies Partial<Record<ProviderId, keyof ServerEnv>>;

/**
 * Where each provider's EMBEDDING model variable lives.
 *
 * Separate from PROVIDER_MODEL_ENV above because a provider can offer both
 * kinds of model with different names. Ollama is the live example: it runs
 * `llama3.2:1b` for chat and `nomic-embed-text` for embeddings, and one
 * variable could not hold both.
 */
const EMBEDDING_MODEL_ENV = {
  voyage: 'VOYAGE_EMBEDDING_MODEL',
} as const satisfies Partial<Record<ProviderId, keyof ServerEnv>>;

/** EMBEDDING_MODEL wins, then the provider's own variable, then the catalog. */
export function resolveEmbeddingModel(env: ServerEnv, provider: ProviderId): string {
  if (env.EMBEDDING_MODEL) return env.EMBEDDING_MODEL;

  const key = (EMBEDDING_MODEL_ENV as Partial<Record<ProviderId, keyof ServerEnv>>)[provider];
  const providerSpecific = key ? env[key] : undefined;
  if (typeof providerSpecific === 'string' && providerSpecific.length > 0) {
    return providerSpecific;
  }

  // Ollama's catalog default is its CHAT model, which would be wrong here.
  // Its embedding model has no catalog entry, so it falls back to the one
  // name that is correct for it.
  if (provider === 'ollama') return 'nomic-embed-text';

  return getProviderDescriptor(provider).defaultModel;
}

/**
 * The provider's own credential, ignoring any generic override.
 *
 * Kept separate because the two overrides are not interchangeable: LLM_API_KEY
 * must not be handed to the embedding provider. With Groq generating and
 * Voyage embedding, they are different vendors with different keys, and
 * sending one to the other would be a 401 that looks like a bad key rather
 * than a wiring mistake.
 */
function resolveProviderKey(env: ServerEnv, provider: ProviderId): string | undefined {
  const key = (PROVIDER_KEY_ENV as Partial<Record<ProviderId, keyof ServerEnv>>)[provider];
  const value = key ? env[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** LLM_API_KEY wins, then the provider's own key. Generation only. */
function resolveApiKey(env: ServerEnv, provider: ProviderId): string | undefined {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  return resolveProviderKey(env, provider);
}

/** LLM_MODEL wins, then the provider's own variable, then the catalog. */
export function resolveModel(env: ServerEnv, provider: ProviderId): string {
  if (env.LLM_MODEL) return env.LLM_MODEL;

  const key = (PROVIDER_MODEL_ENV as Partial<Record<ProviderId, keyof ServerEnv>>)[provider];
  const providerSpecific = key ? env[key] : undefined;
  if (typeof providerSpecific === 'string' && providerSpecific.length > 0) {
    return providerSpecific;
  }

  return getProviderDescriptor(provider).defaultModel;
}

function resolveBaseUrl(
  configured: string | undefined,
  catalogDefault: string | null,
  variableName: string,
): string {
  const url = configured ?? catalogDefault;
  if (!url) {
    throw new ConfigurationError(
      `${variableName} must be set for this provider; it has no default endpoint.`,
      { variable: variableName },
    );
  }
  return url;
}

function assertApiKey(
  apiKey: string | undefined,
  required: boolean,
  variableName: string,
  provider: string,
): void {
  if (required && !apiKey) {
    throw new ConfigurationError(
      `${variableName} is required for the "${provider}" provider.`,
      { variable: variableName, provider },
    );
  }
}

export function getLLMConfig(): LLMProviderConfig {
  const env = getServerEnv();
  const descriptor = getProviderDescriptor(env.LLM_PROVIDER);

  const baseUrl = resolveBaseUrl(
    env.LLM_BASE_URL ?? (env.LLM_PROVIDER === 'ollama' ? env.OLLAMA_BASE_URL : undefined),
    descriptor.defaultBaseUrl,
    'LLM_BASE_URL',
  );

  const apiKey = resolveApiKey(env, env.LLM_PROVIDER);
  // Named so the error says GROQ_API_KEY rather than the generic override,
  // which is what someone actually needs to go and set.
  const keyVariable =
    (PROVIDER_KEY_ENV as Partial<Record<ProviderId, string>>)[env.LLM_PROVIDER] ?? 'LLM_API_KEY';
  assertApiKey(apiKey, descriptor.requiresApiKey, keyVariable, env.LLM_PROVIDER);

  return {
    provider: env.LLM_PROVIDER,
    model: resolveModel(env, env.LLM_PROVIDER),
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    temperature: env.LLM_TEMPERATURE,
    maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    contextWindow: env.LLM_CONTEXT_WINDOW,
    timeoutMs: env.LLM_TIMEOUT_MS,
  };
}

export function getEmbeddingConfig(): EmbeddingProviderConfig {
  const env = getServerEnv();
  const descriptor = getProviderDescriptor(env.EMBEDDING_PROVIDER);

  const baseUrl = resolveBaseUrl(
    env.EMBEDDING_BASE_URL ??
      (env.EMBEDDING_PROVIDER === 'ollama' ? env.OLLAMA_BASE_URL : undefined),
    descriptor.defaultBaseUrl,
    'EMBEDDING_BASE_URL',
  );

  // EMBEDDING_API_KEY is the generic override; the provider's own key is the
  // normal path, so both are accepted and the error names whichever is
  // actually missing rather than the one nobody sets.
  const apiKey = env.EMBEDDING_API_KEY ?? resolveProviderKey(env, env.EMBEDDING_PROVIDER);
  const keyVariable =
    (PROVIDER_KEY_ENV as Partial<Record<ProviderId, string>>)[env.EMBEDDING_PROVIDER] ??
    'EMBEDDING_API_KEY';
  assertApiKey(apiKey, descriptor.requiresApiKey, keyVariable, env.EMBEDDING_PROVIDER);

  return {
    provider: env.EMBEDDING_PROVIDER,
    model: resolveEmbeddingModel(env, env.EMBEDDING_PROVIDER),
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    dimensions: env.EMBEDDING_DIMENSIONS,
    documentPrefix: env.EMBEDDING_DOC_PREFIX,
    queryPrefix: env.EMBEDDING_QUERY_PREFIX,
    maxTokensPerRequest: env.EMBEDDING_MAX_TOKENS_PER_REQUEST,
    requestsPerMinute: env.EMBEDDING_REQUESTS_PER_MINUTE,
    tokensPerMinute: env.EMBEDDING_TOKENS_PER_MINUTE,
    maxRetries: env.EMBEDDING_MAX_RETRIES,
  };
}

export function getLLMProvider(): LLMProvider {
  // Registration is idempotent, and doing it here rather than as a top-level
  // import side effect keeps module load order from mattering.
  registerProviders();
  return createLLMProvider(getLLMConfig());
}

export function getEmbeddingProvider(): EmbeddingProvider {
  registerProviders();
  return createEmbeddingProvider(getEmbeddingConfig());
}
