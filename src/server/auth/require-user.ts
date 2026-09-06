import 'server-only';

import { ObjectId } from 'mongodb';

import { UnauthorizedError } from '@/server/observability/errors';
import { setContextUserId } from '@/server/observability/request-context';
import { toObjectId } from '@/server/db/ids';
import { auth } from './index';

/**
 * The single way server code learns who is asking.
 *
 * ====================================================================
 * WHY THIS FUNCTION IS THE MOST IMPORTANT ONE IN THE AUTH LAYER
 * ====================================================================
 * Every repository written in the database phase takes `userId` as a required
 * argument and filters on it. There is no `findDocumentById(id)`; there is
 * only `findDocumentForUser(id, userId)`. That design is what stops one user
 * reading another's documents, and later it is what will constrain vector
 * search so one person's passages can never reach another person's prompt.
 *
 * All of it depends on `userId` being correct. This function is where that
 * value comes from, and it is the only place it comes from. It reads the
 * session cookie server-side; it never trusts a user id from a request body,
 * a query string, or a header, because all three are attacker-controlled.
 *
 * If you ever find yourself reading a user id from anywhere else, that is the
 * bug.
 * ====================================================================
 */

export interface AuthenticatedUser {
  /** The tenant key, ready to pass straight into a repository. */
  userId: ObjectId;
  /** Hex string form, for logs and API responses. */
  userIdString: string;
  email: string;
  name: string | null;
  image: string | null;
}

/**
 * Returns the signed-in user, or throws.
 *
 * Throwing rather than returning null is deliberate: a caller cannot forget to
 * check the result. `const { userId } = await requireUser()` either gives you a
 * real id or never reaches the next line.
 */
export async function requireUser(): Promise<AuthenticatedUser> {
  const session = await auth();

  if (!session?.user?.id) {
    throw new UnauthorizedError('No authenticated session', { operation: 'auth.requireUser' });
  }

  // The id came from our own database via the session, but it is parsed anyway.
  // Parsing is what guarantees an ObjectId reaches the query rather than
  // something shaped like a MongoDB operator, and the guarantee should not
  // depend on reasoning about where the value came from.
  const userId = toObjectId(session.user.id, 'userId');

  // Attaches the id to this request's log lines, so every subsequent line is
  // traceable to a user without any of them being passed it explicitly.
  setContextUserId(session.user.id);

  return {
    userId,
    userIdString: session.user.id,
    email: session.user.email ?? '',
    name: session.user.name ?? null,
    image: session.user.image ?? null,
  };
}

/**
 * The same, but returns null instead of throwing.
 *
 * For pages that render differently when signed in rather than refusing:
 * a home page showing "Sign in" or "Dashboard", say. Kept separate so the
 * throwing version stays the obvious default for anything protected.
 */
export async function getOptionalUser(): Promise<AuthenticatedUser | null> {
  try {
    return await requireUser();
  } catch {
    return null;
  }
}
