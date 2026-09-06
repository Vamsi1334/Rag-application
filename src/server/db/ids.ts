import { ObjectId } from 'mongodb';

import { ValidationError } from '@/server/observability/errors';

/**
 * Identifier handling.
 *
 * ------------------------------------------------------------------
 * Why an id from a URL is never passed straight into a query
 * ------------------------------------------------------------------
 * MongoDB queries are objects, not strings, so classic string-concatenation
 * SQL injection does not apply. The equivalent risk is operator injection: if
 * a value taken from a request is an object rather than a string, it is
 * interpreted as a query operator.
 *
 * A request body of `{"id": {"$ne": null}}` becomes the filter
 * `{ _id: { $ne: null } }`, which matches everything. Parsing every id through
 * `toObjectId` makes that impossible, because the result is always an
 * `ObjectId` instance or a thrown error, never an attacker-shaped object.
 *
 * `ObjectId.isValid` alone is not enough: it returns true for any 12-character
 * string, so `'aaaaaaaaaaaa'` passes and then silently becomes a different id
 * than the caller meant. The round-trip check below rejects that.
 */

/** True for a string that is a real 24-character hex ObjectId. */
export function isValidObjectId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!ObjectId.isValid(value)) return false;
  // ObjectId.isValid accepts 12-byte strings as well as 24-char hex. Only the
  // hex form survives a round trip unchanged.
  return new ObjectId(value).toHexString() === value.toLowerCase();
}

/**
 * Converts an untrusted value into an ObjectId, or throws.
 *
 * `field` names what failed, so the error says "documentId is not a valid id"
 * rather than something the caller has to guess at. The offending value is
 * never included: it came from a request and could be anything.
 */
export function toObjectId(value: unknown, field = 'id'): ObjectId {
  if (value instanceof ObjectId) return value;
  if (!isValidObjectId(value)) {
    throw new ValidationError(`${field} is not a valid identifier`, { variable: field });
  }
  return new ObjectId(value);
}

/** Converts an id for an API response. JSON has no ObjectId type. */
export function fromObjectId(id: ObjectId): string {
  return id.toHexString();
}
