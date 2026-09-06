import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route protection, layer one of three.
 *
 * ------------------------------------------------------------------
 * What this does, and the important thing it deliberately does NOT do
 * ------------------------------------------------------------------
 * Middleware runs on the Edge runtime, which has no MongoDB driver. Sessions
 * in this application live in the database, so middleware CANNOT verify that a
 * session is real. All it can see is whether a session cookie exists.
 *
 * So this is a fast redirect for the common case, not a security boundary. A
 * forged cookie gets past it, and that is fine, because it then meets the two
 * layers that actually check:
 *
 *   1. this middleware        cheap redirect, no database
 *   2. requireUser() in the page or route    resolves the cookie against the
 *                                            database and throws if invalid
 *   3. the repository layer   every query filtered by the userId that came
 *                             from step 2
 *
 * Treating middleware as the security boundary is a common and serious
 * mistake. It is a user-experience optimization: it saves an unauthenticated
 * visitor from loading a page that would immediately bounce them.
 */

/**
 * Auth.js session cookie names.
 *
 * The `__Secure-` prefix is used over HTTPS. The prefix is not decoration: a
 * browser refuses to accept a `__Secure-` cookie that was not set over a
 * secure connection, which stops a network attacker injecting one.
 */
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'];

/** Paths that require a session. */
const PROTECTED_PREFIXES = ['/dashboard'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) return NextResponse.next();

  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (hasSessionCookie) return NextResponse.next();

  const loginUrl = new URL('/login', request.url);
  // Remember where they were going, so signing in lands them there rather
  // than dumping them on a generic page.
  loginUrl.searchParams.set('callbackUrl', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Only the protected paths.
   *
   * Running middleware on every request, including static assets and the auth
   * routes themselves, costs latency on requests that can never need it, and
   * matching the auth routes would break the sign-in flow.
   */
  matcher: ['/dashboard/:path*'],
};
