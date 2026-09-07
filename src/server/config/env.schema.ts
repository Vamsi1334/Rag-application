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
  /**
   * Which vendor turns text into vectors.
   *
   * Separate from LLM_PROVIDER on purpose, and the two are genuinely
   * different vendors here: Groq generates answers and offers no embedding
   * model, Voyage embeds and offers no chat model. One variable could not
   * express that.
   */
  EMBEDDING_PROVIDER: z.enum(PROVIDER_IDS).default('voyage'),
  /**
   * Generic model override. Usually left unset in favour of the provider's own
   * variable below, exactly as LLM_MODEL relates to GROQ_MODEL.
   */
  EMBEDDING_MODEL: z.string().min(1).optional(),
  EMBEDDING_BASE_URL: httpUrl.optional(),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  /**
   * Vector length, and the least reversible setting in this file.
   *
   * It is declared on the Atlas vector index, and every stored vector must
   * match it. Changing it means a new index and re-embedding every document
   * ever uploaded, because a 256-number question cannot be compared against
   * 1024-number passages: they are different spaces, not different scales.
   *
   * 256 rather than the 1024 Voyage returns by default. Voyage's v4 models are
   * trained so the most important information sits in the earliest numbers,
   * which means the vector can be truncated with far less accuracy loss than
   * you would expect. The reason to take that trade here is storage: at four
   * bytes per number, 1024 dimensions is 4 KB per chunk, and an Atlas M0
   * cluster has 512 MB in total for vectors, text, documents and indexes
   * combined. 256 dimensions is 1 KB, which is four times the corpus for a
   * small quality cost.
   *
   * Voyage v4 models accept 256, 512, 1024 or 2048. Nothing else.
   */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(256),
  /**
   * Task prefixes, for models that need them written into the text.
   *
   * An embedding model is often trained to treat a passage being stored
   * differently from a question being asked, and giving it the wrong hint does
   * not error, it just quietly makes retrieval worse.
   *
   * Ollama's nomic-embed-text needs the prefix prepended by the caller, which
   * is what these are for. Voyage does the same job with an `input_type` field
   * in the request and prepends its own wording server-side, so the Voyage
   * provider ignores these. Prepending them as well would corrupt the input
   * with two competing instructions.
   */
  EMBEDDING_DOC_PREFIX: z.string().default('search_document: '),
  EMBEDDING_QUERY_PREFIX: z.string().default('search_query: '),

  // ---- Embedding rate limits ----
  /*
   * These three defaults are sized for Voyage's FREE TRIAL, which allows
   * 3 requests and 10,000 tokens per minute until a payment method is added.
   *
   * That ceiling is low enough to change the design rather than just the
   * numbers. 10,000 tokens per minute is about 22 chunks per minute, so a
   * sixty-page PDF cannot be embedded in one request at any batch size, and no
   * amount of retrying fixes it. Requests have to be both smaller and spaced
   * out. Defaulting to the tightest limits means ingestion works on a fresh
   * account without anyone having to discover this; raising them once a
   * payment method exists is three lines in `.env.local`.
   *
   * Tier 1 with a payment method is 2,000 RPM and 16,000,000 TPM for
   * voyage-4-lite, which is roughly three orders of magnitude more room.
   */
  /**
   * Token budget for a single embedding request.
   *
   * Below the 10,000-per-minute trial ceiling on purpose. The token count is
   * an estimate from character length, and it reads low for tables, code and
   * non-Latin scripts, so the gap is headroom for the estimate being wrong
   * rather than waste.
   */
  EMBEDDING_MAX_TOKENS_PER_REQUEST: z.coerce
    .number()
    .int()
    .min(500)
    .max(1_000_000)
    .default(8000),
  /**
   * How many embedding requests may be sent per minute.
   *
   * The provider paces itself to this, so batches are spread out instead of
   * being fired off together and rejected. On the trial the binding constraint
   * is tokens rather than requests, and pacing to 3 requests per minute at
   * 8,000 tokens each keeps both satisfied at once.
   */
  EMBEDDING_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(3),
  /**
   * How many tokens the provider allows per minute.
   *
   * Copied from the vendor's own limits page, alongside the request rate. Both
   * are here because pacing on requests alone is not enough: at 3 requests per
   * minute and 8,000 tokens each, the request rate is respected and the token
   * rate is breached twice over, which produces a 429 on schedule.
   *
   * The provider waits the longer of the two gaps, so setting these to the
   * numbers the vendor publishes makes pacing correct whatever the batch size
   * happens to be. That keeps the batch size a performance choice rather than
   * a correctness-critical one.
   *
   * 10,000 is the Voyage free trial. Tier 1 with a payment method is
   * 16,000,000 for voyage-4-lite.
   */
  EMBEDDING_TOKENS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1000)
    .max(100_000_000)
    .default(10_000),
  /**
   * How many times a rate-limited request is retried before giving up.
   *
   * A 429 on a free tier is an ordinary event, not an exceptional one, so
   * retrying is the normal path rather than error handling. Four attempts with
   * backoff covers a minute of waiting, which is the window these limits are
   * measured over.
   */
  EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),

  // ---- Chunking ----
  /**
   * How large each stored passage is, measured in characters rather than
   * tokens because chunking happens before any tokenizer is involved.
   *
   * 1800 characters is roughly 450 tokens. The reasoning: a retrieval step
   * fetches about five passages, and those five plus the question, the
   * instructions and room for an answer all have to fit inside the LLM's 8192
   * token context. Five 450-token passages is about 2250 tokens, which leaves
   * comfortable headroom.
   *
   * Smaller chunks match a question more precisely but carry less surrounding
   * context, so the model gets a sentence without the paragraph that explains
   * it. Larger chunks carry more context but dilute the match, because the
   * vector averages everything in the passage. This is a genuine trade with no
   * correct answer, which is why it is configuration rather than a constant.
   */
  CHUNK_SIZE: z.coerce.number().int().min(200).max(8000).default(1800),
  /**
   * How much text each chunk repeats from the one before it.
   *
   * Without overlap, a sentence that straddles a boundary is split in half and
   * neither half retrieves well. 200 characters, about 11 percent, is enough
   * to carry a sentence across the join without storing the document twice.
   */
  CHUNK_OVERLAP: z.coerce.number().int().min(0).max(2000).default(200),

  // ---- Retrieval ----
  /**
   * How many passages a question retrieves.
   *
   * Five is a deliberate middle. Too few and the answer misses something the
   * document actually says, because the one passage covering it ranked sixth.
   * Too many and the useful passage is diluted among weak ones, the model has
   * more room to wander, and every question costs more of the context window.
   *
   * Five passages at roughly 450 tokens each is about 2,250 tokens, which sits
   * comfortably inside an 8,192 token context alongside the instructions, the
   * question and room for an answer.
   */
  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  /**
   * The share of the context window that retrieved passages may occupy.
   *
   * A ceiling rather than a target. Passages are added in rank order until it
   * is reached, so a run of unusually long ones drops the weakest rather than
   * crowding out the space the answer needs. Without it, five long passages
   * plus a long question can leave the model with no room to reply, and the
   * symptom is a truncated answer rather than an error.
   */
  RETRIEVAL_CONTEXT_SHARE: z.coerce.number().min(0.1).max(0.9).default(0.5),

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
  /**
   * Voyage, for embeddings. SECRET.
   *
   * Named VOYAGE_EMBEDDING_MODEL rather than VOYAGE_MODEL because Voyage only
   * makes embedding models. The longer name says which half of the AI stack
   * this belongs to at a glance, next to GROQ_MODEL which is the other half.
   */
  VOYAGE_API_KEY: z.string().min(1).optional(),
  VOYAGE_EMBEDDING_MODEL: z.string().min(1).optional(),
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
