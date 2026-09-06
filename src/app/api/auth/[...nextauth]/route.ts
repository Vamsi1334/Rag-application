import { handlers } from '@/server/auth';

/**
 * Every Auth.js endpoint.
 *
 * This one catch-all serves /api/auth/signin, /api/auth/callback/google,
 * /api/auth/session, /api/auth/signout and the rest. The Google redirect URI
 * registered in Google Cloud Console points at the callback path here:
 *
 *   http://localhost:3000/api/auth/callback/google
 *
 * Node runtime, because the MongoDB adapter needs Node APIs that the Edge
 * runtime does not provide.
 */
export const runtime = 'nodejs';

export const { GET, POST } = handlers;
