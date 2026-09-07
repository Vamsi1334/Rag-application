import { describe, expect, it } from 'vitest';
import { formatEnvIssues, serverEnvSchema } from '@/server/config/env.schema';

/**
 * Environment schema.
 *
 * The last test is the one that matters most: a validation failure must never
 * print the value that failed, because that value may be a password.
 */
describe('serverEnvSchema', () => {
  it('applies defaults when nothing is set', () => {
    const result = serverEnvSchema.parse({});

    expect(result.NODE_ENV).toBe('development');
    expect(result.LOG_LEVEL).toBe('info');
    expect(result.APP_URL).toBe('http://localhost:3000');
    // A hosted provider, deliberately. Defaulting to Ollama would mean a
    // deployment with no configuration quietly points at 127.0.0.1 and fails
    // with a connection refused, instead of naming the variable to set.
    expect(result.LLM_PROVIDER).toBe('groq');
    // Embeddings are a different vendor from generation: Groq cannot embed and
    // Voyage cannot generate, so the two providers are set independently.
    expect(result.EMBEDDING_PROVIDER).toBe('voyage');
    /**
     * No default, on purpose. The model is resolved per provider in the
     * factory, exactly as LLM_MODEL relates to GROQ_MODEL. A shared default
     * here would hand Voyage the name of an Ollama model.
     */
    expect(result.EMBEDDING_MODEL).toBeUndefined();
    // Baked into the vector index. 256 rather than Voyage's 1024 default:
    // four times the corpus on a 512MB cluster.
    expect(result.EMBEDDING_DIMENSIONS).toBe(256);
    expect(result.OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434');
  });

  it('leaves unbuilt features optional so the app runs without them', () => {
    const result = serverEnvSchema.parse({});

    expect(result.MONGODB_URI).toBeUndefined();
    expect(result.AUTH_SECRET).toBeUndefined();
    expect(result.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('coerces numeric variables, which always arrive as strings', () => {
    const result = serverEnvSchema.parse({
      LLM_TEMPERATURE: '0.7',
      LLM_MAX_OUTPUT_TOKENS: '2048',
      EMBEDDING_DIMENSIONS: '1536',
    });

    expect(result.LLM_TEMPERATURE).toBe(0.7);
    expect(result.LLM_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(result.EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it('rejects an unknown provider', () => {
    const result = serverEnvSchema.safeParse({ LLM_PROVIDER: 'definitely-not-a-provider' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed URL', () => {
    const result = serverEnvSchema.safeParse({ APP_URL: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('accepts only http and https for URL variables', () => {
    // A plain URL check passes anything with a scheme, including a connection
    // string pasted into the wrong variable or a javascript: URL that would be
    // dangerous if it ever reached an href.
    expect(serverEnvSchema.safeParse({ APP_URL: 'http://localhost:3000' }).success).toBe(true);
    expect(serverEnvSchema.safeParse({ APP_URL: 'https://example.com' }).success).toBe(true);
    expect(
      serverEnvSchema.safeParse({ APP_URL: 'mongodb+srv://admin:pw@cluster.net' }).success,
    ).toBe(false);
    expect(serverEnvSchema.safeParse({ APP_URL: 'javascript:alert(1)' }).success).toBe(false);
    expect(serverEnvSchema.safeParse({ OLLAMA_BASE_URL: 'ftp://host/x' }).success).toBe(false);
  });

  it('rejects an AUTH_SECRET that is too short to be safe', () => {
    const result = serverEnvSchema.safeParse({ AUTH_SECRET: 'short' });
    expect(result.success).toBe(false);
  });

  it('rejects a temperature outside the valid range', () => {
    expect(serverEnvSchema.safeParse({ LLM_TEMPERATURE: '5' }).success).toBe(false);
    expect(serverEnvSchema.safeParse({ LLM_TEMPERATURE: '-1' }).success).toBe(false);
  });

  it('never puts the offending value in the error message', () => {
    const secret = 'mongodb+srv://admin:hunter2@cluster.example.net';
    const result = serverEnvSchema.safeParse({
      APP_URL: secret,
      AUTH_SECRET: 'too-short',
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const message = formatEnvIssues(result.error);

    expect(message).toContain('APP_URL');
    expect(message).toContain('AUTH_SECRET');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('too-short');
  });
});
