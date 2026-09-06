import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getLLMConfig, resolveModel } from '@/server/ai/factory';
import { resetServerEnvCache } from '@/server/config/env';
import { serverEnvSchema } from '@/server/config/env.schema';

/**
 * Turning environment variables into a provider configuration.
 *
 * Two things are being protected here.
 *
 * The first is the promise that switching provider is one line. That only
 * holds if the model name and the credential are both resolved per provider,
 * so `LLM_PROVIDER=groq` does not go looking for `llama3.2:1b` or send Ollama
 * a key.
 *
 * The second is the quality of the failure. A hosted provider with no key is
 * the single most common way this application will be misconfigured, and the
 * error has to name the variable to set. Every assertion below checks the
 * VARIABLE NAME. None of them puts a key in a test file.
 */

const ORIGINAL_ENV = process.env;

/** Replaces the environment wholesale, so a stray local variable cannot leak in. */
function withEnv(vars: Record<string, string>): void {
  process.env = { NODE_ENV: 'test', ...vars } as NodeJS.ProcessEnv;
  resetServerEnvCache();
}

beforeEach(() => {
  resetServerEnvCache();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetServerEnvCache();
});

describe('missing credentials', () => {
  it('names GROQ_API_KEY when Groq is selected without one', () => {
    withEnv({ LLM_PROVIDER: 'groq' });

    expect(() => getLLMConfig()).toThrowError(/GROQ_API_KEY/);
  });

  it('reports it as a configuration problem, not a model failure', () => {
    withEnv({ LLM_PROVIDER: 'groq' });

    try {
      getLLMConfig();
      expect.unreachable('should have thrown');
    } catch (error) {
      const appError = error as { code: string; httpStatus: number; logMeta: { variable: string } };
      expect(appError.code).toBe('CONFIGURATION_ERROR');
      // 500, not 401. Nothing the caller did caused this and nothing they can
      // do will fix it.
      expect(appError.httpStatus).toBe(500);
      // The page reads this field to say which variable is missing, so it has
      // to be the name and not a sentence.
      expect(appError.logMeta.variable).toBe('GROQ_API_KEY');
    }
  });

  it('names each hosted provider own variable, not a generic one', () => {
    for (const [provider, variable] of [
      ['groq', 'GROQ_API_KEY'],
      ['openrouter', 'OPENROUTER_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
    ] as const) {
      withEnv({ LLM_PROVIDER: provider });
      expect(() => getLLMConfig()).toThrowError(new RegExp(variable));
    }
  });

  it('asks for no credential at all when running locally', () => {
    withEnv({ LLM_PROVIDER: 'ollama' });

    const config = getLLMConfig();
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe('http://127.0.0.1:11434');
  });
});

describe('configuration a valid key produces', () => {
  beforeEach(() => {
    withEnv({ LLM_PROVIDER: 'groq', GROQ_API_KEY: 'test-value-not-a-real-key' });
  });

  it('points at Groq with its default model', () => {
    const config = getLLMConfig();

    expect(config.provider).toBe('groq');
    expect(config.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(config.model).toBe('openai/gpt-oss-120b');
    expect(config.apiKey).toBe('test-value-not-a-real-key');
  });

  it('carries the generation settings through unchanged', () => {
    const config = getLLMConfig();

    expect(config.temperature).toBe(0.2);
    expect(config.maxOutputTokens).toBe(2048);
    expect(config.contextWindow).toBe(8192);
    expect(config.timeoutMs).toBe(120_000);
  });
});

describe('model resolution', () => {
  const parse = (vars: Record<string, string>) => serverEnvSchema.parse(vars);

  it('falls back to the catalog default for the selected provider', () => {
    // The reason LLM_PROVIDER can be changed on its own: a leftover Ollama
    // model name is not carried over to a provider that has never heard of it.
    expect(resolveModel(parse({}), 'groq')).toBe('openai/gpt-oss-120b');
    expect(resolveModel(parse({}), 'ollama')).toBe('llama3.2:1b');
  });

  it('prefers the provider own variable over the default', () => {
    expect(resolveModel(parse({ GROQ_MODEL: 'openai/gpt-oss-20b' }), 'groq')).toBe(
      'openai/gpt-oss-20b',
    );
  });

  it('lets LLM_MODEL override everything, whichever provider is selected', () => {
    const env = parse({ LLM_MODEL: 'explicit-choice', GROQ_MODEL: 'openai/gpt-oss-20b' });

    expect(resolveModel(env, 'groq')).toBe('explicit-choice');
    expect(resolveModel(env, 'ollama')).toBe('explicit-choice');
  });

  it('ignores another provider model variable', () => {
    // The bug this prevents: switching to Groq while OLLAMA_MODEL is still set
    // and getting a 404 for a model name Groq has never heard of.
    expect(resolveModel(parse({ OLLAMA_MODEL: 'llama3.2:1b' }), 'groq')).toBe(
      'openai/gpt-oss-120b',
    );
  });
});
