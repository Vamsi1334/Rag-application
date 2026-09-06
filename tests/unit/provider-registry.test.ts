import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmbeddingProvider,
  createLLMProvider,
  getRegisteredProviders,
  registerEmbeddingProvider,
  registerLLMProvider,
  resetRegistry,
} from '@/server/ai/registry';
import { PROVIDER_CATALOG, PROVIDER_IDS, isProviderId } from '@/server/config/providers';
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  LLMProvider,
  LLMProviderConfig,
} from '@/server/ai/types';

/**
 * Provider registry.
 *
 * No vendor is implemented yet, so these tests use fakes. That is the point:
 * if a fake can satisfy the interface and the registry resolves it, the
 * application is genuinely decoupled from any particular vendor.
 */

const llmConfig: LLMProviderConfig = {
  provider: 'ollama',
  model: 'llama3.2:1b',
  baseUrl: 'http://127.0.0.1:11434',
  temperature: 0.2,
  maxOutputTokens: 1024,
  contextWindow: 8192,
  timeoutMs: 120_000,
};

const embeddingConfig: EmbeddingProviderConfig = {
  provider: 'ollama',
  model: 'nomic-embed-text',
  baseUrl: 'http://127.0.0.1:11434',
  dimensions: 768,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
};

function fakeLLM(config: LLMProviderConfig): LLMProvider {
  return {
    id: config.provider,
    model: config.model,
    contextWindow: config.contextWindow,
    complete: async () => ({
      text: 'fake',
      finishReason: 'stop' as const,
      usage: { promptTokens: 1, completionTokens: 1 },
    }),
    stream: async function* () {
      return;
    },
    countTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

function fakeEmbeddings(config: EmbeddingProviderConfig): EmbeddingProvider {
  return {
    id: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    maxInputTokens: 8192,
    embedDocuments: async (texts) => texts.map(() => new Array(config.dimensions).fill(0)),
    embedQuery: async () => new Array(config.dimensions).fill(0),
  };
}

afterEach(() => {
  resetRegistry();
});

describe('provider catalog', () => {
  it('has a descriptor for every declared provider id', () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_CATALOG[id]).toBeDefined();
      expect(PROVIDER_CATALOG[id].id).toBe(id);
    }
  });

  it('records which providers are implemented', () => {
    // Updated as each provider lands, so the catalog cannot drift out of step
    // with reality. Ollama has its own implementation; Groq, OpenRouter and
    // OpenAI share one, because they speak the same API.
    for (const id of ['ollama', 'groq', 'openrouter', 'openai'] as const) {
      expect(PROVIDER_CATALOG[id].implemented).toBe(true);
    }

    // Gemini is not OpenAI-compatible and needs its own file.
    expect(PROVIDER_CATALOG.google.implemented).toBe(false);
  });

  it('gives every provider a default model, since model names are not portable', () => {
    // Without this, switching LLM_PROVIDER while leaving a model name behind
    // produces a confusing 404 from the new provider.
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_CATALOG[id].defaultModel).toBeTruthy();
    }
  });

  it('marks local providers as needing no credential', () => {
    expect(PROVIDER_CATALOG.ollama.requiresApiKey).toBe(false);
    expect(PROVIDER_CATALOG.groq.requiresApiKey).toBe(true);
  });

  it('narrows an arbitrary string to a provider id', () => {
    expect(isProviderId('ollama')).toBe(true);
    expect(isProviderId('not-a-provider')).toBe(false);
  });
});

describe('registry resolution', () => {
  it('returns a registered provider', () => {
    registerLLMProvider('ollama', fakeLLM);
    const provider = createLLMProvider(llmConfig);

    expect(provider.id).toBe('ollama');
    expect(provider.model).toBe('llama3.2:1b');
    expect(provider.contextWindow).toBe(8192);
  });

  it('reports which providers are registered', () => {
    registerLLMProvider('ollama', fakeLLM);
    registerEmbeddingProvider('ollama', fakeEmbeddings);

    expect(getRegisteredProviders()).toEqual({ llm: ['ollama'], embedding: ['ollama'] });
  });

  it('fails clearly when a configured provider has no implementation', () => {
    expect(() => createLLMProvider(llmConfig)).toThrowError(/not been implemented/i);

    try {
      createLLMProvider(llmConfig);
    } catch (error) {
      expect((error as { code: string }).code).toBe('NOT_IMPLEMENTED');
    }
  });

  it('rejects a provider that cannot do the job it was configured for', () => {
    // Groq generates text but offers no embedding model. Catching this at
    // configuration time beats a confusing 404 from their API later.
    registerEmbeddingProvider('groq', fakeEmbeddings);

    expect(() =>
      createEmbeddingProvider({ ...embeddingConfig, provider: 'groq' }),
    ).toThrowError(/does not offer an embedding model/i);
  });

  it('builds an embedding provider at the configured dimensions', async () => {
    registerEmbeddingProvider('ollama', fakeEmbeddings);
    const provider = createEmbeddingProvider(embeddingConfig);

    expect(provider.dimensions).toBe(768);
    expect(await provider.embedQuery('hello')).toHaveLength(768);
  });
});
