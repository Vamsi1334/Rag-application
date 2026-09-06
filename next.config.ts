import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Fail the production build on type errors instead of shipping them.
  // This is the default, but stating it makes the intent explicit.
  //
  // There is no `eslint` key here: Next.js 16 removed the built-in lint step
  // from the build. Linting is its own command (`npm run lint`) and its own CI
  // step, which is clearer anyway.
  typescript: { ignoreBuildErrors: false },

  // Security headers applied to every response.
  // A Content-Security-Policy is deliberately NOT set yet: it needs to be written
  // against the real UI, and a wrong CSP silently breaks pages. Added in the
  // security-hardening phase.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
    ];
  },
};

export default nextConfig;
