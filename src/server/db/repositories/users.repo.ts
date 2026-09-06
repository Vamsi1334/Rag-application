import 'server-only';

import type { ObjectId } from 'mongodb';

import { usersCollection } from '../collections';
import { toObjectId } from '../ids';
import { newUserSchema, type NewUserInput } from '../schemas';
import type { UserDoc } from '../types';

/**
 * Users.
 *
 * The one repository whose functions do not take a `userId` parameter, because
 * here the user IS the record rather than something a user owns. Every other
 * repository requires it.
 *
 * In the authentication phase, Auth.js takes over creating and updating these
 * rows through its MongoDB adapter. These functions stay useful for reading a
 * user outside the auth flow, and `create` is what tests and scripts use.
 */

export async function findUserById(userId: ObjectId | string): Promise<UserDoc | null> {
  const collection = await usersCollection();
  return collection.findOne({ _id: toObjectId(userId, 'userId') });
}

/**
 * Looks a user up by email.
 *
 * Lowercased first, because the unique index is case-sensitive and
 * `Mac@Example.com` and `mac@example.com` are the same account to a person.
 * `newUserSchema` lowercases on write; this keeps reads consistent with that.
 */
export async function findUserByEmail(email: string): Promise<UserDoc | null> {
  const collection = await usersCollection();
  return collection.findOne({ email: email.toLowerCase() });
}

export async function createUser(input: NewUserInput): Promise<UserDoc> {
  const parsed = newUserSchema.parse(input);
  const now = new Date();

  const doc: Omit<UserDoc, '_id'> = {
    email: parsed.email,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.image !== undefined ? { image: parsed.image } : {}),
    ...(parsed.emailVerified !== undefined ? { emailVerified: parsed.emailVerified } : {}),
    createdAt: now,
    updatedAt: now,
  };

  const collection = await usersCollection();
  const result = await collection.insertOne(doc as UserDoc);
  return { ...doc, _id: result.insertedId } as UserDoc;
}
