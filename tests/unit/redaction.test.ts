import { describe, expect, it } from 'vitest';
import { safeMeta, sanitizeLogValue } from '@/server/observability/redaction';

/**
 * Log redaction.
 *
 * This is the test the architecture plan promised: feed in a payload
 * containing every category of thing that must never be logged, and assert
 * none of it survives.
 *
 * It is worth keeping even though it looks paranoid. Logging is added to a
 * codebase gradually and by many hands, and the failure mode is silent: nobody
 * notices a leaked prompt until someone reads the logs.
 */
describe('safeMeta', () => {
  it('keeps fields on the allowlist', () => {
    const result = safeMeta({
      operation: 'rag.retrieve',
      userId: '6537f1a2b3c4d5e6f7890123',
      durationMs: 412,
      resultsReturned: 0,
    });

    expect(result.operation).toBe('rag.retrieve');
    expect(result.userId).toBe('6537f1a2b3c4d5e6f7890123');
    expect(result.durationMs).toBe(412);
    expect(result.resultsReturned).toBe(0);
    expect(result.droppedKeys).toBeUndefined();
  });

  it('drops everything not on the allowlist', () => {
    const result = safeMeta({
      operation: 'llm.complete',
      prompt: 'You are a helpful assistant. Context: [confidential contract text]',
      completion: 'The termination clause requires 90 days notice.',
      apiKey: 'gsk_live_abcdef123456',
      password: 'hunter2',
      authorization: 'Bearer eyJhbGciOi',
      cookie: 'session=abc123',
      email: 'someone@example.com',
      mongoUri: 'mongodb+srv://admin:pw@cluster.net',
      documentText: 'the entire contents of a private PDF',
      embedding: [0.12, 0.98, 0.44],
    });

    const serialized = JSON.stringify(result);

    expect(result.operation).toBe('llm.complete');
    for (const leak of [
      'confidential contract text',
      '90 days notice',
      'gsk_live_abcdef123456',
      'hunter2',
      'eyJhbGciOi',
      'session=abc123',
      'someone@example.com',
      'mongodb+srv',
      'private PDF',
      '0.98',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('names what it dropped so removals are never silent', () => {
    const result = safeMeta({ operation: 'x', prompt: 'secret', apiKey: 'secret' });

    expect(result.droppedKeys).toEqual(expect.arrayContaining(['prompt', 'apiKey']));
  });

  it('drops nested objects even under an allowed key', () => {
    // Without this rule, an allowed key becomes a smuggling route for
    // arbitrary content.
    const result = safeMeta({
      operation: 'ingest',
      model: { name: 'llama', secretKey: 'leaked' },
    });

    expect(result.model).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('leaked');
  });

  it('drops arrays that contain objects', () => {
    const result = safeMeta({
      operation: 'ingest',
      variables: [{ nested: 'leaked' }],
    });

    expect(result.variables).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('leaked');
  });

  it('truncates long strings', () => {
    const result = safeMeta({ operation: 'a'.repeat(5000) });

    expect(String(result.operation).length).toBeLessThan(300);
    expect(String(result.operation)).toContain('[truncated]');
  });

  it('handles undefined metadata', () => {
    expect(safeMeta(undefined)).toEqual({});
  });
});

describe('sanitizeLogValue', () => {
  it('strips characters that could forge extra log lines', () => {
    const injected = 'abc123\n{"level":"info","msg":"user promoted to admin"}';
    const cleaned = sanitizeLogValue(injected, 200);

    expect(cleaned).not.toContain('\n');
    expect(cleaned).not.toContain('"');
    expect(cleaned).not.toContain('{');
  });

  it('preserves ordinary identifier characters', () => {
    expect(sanitizeLogValue('req-abc.123:456')).toBe('req-abc.123:456');
  });

  it('enforces a maximum length', () => {
    expect(sanitizeLogValue('a'.repeat(500)).length).toBe(64);
  });
});
