import { describe, expect, it } from 'vitest';
import {
  driverErrorName,
  redactConnectionString,
  safeDriverMessage,
} from '@/server/db/redact';

/**
 * Connection string redaction.
 *
 * The MongoDB driver puts the connection string into several of its own error
 * messages, so a logged driver error is one of the most common ways a database
 * password escapes. These are the exact message shapes the driver produces.
 */
describe('redactConnectionString', () => {
  it('removes credentials from an SRV connection string', () => {
    const input =
      'MongoServerSelectionError: connect ECONNREFUSED ' +
      'mongodb+srv://appuser:hunter2@cluster0.abcde.mongodb.net/mydb?retryWrites=true';
    const output = redactConnectionString(input);

    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('appuser');
    expect(output).toContain('[credentials-redacted]');
  });

  it('removes credentials from a standard connection string', () => {
    const output = redactConnectionString('mongodb://root:s3cr3t@10.0.0.5:27017/admin');

    expect(output).not.toContain('s3cr3t');
    expect(output).not.toContain('root');
  });

  it('keeps the host, which is what makes the error actionable', () => {
    const output = redactConnectionString(
      'failed at mongodb+srv://u:p@cluster0.abcde.mongodb.net/db',
    );

    expect(output).toContain('cluster0.abcde.mongodb.net');
  });

  it('handles several connection strings in one message', () => {
    const output = redactConnectionString(
      'tried mongodb://a:pw1@host1 then mongodb+srv://b:pw2@host2.mongodb.net',
    );

    expect(output).not.toContain('pw1');
    expect(output).not.toContain('pw2');
  });

  it('catches credentials that lost their scheme', () => {
    const output = redactConnectionString('auth failed for admin:letmein@cluster0.xy.mongodb.net');

    expect(output).not.toContain('letmein');
    expect(output).toContain('cluster0.xy.mongodb.net');
  });

  it('leaves ordinary text alone', () => {
    const message = 'Connection pool cleared for cluster0.abcde.mongodb.net:27017';
    expect(redactConnectionString(message)).toBe(message);
  });

  it('handles a password containing URL-encoded characters', () => {
    // Passwords with symbols get percent-encoded in a connection string, and a
    // naive pattern that stops at the first special character would leak the
    // tail of the password.
    const output = redactConnectionString('mongodb+srv://user:p%40ss%3Aword@c.mongodb.net/db');

    expect(output).not.toContain('p%40ss');
    expect(output).not.toContain('word');
  });
});

describe('safeDriverMessage', () => {
  it('redacts the message of a thrown Error', () => {
    const error = new Error('auth failed on mongodb+srv://u:topsecret@c.mongodb.net');
    expect(safeDriverMessage(error)).not.toContain('topsecret');
  });

  it('does not stringify a non-Error, which could carry configuration', () => {
    expect(safeDriverMessage({ uri: 'mongodb+srv://u:pw@host' })).toBe('Unknown database error');
    expect(safeDriverMessage(null)).toBe('Unknown database error');
  });
});

describe('driverErrorName', () => {
  it('returns the error class name, which is safe and diagnostic', () => {
    const error = new Error('boom');
    error.name = 'MongoServerSelectionError';
    expect(driverErrorName(error)).toBe('MongoServerSelectionError');
  });

  it('falls back for non-Errors', () => {
    expect(driverErrorName('nope')).toBe('UnknownError');
  });
});
