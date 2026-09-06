import type { DefaultSession } from 'next-auth';

/**
 * Type augmentation for the session object.
 *
 * ------------------------------------------------------------------
 * Why this file matters more than it looks
 * ------------------------------------------------------------------
 * Auth.js ships `session.user` with `name`, `email` and `image`, but no `id`.
 * That id is the tenant key for this entire application: every document, every
 * chunk, every conversation is filtered by it, and the vector search will be
 * constrained by it so one user's passages can never reach another user's
 * prompt.
 *
 * Declaring it here means `session.user.id` is a typed `string` everywhere
 * rather than something each call site has to cast. A cast is a place where
 * someone can quietly get it wrong, and getting this wrong is the worst bug
 * this codebase can have.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      /** The MongoDB `_id` as a hex string. The tenant key. */
      id: string;
    } & DefaultSession['user'];
  }
}

export {};
