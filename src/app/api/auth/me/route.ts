import { requireUser } from '@/server/auth/require-user';
import { createRoute, json } from '@/server/http/route';

/**
 * GET /api/auth/me
 *
 * The signed-in user's basic details. Rejects anything without a valid
 * session with a 401.
 *
 * A static segment beats a catch-all in Next.js routing, so this wins over
 * /api/auth/[...nextauth] rather than being swallowed by it. That precedence
 * is verified by an end-to-end check, because getting it wrong would mean this
 * route silently never runs.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface MeResponse {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

export const GET = createRoute('auth.me', async () => {
  // Throws UnauthorizedError when there is no session; the route wrapper turns
  // that into a 401 with a safe body. No `if (!session) return 401` to forget.
  const user = await requireUser();

  const body: MeResponse = {
    id: user.userIdString,
    email: user.email,
    name: user.name,
    image: user.image,
  };

  // Never cached: it is per-user and a shared cache would be a data leak of
  // the worst kind.
  return json(body, { headers: { 'cache-control': 'no-store, private' } });
});
