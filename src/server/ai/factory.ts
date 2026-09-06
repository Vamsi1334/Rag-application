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
} as const satisfies Partial<Record<ProviderId, keyof ServerEnv>>;

/** LLM_API_KEY wins, then the provider's own key. */
function resolveApiKey(env: ServerEnv, provider: ProviderId): string | undefined {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;

  const key = (PROVIDER_KEY_ENV as Partial<Record<ProviderId, keyof ServerEnv>>)[provider];
  const value = key ? env[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

  assertApiKey(
    env.EMBEDDING_API_KEY,
    descriptor.requiresApiKey,
    'EMBEDDING_API_KEY',
    env.EMBEDDING_PROVIDER,
  );

  return {
    provider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL,
    baseUrl,
    ...(env.EMBEDDING_API_KEY ? { apiKey: env.EMBEDDING_API_KEY } : {}),
    dimensions: env.EMBEDDING_DIMENSIONS,
    documentPrefix: env.EMBEDDING_DOC_PREFIX,
    queryPrefix: env.EMBEDDING_QUERY_PREFIX,
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
