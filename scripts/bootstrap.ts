import { createRequire } from 'node:module';
import { loadEnvConfig } from '@next/env';

/**
 * Makes an operational script behave like the application.
 *
 * Two jobs, both of which are things Next.js does automatically and a bare
 * `tsx script.ts` does not.
 *
 * ------------------------------------------------------------------
 * 1. Load .env.local
 * ------------------------------------------------------------------
 * `next dev` reads .env.local, .env.development.local, .env and so on, in a
 * defined precedence order, before any of your code runs. A standalone script
 * gets none of that: `process.env` contains only what the shell exported, so a
 * key sitting in .env.local is invisible and the script reports it as missing.
 *
 * `loadEnvConfig` is the exact function Next.js uses internally, so the files
 * are found in the same order with the same precedence. A script therefore
 * sees precisely the configuration the running app sees, which is the point:
 * an index built from different settings than the app embeds with would be
 * worse than no index at all.
 *
 * ------------------------------------------------------------------
 * 2. Defuse the server-only guard
 * ------------------------------------------------------------------
 * ------------------------------------------------------------------
 * The problem
 * ------------------------------------------------------------------
 * Every file under `src/server/` begins with `import 'server-only'`. That
 * package exists to throw if it is ever pulled into a browser bundle, which is
 * what stops a stray import from shipping the MongoDB password to the client.
 * It is one of the guarantees this project rests on.
 *
 * It works by throwing on import unless Next.js has resolved it through its
 * own server condition. A plain `tsx scripts/thing.ts` has no Next.js, so the
 * guard fires and the script dies before it does anything:
 *
 *   Error: This module cannot be imported from a Client Component module.
 *
 * The guard is right. The script is also right. They just need introducing.
 *
 * ------------------------------------------------------------------
 * The fix
 * ------------------------------------------------------------------
 * Put an empty module in the require cache under `server-only`'s resolved
 * path, BEFORE anything imports it. Node then finds it already loaded and
 * never evaluates the real file that throws.
 *
 * This is the same trick the test suite uses, where `vitest.config.ts` aliases
 * `server-only` to `tests/stubs/server-only.ts`.
 *
 * ------------------------------------------------------------------
 * Why this does not weaken the guarantee
 * ------------------------------------------------------------------
 * The boundary it protects is the browser bundle, and this file is never in
 * one. It is imported only by `scripts/`, runs only in a terminal, and Next.js
 * resolves the real package during a build exactly as before. Nothing about
 * what reaches a client changes.
 *
 * The ESLint rule blocking `src/server/` imports from `src/lib/` and
 * `src/components/` is untouched and is the check that actually matters.
 *
 * ------------------------------------------------------------------
 * Usage
 * ------------------------------------------------------------------
 * Import this FIRST, then load server modules with `await import(...)` so they
 * are evaluated after the stub is in place. A static import would be hoisted
 * above this file's side effect and the guard would fire anyway.
 *
 *   import './bootstrap';
 *   const { thing } = await import('../src/server/...');
 */

/**
 * Load environment files first, exactly as Next.js would.
 *
 * `true` means development mode, which is what picks up .env.local. Set
 * NODE_ENV=production before running to load the production files instead.
 *
 * The logger is silenced because its default prints which files it found,
 * which is noise ahead of a script that reports its own configuration anyway.
 */
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production', {
  info: () => undefined,
  error: (...args: unknown[]) => console.error(...args),
});

const require = createRequire(import.meta.url);

try {
  const resolved = require.resolve('server-only');

  if (!require.cache[resolved]) {
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: {},
      children: [],
      paths: [],
    } as unknown as NodeModule;
  }
} catch {
  // Not installed, so nothing to stub and nothing to fail on.
}
