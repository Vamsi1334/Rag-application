import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/*
 * Vite prints a one-time notice that this .ts config uses ESM syntax while
 * being loaded as CommonJS. It is cosmetic and does not affect the run.
 * The documented fixes are a .mjs/.mts extension or "type": "module" in
 * package.json; the first would leave a stale .ts config that silently takes
 * precedence, and the second changes module resolution for the whole project.
 * Neither is worth it for a notice.
 */

export default defineConfig({
  test: {
    // Everything tested here is server-side logic, so Node is the right
    // environment. A browser-like environment gets added alongside it when we
    // start testing React components.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // Integration tests start a real MongoDB. The first run on a new machine
    // downloads the server binary, which is why the hook timeout is generous.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Keeps JSON log lines out of the test report. The logger is still
    // exercised; it just does not write.
    env: { LOG_LEVEL: 'silent' },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /**
       * The `server-only` package throws on import outside a React Server
       * Component. That guard is exactly what we want in the build, and
       * exactly what would make every server module untestable.
       *
       * Aliasing it to an empty module here lets tests import the real code.
       * The build still resolves the real package, so the boundary it protects
       * is unchanged: this only affects Vitest.
       */
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
});
