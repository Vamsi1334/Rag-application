import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { fromObjectId, isValidObjectId, toObjectId } from '@/server/db/ids';

/**
 * Identifier parsing.
 *
 * The operator-injection tests at the bottom are the important ones. MongoDB
 * filters are objects, so an untrusted value that arrives as an object is
 * interpreted as a query operator rather than as data.
 */
describe('isValidObjectId', () => {
  it('accepts a real 24-character hex id', () => {
    expect(isValidObjectId(new ObjectId().toHexString())).toBe(true);
    expect(isValidObjectId('6537f1a2b3c4d5e6f7890123')).toBe(true);
  });

  it('accepts only the 24-character hex form', () => {
    // Historically ObjectId.isValid also accepted a raw 12-byte string, which
    // silently produced a DIFFERENT id than the caller asked for. Driver v7
    // tightened that, but the round-trip check in isValidObjectId does not
    // depend on the driver's current strictness: anything that does not
    // survive hex round-tripping is rejected here regardless.
    expect(isValidObjectId('aaaaaaaaaaaa')).toBe(false);

    const hex = new ObjectId().toHexString();
    expect(hex).toHaveLength(24);
    expect(isValidObjectId(hex)).toBe(true);
    // Uppercase hex is the same id, and must round-trip.
    expect(isValidObjectId(hex.toUpperCase())).toBe(true);
  });

  it('rejects malformed strings', () => {
    for (const value of ['', 'not-an-id', '6537f1a2b3c4d5e6f789012', '6537f1a2b3c4d5e6f78901234']) {
      expect(isValidObjectId(value)).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(isValidObjectId(value)).toBe(false);
    }
  });
});

describe('toObjectId', () => {
  it('converts a valid hex string', () => {
    const hex = '6537f1a2b3c4d5e6f7890123';
    expect(toObjectId(hex).toHexString()).toBe(hex);
  });

  it('passes an existing ObjectId through', () => {
    const id = new ObjectId();
    expect(toObjectId(id)).toBe(id);
  });

  it('rejects a query operator object', () => {
    // The attack: a JSON body of {"documentId": {"$ne": null}} becomes the
    // filter { _id: { $ne: null } }, which matches every row. Parsing through
    // toObjectId makes that impossible.
    expect(() => toObjectId({ $ne: null }, 'documentId')).toThrowError(/not a valid identifier/);
    expect(() => toObjectId({ $gt: '' }, 'documentId')).toThrowError(/not a valid identifier/);
  });

  it('rejects an array, which MongoDB would treat as an $in-style match', () => {
    expect(() => toObjectId(['6537f1a2b3c4d5e6f7890123'])).toThrowError();
  });

  it('names the field so the error is actionable', () => {
    expect(() => toObjectId('bad', 'conversationId')).toThrowError(/conversationId/);
  });

  it('never puts the rejected value in the error message', () => {
    // The value came from a request and could be anything, including something
    // that should not be written to a log.
    try {
      toObjectId('sessiontoken-abc123-secret', 'documentId');
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('sessiontoken');
      expect(message).not.toContain('secret');
    }
  });

  it('throws a ValidationError, so routes answer 400 rather than 500', () => {
    try {
      toObjectId('bad');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('VALIDATION_ERROR');
      expect((error as { httpStatus: number }).httpStatus).toBe(400);
    }
  });
});

describe('fromObjectId', () => {
  it('produces a JSON-safe string', () => {
    const id = new ObjectId();
    expect(fromObjectId(id)).toBe(id.toHexString());
    expect(typeof fromObjectId(id)).toBe('string');
  });
});
