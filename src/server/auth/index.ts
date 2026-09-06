import 'server-only';

import NextAuth from 'next-auth';

import { buildAuthConfig } from './config';

/**
 * The Auth.js entry point.
 *
 * `NextAuth()` returns everything the rest of the app needs:
 *
 *   handlers  the GET and POST route handlers mounted at /api/auth/*
 *   auth      reads the current session on the server
 *   signIn    starts an OAuth flow, from a Server Action
 *   signOut   ends the session and deletes the database row
 *
 * The config is passed as a FUNCTION rather than an object, so Auth.js
 * resolves it per request instead of at import time. That is what lets the app
 * build on a machine with no database and no OAuth credentials; see the
 * comment in config.ts.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => buildAuthConfig());
