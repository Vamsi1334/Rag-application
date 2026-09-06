import 'server-only';

import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

import { requireEnv } from '@/server/config/env';
import { logError, logInfo, logWarn } from '@/server/observability/logger';
import { createAuthAdapter } from './mongo-adapter';
import { clearAuthFailure, recordAuthFailure } from './last-error';

/**
 * Auth.js configuration.
 *
 * ------------------------------------------------------------
 * CONCEPT: what actually happens when you "sign in with Google"
 * ------------------------------------------------------------
 * 1. The user clicks the button. We redirect them to Google with our client
 *    ID, the scopes we want, and a random `state` value.
 * 2. Google authenticates them. We never see their password; that is the whole
 *    point of OAuth.
 * 3. Google redirects back to /api/auth/callback/google with a short-lived
 *    authorization code.
 * 4. Our SERVER exchanges that code for tokens, using the client secret. That
 *    exchange is server to server, which is why the secret never touches the
 *    browser.
 * 5. Auth.js upserts the user and account rows, creates a session row, and
 *    sets an httpOnly cookie.
 * 6. Every later request carries that cookie, and the server resolves it to a
 *    user.
 *
 * The cookie holds a session ID, not the user's identity. Nothing the browser
 * holds can be edited into being somebody else.
 *
 * ------------------------------------------------------------
 * Why this is a FUNCTION and not an exported object
 * ------------------------------------------------------------
 * The obvious version exports a plain object, and it breaks the production
 * build. Evaluating the object calls `requireEnv` and constructs the database
 * adapter, and a build machine has neither the credentials nor the database.
 * The build then fails while collecting page data, with an error pointing at
 * the route rather than at the missing variable, which is a genuinely
 * confusing hour to debug.
 *
 * Auth.js v5 accepts a function for exactly this reason: configuration is
 * resolved when a request arrives, by which point the environment exists.
 */
export function buildAuthConfig(): NextAuthConfig {
  return {
    adapter: createAuthAdapter(),

    /**
     * Database sessions, not JWT.
     *
     * A JWT session is self-contained, so the server can verify it without a
     * database lookup. That is faster, and it cannot be revoked: signing out
     * deletes the cookie, but the token itself stays valid until it expires,
     * so anyone who copied it keeps access.
     *
     * This application holds people's private documents, so signing out has to
     * actually mean something. The session lives in the database and signing
     * out deletes the row. The extra lookup is free in practice, because these
     * requests are hitting MongoDB anyway.
     */
    session: {
      strategy: 'database',
      maxAge: 30 * 24 * 60 * 60,
      // Refreshed at most daily rather than on every request, so an active
      // user is not constantly writing to the sessions collection.
      updateAge: 24 * 60 * 60,
    },

    providers: [
      Google({
        clientId: requireEnv('GOOGLE_CLIENT_ID', 'Google sign-in'),
        clientSecret: requireEnv('GOOGLE_CLIENT_SECRET', 'Google sign-in'),
        /**
         * Only the scopes needed to identify someone.
         *
         * Asking for more shows the user a scarier consent screen and hands us
         * data we would then be responsible for protecting. We need to know
         * who they are; we do not need their contacts or their Drive.
         */
        authorization: {
          params: { scope: 'openid email profile', prompt: 'select_account' },
        },
      }),
    ],

    pages: {
      signIn: '/login',
      // Failures come back to our own page, which renders the reason.
      error: '/login',
    },

    callbacks: {
      /**
       * Puts the user id on the session.
       *
       * Auth.js gives `session.user` a name, email and image but no id. That
       * id is the tenant key for the whole application, so this callback is
       * what makes `requireUser()` and every ownership filter possible.
       */
      session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },

      /**
       * Runs before a session is created.
       *
       * Google reports whether it has verified the address. Accounts here are
       * keyed by email, so accepting an unverified one would let someone claim
       * an address they do not control. That is account takeover, not an
       * inconvenience.
       */
      signIn({ profile }) {
        if (profile && profile.email_verified === false) {
          logWarn(
            { operation: 'auth.signIn', status: 'rejected' },
            'Rejected sign-in: Google reports the email address is not verified',
          );
          return false;
        }
        return true;
      },
    },

    events: {
      /**
       * Sign-in logging.
       *
       * The user id and nothing else. Not the email, which is personal data;
       * not the tokens, which are credentials. An id is enough to trace a
       * request and is meaningless to anyone without database access.
       */
      signIn({ user, isNewUser }) {
        // A success means any stored failure is now history, and showing it
        // on a later visit to /login would send someone chasing a fixed bug.
        clearAuthFailure();

        logInfo(
          {
            operation: 'auth.signIn',
            userId: user.id ?? 'unknown',
            status: isNewUser ? 'created' : 'existing',
          },
          'User signed in',
        );
      },

      signOut() {
        logInfo({ operation: 'auth.signOut' }, 'User signed out');
      },
    },

    /**
     * Routes Auth.js's own failures through our logger, and remembers the
     * reason so the login page can show it in development.
     *
     * Auth.js otherwise prints its diagnosis to stdout as an unstructured
     * stack trace and hands the browser the single word "Configuration".
     * That splits the answer from the question: the person staring at the
     * error page has to go and find a terminal, scroll past a wall of frames,
     * and spot one line. This puts the reason where they already are.
     */
    logger: {
      error(error: Error) {
        recordAuthFailure(error);
        logError(error, { operation: 'auth.error' });
      },
      warn(code: string) {
        logWarn({ operation: 'auth.warn', status: code }, 'Auth.js warning');
      },
      // Left empty on purpose. Auth.js debug output includes token payloads
      // and cookie values, and this project does not put those in logs.
      debug() {},
    },

    /**
     * Required when the app is not behind a host Auth.js recognizes on its
     * own. Without it, callback URL construction fails in a way that looks
     * exactly like a misconfigured Google client.
     */
    trustHost: true,
  };
}
