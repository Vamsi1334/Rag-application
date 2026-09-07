import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getEmbeddingConfig, resolveEmbeddingModel } from '@/server/ai/factory';
import { resetServerEnvCache } from '@/server/config/env';
import { serverEnvSchema } from '@/server/config/env.schema';
import { PROVIDER_CATALOG } from '@/server/config/providers';

/**
 * Embedding configuration.
 *
 * Two vendors now, doing different jobs: Groq generates and cannot embed,
 * Voyage embeds and cannot generate. The failures this guards against are the
 * ones where those two wires get crossed, because none of them are obvious at
 * the point they happen.
 *
 * As always, every assertion checks a variable NAME. No key appears here.
 */

const ORIGINAL_ENV = process.env;

function withEnv(vars: Record<string, string>): void {
  process.env = { NODE_ENV: 'test', ...vars } as NodeJS.ProcessEnv;
  resetServerEnvCache();
}

beforeEach(resetServerEnvCache);

afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetServerEnvCache();
});

describe('the catalog', () => {
  it('records that Voyage embeds but cannot generate', () => {
    // This is what makes LLM_PROVIDER=voyage fail at configuration time with a
    // clear message instead of at the first request with a 404 from an
    // endpoint Voyage does not serve.
    expect(PROVIDER_CATALOG.voyage.capabilities.embeddings).toBe(true);
    expect(PROVIDER_CATALOG.voyage.capabilities.chat).toBe(false);
  });

  it('records the mirror image for Groq', () => {
    expect(PROVIDER_CATALOG.groq.capabilities.chat).toBe(true);
    expect(PROVIDER_CATALOG.groq.capabilities.embeddings).toBe(false);
  });

  it('points Voyage at its own API', () => {
    expect(PROVIDER_CATALOG.voyage.defaultBaseUrl).toBe('https://api.voyageai.com/v1');
    expect(PROVIDER_CATALOG.voyage.defaultModel).toBe('voyage-4-lite');
  });
});

describe('model resolution', () => {
  const parse = (vars: Record<string, string>) => serverEnvSchema.parse(vars);

  it('falls back to the catalog default for Voyage', () => {
    expect(resolveEmbeddingModel(parse({}), 'voyage')).toBe('voyage-4-lite');
  });

  it('prefers VOYAGE_EMBEDDING_MODEL over the default', () => {
    expect(
      resolveEmbeddingModel(parse({ VOYAGE_EMBEDDING_MODEL: 'voyage-4' }), 'voyage'),
    ).toBe('voyage-4');
  });

  it('lets EMBEDDING_MODEL override everything', () => {
    const env = parse({ EMBEDDING_MODEL: 'explicit', VOYAGE_EMBEDDING_MODEL: 'voyage-4' });

    expect(resolveEmbeddingModel(env, 'voyage')).toBe('explicit');
  });

  it('does not hand Ollama its chat model when asked for an embedding model', () => {
    // The catalog default for Ollama is llama3.2:1b, which is a chat model and
    // cannot embed. Reusing the generation resolver here would produce a
    // confusing failure from Ollama rather than a wrong-looking config.
    expect(resolveEmbeddingModel(parse({}), 'ollama')).toBe('nomic-embed-text');
  });

  it('ignores the generation model variable entirely', () => {
    // GROQ_MODEL and LLM_MODEL belong to the other half of the stack. Leaking
    // either into embeddings would ask Voyage for a model it has never heard of.
    expect(resolveEmbeddingModel(parse({ GROQ_MODEL: 'openai/gpt-oss-120b' }), 'voyage')).toBe(
      'voyage-4-lite',
    );
  });
});

describe('credentials', () => {
  it('names VOYAGE_API_KEY when it is missing', () => {
    withEnv({ EMBEDDING_PROVIDER: 'voyage' });

    expect(() => getEmbeddingConfig()).toThrowError(/VOYAGE_API_KEY/);
  });

  it('does not accept the generation key as a substitute', () => {
    // Groq and Voyage are different companies. Sending one key to the other
    // produces a 401 that reads like a bad key rather than crossed wiring.
    withEnv({
      EMBEDDING_PROVIDER: 'voyage',
      LLM_API_KEY: 'a-generation-key',
      GROQ_API_KEY: 'a-groq-key',
    });

    expect(() => getEmbeddingConfig()).toThrowError(/VOYAGE_API_KEY/);
  });

  it('builds a usable configuration once the key is present', () => {
    withEnv({ EMBEDDING_PROVIDER: 'voyage', VOYAGE_API_KEY: 'test-value-not-a-real-key' });

    const config = getEmbeddingConfig();

    expect(config.provider).toBe('voyage');
    expect(config.model).toBe('voyage-4-lite');
    expect(config.baseUrl).toBe('https://api.voyageai.com/v1');
    expect(config.dimensions).toBe(256);
  });

  it('asks for no credential when embedding locally', () => {
    withEnv({ EMBEDDING_PROVIDER: 'ollama' });

    const config = getEmbeddingConfig();

    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe('http://127.0.0.1:11434');
  });
});

describe('defaults that get baked into the index', () => {
  it('defaults to 256 dimensions', () => {
    // Four times the corpus on a 512MB cluster compared with Voyage's 1024
    // default, and changing it later means re-embedding everything.
    expect(serverEnvSchema.parse({}).EMBEDDING_DIMENSIONS).toBe(256);
  });

  it('defaults to Voyage as the embedding provider', () => {
    expect(serverEnvSchema.parse({}).EMBEDDING_PROVIDER).toBe('voyage');
  });

  it('keeps generation on Groq, unaffected by any of this', () => {
    expect(serverEnvSchema.parse({}).LLM_PROVIDER).toBe('groq');
  });

  it('defaults chunking to a size and overlap that fit the context window', () => {
    const env = serverEnvSchema.parse({});

    expect(env.CHUNK_SIZE).toBe(1800);
    expect(env.CHUNK_OVERLAP).toBe(200);
    // Overlap must stay below chunk size or the splitter cannot advance.
    expect(env.CHUNK_OVERLAP).toBeLessThan(env.CHUNK_SIZE);
  });
});

describe('the health report', () => {
  it('reports embeddings as ok once the key is set', async () => {
    withEnv({ EMBEDDING_PROVIDER: 'voyage', VOYAGE_API_KEY: 'test-value-not-a-real-key' });
    const { buildHealthReport } = await import('@/server/health/report');

    const check = buildHealthReport().checks.embeddings;

    expect(check?.status).toBe('ok');
    // Resolved through the factory, not read from EMBEDDING_MODEL, which is
    // now an optional override and would print the string "undefined".
    expect(check?.detail).toContain('voyage-4-lite');
    expect(check?.detail).toContain('256');
    expect(check?.detail).not.toContain('undefined');
  });

  it('reports embeddings as not configured when the key is missing', async () => {
    withEnv({ EMBEDDING_PROVIDER: 'voyage' });
    const { buildHealthReport } = await import('@/server/health/report');

    expect(buildHealthReport().checks.embeddings?.status).toBe('not_configured');
  });

  it('never puts the key itself in the report', async () => {
    // The health endpoint is public and unauthenticated. It reports status,
    // never values.
    withEnv({ EMBEDDING_PROVIDER: 'voyage', VOYAGE_API_KEY: 'a-secret-value-abc123' });
    const { buildHealthReport } = await import('@/server/health/report');

    expect(JSON.stringify(buildHealthReport())).not.toContain('a-secret-value-abc123');
  });
});
