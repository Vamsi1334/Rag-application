import next from 'eslint-config-next';

/**
 * ESLint flat config.
 *
 * Beyond the Next.js defaults, this adds two project rules that encode
 * architectural decisions, so they are enforced by tooling rather than by
 * remembering.
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'coverage/**', 'next-env.d.ts'],
  },

  ...next,

  {
    rules: {
      // The logger produces structured, redacted output. console.log does not,
      // and it is how document text ends up in a production log.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  {
    // Scoped to TypeScript files because the @typescript-eslint plugin is only
    // registered for them by eslint-config-next. An unscoped override would
    // apply to .mjs config files too and fail to resolve the plugin.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    /**
     * The client bundle boundary.
     *
     * Anything under `src/lib/` or `src/components/` can be bundled for the
     * browser, so it must never reach into `src/server/`, where the secrets
     * live. The `server-only` package catches this at build time; this rule
     * catches it while you are still typing, with a message that explains why.
     *
     * Server Components under `src/app/` are deliberately not covered: they run
     * on the server and importing server code is exactly what they are for.
     */
    files: ['src/lib/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server', '@/server/*', '**/server/*'],
              message:
                'Client-bundled code cannot import from src/server. Move the shared piece into src/lib, or make this a Server Component.',
            },
          ],
        },
      ],
    },
  },
];

export default config;
