import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { config, middleware } from '@/middleware';

/**
 * Route-protection middleware.
 *
 * Worth being precise about what this is: middleware runs on the Edge runtime
 * with no database access, so it can see that a session cookie EXISTS but not
 * that it is valid. It is a fast redirect for the common case, not a security
 * boundary. The real check is `requireUser()` on the page or route.
 *
 * These tests pin down the redirect behaviour, and the last one pins down the
 * limitation so nobody later mistakes this for the thing that keeps people
 * out.
 */

function request(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(new URL(`http://localhost:3000${path}`));
  if (cookie) req.cookies.set(cookie, 'some-session-value');
  return req;
}

describe('protected paths', () => {
  it('redirects to login when there is no session cookie', () => {
    const response = middleware(request('/dashboard'));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
  });

  it('remembers where the user was going', () => {
    const response = middleware(request('/dashboard/settings'));

    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('callbackUrl')).toBe('/dashboard/settings');
  });

  it('lets the request through when a session cookie is present', () => {
    const response = middleware(request('/dashboard', 'authjs.session-token'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('accepts the __Secure- cookie name used over HTTPS', () => {
    // The prefix is not decoration: browsers refuse a __Secure- cookie that
    // was not set over a secure connection. Missing this name would log every
    // production user out on every request.
    const response = middleware(request('/dashboard', '__Secure-authjs.session-token'));
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('public paths', () => {
  it('does not touch the login page', () => {
    // Redirecting the login page to itself would be an infinite loop.
    expect(middleware(request('/login')).headers.get('location')).toBeNull();
  });

  it('does not touch the home page or the auth routes', () => {
    for (const path of ['/', '/api/auth/callback/google', '/api/health']) {
      expect(middleware(request(path)).headers.get('location')).toBeNull();
    }
  });
});

describe('matcher', () => {
  it('runs only on protected paths', () => {
    // Matching the auth routes would break the sign-in flow itself, and
    // matching static assets costs latency on requests that can never need it.
    //
    // Every entry here drives something that costs money or reads private
    // data. A whitelist rather than a rule, so widening it is a deliberate
    // edit to this line and not a side effect of a pattern change.
    expect(config.matcher).toEqual([
      '/dashboard/:path*',
      '/chat/:path*',
      '/ai-test/:path*',
    ]);
  });

  it('never matches the auth routes', () => {
    /**
     * Redirecting an unauthenticated request to `/api/auth/*` would break
     * sign-in at the exact moment it is needed: the callback that establishes
     * the session arrives without one, gets bounced to `/login`, and the loop
     * never closes.
     */
    for (const pattern of config.matcher) {
      expect(pattern.startsWith('/api/')).toBe(false);
    }
  });
});

describe('the limitation this middleware has', () => {
  it('cannot tell a forged cookie from a real session', () => {
    // Deliberate and documented. Middleware has no database access, so any
    // cookie with the right NAME gets past it. That is why the page calls
    // requireUser(), which resolves the cookie against the sessions
    // collection. Treating middleware as the security boundary is a common
    // and serious mistake, so it is pinned down here.
    const response = middleware(request('/dashboard', 'authjs.session-token'));
    expect(response.headers.get('location')).toBeNull();
  });
});
