import { ConfigurationError, NotImplementedError } from '@/server/observability/errors';
import { getProviderDescriptor, type ProviderId } from '@/server/config/providers';
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingProviderFactory,
  LLMProvider,
  LLMProviderConfig,
  LLMProviderFactory,
} from './types';

/**
 * The provider registry.
 *
 * Providers register themselves here; the application asks for one by id. That
 * indirection is the whole point: adding Groq later is a new file plus one
 * `registerLLMProvider` call, with no change anywhere else, and switching
 * between them is an environment variable rather than a refactor.
 *
 * This file holds no vendor code and no environment access, which keeps it
 * testable in isolation. `factory.ts` next door is the piece that reads
 * configuration.
 */

const llmFactories = new Map<ProviderId, LLMProviderFactory>();
const embeddingFactories = new Map<ProviderId, EmbeddingProviderFactory>();

export function registerLLMProvider(id: ProviderId, factory: LLMProviderFactory): void {
  llmFactories.set(id, factory);
}

export function registerEmbeddingProvider(
  id: ProviderId,
  factory: EmbeddingProviderFactory,
): void {
  embeddingFactories.set(id, factory);
}

export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  const descriptor = getProviderDescriptor(config.provider);

  if (!descriptor.capabilities.chat) {
    throw new ConfigurationError(
      `Provider "${config.provider}" does not support text generation. ` +
        `Set LLM_PROVIDER to a provider that does.`,
      { provider: config.provider, feature: 'chat' },
    );
  }

  const factory = llmFactories.get(config.provider);
  if (!factory) {
    throw new NotImplementedError(
      `The "${config.provider}" text generation provider has not been implemented yet.`,
      { provider: config.provider, feature: 'chat' },
    );
  }

  return factory(config);
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  const descriptor = getProviderDescriptor(config.provider);

  if (!descriptor.capabilities.embeddings) {
    throw new ConfigurationError(
      `Provider "${config.provider}" does not offer an embedding model. ` +
        `Set EMBEDDING_PROVIDER to a provider that does.`,
      { provider: config.provider, feature: 'embeddings' },
    );
  }

  const factory = embeddingFactories.get(config.provider);
  if (!factory) {
    throw new NotImplementedError(
      `The "${config.provider}" embedding provider has not been implemented yet.`,
      { provider: config.provider, feature: 'embeddings' },
    );
  }

  return factory(config);
}

export function getRegisteredProviders(): { llm: ProviderId[]; embedding: ProviderId[] } {
  return {
    llm: [...llmFactories.keys()],
    embedding: [...embeddingFactories.keys()],
  };
}

/** Test helper. Empties the registry between cases. */
export function resetRegistry(): void {
  llmFactories.clear();
  embeddingFactories.clear();
}
