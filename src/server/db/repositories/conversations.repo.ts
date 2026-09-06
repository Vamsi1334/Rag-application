import 'server-only';

import type { ObjectId } from 'mongodb';

import { conversationsCollection } from '../collections';
import { toObjectId } from '../ids';
import { newConversationSchema, type NewConversationInput } from '../schemas';
import type { ConversationDoc } from '../types';

/**
 * Conversations.
 *
 * Same ownership rule as documents: every function takes `userId` and filters
 * on it, and a conversation belonging to someone else reads as absent.
 */

function activeFilter(userId: ObjectId) {
  return { userId, deletedAt: null };
}

export async function createConversation(
  input: NewConversationInput,
): Promise<ConversationDoc> {
  const parsed = newConversationSchema.parse(input);
  const now = new Date();

  const doc: Omit<ConversationDoc, '_id'> = {
    userId: toObjectId(parsed.userId, 'userId'),
    // Replaced with a generated summary of the first question once chat exists.
    title: parsed.title ?? 'New conversation',
    messageCount: 0,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const collection = await conversationsCollection();
  const result = await collection.insertOne(doc as ConversationDoc);
  return { ...doc, _id: result.insertedId } as ConversationDoc;
}

export async function findConversationForUser(
  conversationId: ObjectId | string,
  userId: ObjectId | string,
): Promise<ConversationDoc | null> {
  const collection = await conversationsCollection();
  return collection.findOne({
    _id: toObjectId(conversationId, 'conversationId'),
    ...activeFilter(toObjectId(userId, 'userId')),
  });
}

export async function listConversationsForUser(
  userId: ObjectId | string,
  limit = 30,
): Promise<ConversationDoc[]> {
  const collection = await conversationsCollection();
  return collection
    .find(activeFilter(toObjectId(userId, 'userId')))
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .toArray();
}

/**
 * Records that a message was added.
 *
 * The counter and timestamp live on the conversation so the sidebar can be
 * rendered from one indexed query instead of an aggregation per thread.
 * Denormalized data has to be maintained, and this is the single place that
 * maintains it.
 */
export async function recordMessageOnConversation(
  conversationId: ObjectId | string,
  userId: ObjectId | string,
): Promise<ConversationDoc | null> {
  const now = new Date();
  const collection = await conversationsCollection();

  return collection.findOneAndUpdate(
    {
      _id: toObjectId(conversationId, 'conversationId'),
      ...activeFilter(toObjectId(userId, 'userId')),
    },
    {
      $inc: { messageCount: 1 },
      $set: { lastMessageAt: now, updatedAt: now },
    },
    { returnDocument: 'after' },
  );
}

export async function renameConversationForUser(
  conversationId: ObjectId | string,
  userId: ObjectId | string,
  title: string,
): Promise<ConversationDoc | null> {
  const parsed = newConversationSchema.shape.title.unwrap().parse(title);
  const collection = await conversationsCollection();

  return collection.findOneAndUpdate(
    {
      _id: toObjectId(conversationId, 'conversationId'),
      ...activeFilter(toObjectId(userId, 'userId')),
    },
    { $set: { title: parsed, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

export async function softDeleteConversationForUser(
  conversationId: ObjectId | string,
  userId: ObjectId | string,
): Promise<boolean> {
  const collection = await conversationsCollection();
  const result = await collection.updateOne(
    {
      _id: toObjectId(conversationId, 'conversationId'),
      ...activeFilter(toObjectId(userId, 'userId')),
    },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}
