import 'server-only';

import type { ObjectId } from 'mongodb';

import { NotFoundError } from '@/server/observability/errors';
import { messagesCollection } from '../collections';
import { toObjectId } from '../ids';
import { newMessageSchema, type NewMessageInput } from '../schemas';
import type { MessageDoc } from '../types';
import { findConversationForUser, recordMessageOnConversation } from './conversations.repo';

/**
 * Messages.
 *
 * ---------------------------------------------------
 * Why creating a message checks the conversation first
 * ---------------------------------------------------
 * A message carries both `conversationId` and `userId`. Nothing stops a caller
 * from supplying its own `userId` with someone else's `conversationId`, which
 * would write a message into another user's thread that then passes every
 * ownership filter, because the `userId` on the row says it belongs to the
 * attacker.
 *
 * The ownership check therefore has to happen against the PARENT before the
 * insert. This is the general shape of the problem with denormalized
 * ownership: it makes reads cheap, and it means writes have to prove the
 * relationship rather than assert it.
 */

export async function createMessage(input: NewMessageInput): Promise<MessageDoc> {
  const parsed = newMessageSchema.parse(input);

  const conversation = await findConversationForUser(parsed.conversationId, parsed.userId);
  if (!conversation) {
    // Deliberately "not found" rather than "forbidden": a distinguishable
    // response would confirm that the conversation id exists.
    throw new NotFoundError('Conversation not found for this user', {
      conversationId: parsed.conversationId,
    });
  }

  const doc: Omit<MessageDoc, '_id'> = {
    userId: toObjectId(parsed.userId, 'userId'),
    conversationId: toObjectId(parsed.conversationId, 'conversationId'),
    role: parsed.role,
    content: parsed.content,
    createdAt: new Date(),
  };

  const collection = await messagesCollection();
  const result = await collection.insertOne(doc as MessageDoc);

  // Keeps the denormalized counter and timestamp on the conversation in step.
  await recordMessageOnConversation(parsed.conversationId, parsed.userId);

  return { ...doc, _id: result.insertedId } as MessageDoc;
}

export interface ListMessagesOptions {
  limit?: number;
  /** Cursor pagination: messages created after this point. */
  after?: Date;
}

export async function listMessagesForConversation(
  conversationId: ObjectId | string,
  userId: ObjectId | string,
  options: ListMessagesOptions = {},
): Promise<MessageDoc[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const collection = await messagesCollection();

  // Both ids are in the filter. Filtering on conversationId alone would return
  // another user's messages to anyone who guessed a conversation id.
  return collection
    .find({
      conversationId: toObjectId(conversationId, 'conversationId'),
      userId: toObjectId(userId, 'userId'),
      ...(options.after ? { createdAt: { $gt: options.after } } : {}),
    })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}

export async function countMessagesForConversation(
  conversationId: ObjectId | string,
  userId: ObjectId | string,
): Promise<number> {
  const collection = await messagesCollection();
  return collection.countDocuments({
    conversationId: toObjectId(conversationId, 'conversationId'),
    userId: toObjectId(userId, 'userId'),
  });
}

export async function deleteMessagesForConversation(
  conversationId: ObjectId | string,
  userId: ObjectId | string,
): Promise<number> {
  const collection = await messagesCollection();
  const result = await collection.deleteMany({
    conversationId: toObjectId(conversationId, 'conversationId'),
    userId: toObjectId(userId, 'userId'),
  });
  return result.deletedCount;
}
