import 'server-only';

import type { Collection } from 'mongodb';

import { getDb } from './client';
import type {
  ConversationDoc,
  DocumentChunkDoc,
  DocumentDoc,
  MessageDoc,
  UserDoc,
} from './types';

/**
 * Typed collection accessors.
 *
 * Collection names appear here exactly once. Everywhere else refers to them
 * through these functions, so a typo is a compile error rather than a query
 * that silently reads from a collection that does not exist and returns
 * nothing. That failure mode is particularly nasty: an empty result looks like
 * "no data" rather than "wrong collection".
 *
 * The generic parameter is what gives `find`, `insertOne` and the rest their
 * types, so a field name that does not exist on the entity fails to compile.
 */

export const COLLECTIONS = {
  users: 'users',
  documents: 'documents',
  documentChunks: 'document_chunks',
  conversations: 'conversations',
  messages: 'messages',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export async function usersCollection(): Promise<Collection<UserDoc>> {
  return (await getDb()).collection<UserDoc>(COLLECTIONS.users);
}

export async function documentsCollection(): Promise<Collection<DocumentDoc>> {
  return (await getDb()).collection<DocumentDoc>(COLLECTIONS.documents);
}

export async function documentChunksCollection(): Promise<Collection<DocumentChunkDoc>> {
  return (await getDb()).collection<DocumentChunkDoc>(COLLECTIONS.documentChunks);
}

export async function conversationsCollection(): Promise<Collection<ConversationDoc>> {
  return (await getDb()).collection<ConversationDoc>(COLLECTIONS.conversations);
}

export async function messagesCollection(): Promise<Collection<MessageDoc>> {
  return (await getDb()).collection<MessageDoc>(COLLECTIONS.messages);
}
