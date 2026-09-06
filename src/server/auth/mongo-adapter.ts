import 'server-only';

import { MongoDBAdapter } from '@auth/mongodb-adapter';
import type { Adapter, AdapterUser } from 'next-auth/adapters';

import { getMongoClient } from '@/server/db/client';
import { COLLECTIONS } from '@/server/db/collections';
import { getServerEnv } from '@/server/config/env';

/**
 * The database adapter, with two deliberate modifications.
 *
 * Auth.js's MongoDB adapter owns the `users`, `accounts`, `sessions` and
 * `verification_tokens` collections. It is wrapped rather than replaced,
 * because reimplementing an identity store is exactly the kind of code that
 * looks easy and then has a subtle bug in it for a year.
 *
 * The two changes are below, and both are about what ends up stored.
 */

/**
 * Fields we refuse to keep.
 *
 * By default the adapter stores Google's `access_token`, `refresh_token` and
 * `id_token` on the account row. Those exist so an app can call Google APIs on
 * the user's behalf later: read their calendar, send mail, list their Drive.
 *
 * This application never does that. It needs to know who you are once, at
 * sign-in, and nothing more. So the tokens are dropped before the row is
 * written.
 *
 * The reasoning is blast radius. A stored refresh token is a long-lived key to
 * someone's Google account, and a database leak that includes them is a far
 * worse day than one that does not. Data you never store cannot leak. If a
 * later feature genuinely needs Google API access, this is the deliberate
 * decision to revisit.
 */
const DISCARDED_ACCOUNT_FIELDS = ['access_token', 'refresh_token', 'id_token'] as const;

export function createAuthAdapter(): Adapter {
  // The same cached client the rest of the app uses, so Auth.js shares one
  // connection pool rather than opening a second.
  const clientPromise = getMongoClient();
  const base = MongoDBAdapter(clientPromise, {
    databaseName: getServerEnv().MONGODB_DB_NAME,
    collections: {
      Users: COLLECTIONS.users,
      Accounts: 'accounts',
      Sessions: 'sessions',
      VerificationTokens: 'verification_tokens',
    },
  });

  return {
    ...base,

    /**
     * Adds `createdAt` and `updatedAt`.
     *
     * The adapter does not write them, but the rest of the schema has them on
     * every collection and "when did this user sign up" is a question that
     * gets asked eventually. Setting them at creation is far cheaper than
     * backfilling later from nothing.
     */
    async createUser(user: AdapterUser) {
      const created = await base.createUser!(user);
      const now = new Date();

      const client = await clientPromise;
      await client
        .db(getServerEnv().MONGODB_DB_NAME)
        .collection(COLLECTIONS.users)
        .updateOne(
          { email: created.email },
          { $set: { createdAt: now, updatedAt: now } },
        );

      return created;
    },

    async updateUser(user) {
      const updated = await base.updateUser!(user);

      const client = await clientPromise;
      await client
        .db(getServerEnv().MONGODB_DB_NAME)
        .collection(COLLECTIONS.users)
        .updateOne({ email: updated.email }, { $set: { updatedAt: new Date() } });

      return updated;
    },

    /**
     * Strips the OAuth tokens described above before the row is stored.
     *
     * Returns void rather than the adapter's result: the signature allows
     * either, and there is nothing useful for a caller to do with the row.
     */
    async linkAccount(account): Promise<void> {
      const stripped = { ...account } as Record<string, unknown>;
      for (const field of DISCARDED_ACCOUNT_FIELDS) delete stripped[field];

      await base.linkAccount!(stripped as typeof account);
    },
  };
}
