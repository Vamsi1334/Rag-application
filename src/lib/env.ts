import { z } from 'zod';

/**
 * PUBLIC environment variables.
 *
 * Everything in this file is safe to import from client components. Next.js
 * inlines `NEXT_PUBLIC_*` variables into the JavaScript bundle at build time,
 * which means anyone can read them in the browser. Never put a secret here.
 *
 * Note the literal `process.env.NEXT_PUBLIC_APP_URL` below: the inlining is a
 * find-and-replace on that exact text, so dynamic access such as
 * `process.env[name]` would silently produce `undefined` in the browser.
 *
 * Secrets live in `src/server/config/env.ts`, which cannot be imported from
 * client code.
 */
const publicEnvSchema = z.object({
  // Narrowed to http/https: z.url() alone would accept any scheme.
  NEXT_PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

const parsed = publicEnvSchema.safeParse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

if (!parsed.success) {
  // Only the variable names are printed, never the values.
  const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`Invalid public environment variables: ${names}`);
}

export const publicEnv: PublicEnv = parsed.data;
