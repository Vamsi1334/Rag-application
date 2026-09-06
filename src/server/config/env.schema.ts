import { z } from 'zod';
import { PROVIDER_IDS } from './providers';

/**
 * A URL that must be reachable over HTTP or HTTPS.
 *
 * Plain `z.url()` accepts any scheme, so `mongodb+srv://user:pass@host` and
 * `javascript:alert(1)` both pass it. Neither belongs in a variable the app
 * will fetch from or put in an href, so every URL here is narrowed to the two
 * protocols we actually use.
 */
const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * The shape of every server-side environment variable.
 *
 * This file is deliberately free of side effects and does not import
 * `server-only`, so tests can feed it objects directly. The file that actually
 * reads `process.env` is `env.ts` next door.
 *
 * WHY SO MANY `.optional()` CALLS
 * Most of these variables belong to features that do not exist yet. Making
 * them required now would mean `npm run dev` fails until you have a MongoDB
 * cluster and a Google OAuth client, which is a miserable first-run
 * experience. Instead they are optional here and the feature that needs one
 * asserts it at the point of use via `requireEnv()`. The comment on each group
 * records which phase makes it mandatory.
 */
export const serverEnvSchema = z.object({
  // ---- Runtime ----
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: httpUrl.default('http://localhost:3000'),
  LOG_LEVEL: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // ---- Database (required from the database phase) ----
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DB_NAME: z.string().min(1).default('ai_document_assistant'),

  // ---- Authentication (required from the authentication phase) ----
  /** Signs session cookies. Generate with: openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters').optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // ---- Text generation (required from the LLM phase) ----
  /**
   * Which vendor the application talks to.
   *
   * Defaults to Groq rather than Ollama, because Ollama runs on the machine
   * that started it: a deployed app pointed at 127.0.0.1 has nothing to talk
   * to, and the resulting connection refused is a confusing way to learn that.
   * Defaulting to a hosted provider means a deployment with no configuration
   * fails with "GROQ_API_KEY is required", which names the fix.
   *
   * Set LLM_PROVIDER=ollama to run locally with no key and no network.
   */
  LLM_PROVIDER: z.enum(PROVIDER_IDS).default('groq'),
  /**
   * Explicit model override, applied whichever provider is selected.
   *
   * Usually left unset. Model names are not portable between providers, so
   * each provider has its own variable (OLLAMA_MODEL below) and a catalog
   * default. That is what lets LLM_PROVIDER be switched on its own without
   * also having to remember to change the model name to match.
   *
   * Resolution order: LLM_MODEL, then <PROVIDER>_MODEL, then the catalog.
   */
  LLM_MODEL: z.string().min(1).optional(),
  /** Overrides the provider's default base URL. Rarely needed. */
  LLM_BASE_URL: httpUrl.optional(),
  /**
   * Generic credential override, applied whichever provider is selected.
   *
   * Usually left unset in favour of the per-provider keys below, so more than
   * one can be configured at once and switching LLM_PROVIDER stays a one-line
   * change.
   */
  LLM_API_KEY: z.string().min(1).optional(),
  /** Low values keep answers close to the retrieved text. */
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  /**
   * Ceiling on one generated answer.
   *
   * 2048 rather than something tighter because the current generation of
   * hosted models think before they answer, and those thinking tokens are
   * counted against this same ceiling. Set it too low and the model spends the
   * whole budget reasoning, then gets cut off with `finishReason: "length"`
   * and an empty or half-finished answer.
   */
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2048),
  /** The total token ceiling for one request. Used to budget the prompt. */
  LLM_CONTEXT_WINDOW: z.coerce.number().int().positive().default(8192),
  /**
   * Request timeout. Two minutes by default, which sounds excessive until you
   * run a model on a CPU: the first request after an idle period also pays to
   * load several gigabytes of weights into memory before generating anything.
   */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // ENABLE_AI_TEST_ENDPOINT used to live here. It kept /api/ai/chat switched
  // off in production because that route had no authentication and would
  // otherwise have been an open way to spend model capacity. The route now
  // requires a signed-in user, which is a real protection rather than a
  // hidden door, so the flag has gone. A leftover line in a .env.local is
  // harmless: this schema ignores variables it does not declare.

  // ---- Embeddings (required from the embeddings phase) ----
  EMBEDDING_PROVIDER: z.enum(PROVIDER_IDS).default('ollama'),
  EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
  EMBEDDING_BASE_URL: httpUrl.optional(),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  /**
   * Vector length. This value is baked into the database index, so changing it
   * later means re-embedding every document. 768 matches nomic-embed-text.
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),
  /**
   * Some embedding models are trained with task prefixes and quietly produce
   * worse vectors without them. Keeping the prefixes next to the model name
   * means they travel together when the model changes.
   */
  EMBEDDING_DOC_PREFIX: z.string().default('search_document: '),
  EMBEDDING_QUERY_PREFIX: z.string().default('search_query: '),

  // ---- Hosted provider credentials ----
  // Each is SECRET. Resolution order for a given provider: LLM_API_KEY, then
  // the provider's own key below.
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).optional(),
  /**
   * For the Gemini API. Deliberately NOT named GOOGLE_API_KEY: this project
   * already has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for OAuth sign-in,
   * which are a completely different credential for a completely different
   * service. Two similarly named Google secrets in one file is a mix-up
   * waiting to happen.
   */
  GOOGLE_AI_API_KEY: z.string().min(1).optional(),
  GOOGLE_AI_MODEL: z.string().min(1).optional(),

  // ---- Ollama ----
  OLLAMA_BASE_URL: httpUrl.default('http://127.0.0.1:11434'),
  /** Model used when LLM_PROVIDER=ollama. See LLM_MODEL for the order. */
  OLLAMA_MODEL: z.string().min(1).optional(),
});

export type ServerEnv = z.output<typeof serverEnvSchema>;

/**
 * Turns a Zod failure into a message that names the offending variables and
 * nothing else.
 *
 * This matters more than it looks. A naive error message interpolates the
 * received value, and the received value may be a database password. Crash
 * output ends up in terminals, CI logs and error trackers, so it is treated
 * with the same care as a log line.
 */
export function formatEnvIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return `  - ${name}: ${issue.message}`;
  });
  return `Invalid server environment variables:\n${lines.join('\n')}`;
}
