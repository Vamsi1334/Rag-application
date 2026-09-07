/**
 * The provider catalog.
 *
 * ------------------------------------------------------------------
 * CONCEPT: why an application should not import a vendor SDK directly
 * ------------------------------------------------------------------
 * An LLM provider is just an HTTP API that takes a prompt and returns text.
 * Ollama, Groq, OpenRouter, OpenAI and Google all do the same job with
 * slightly different request shapes. If the application calls one of them
 * directly, switching later means editing every call site.
 *
 * So the application never names a vendor. It asks for "the configured LLM
 * provider" and gets back something matching a fixed interface. This file is
 * the list of vendors the application is allowed to be pointed at, plus the
 * facts about each one that the rest of the code needs to know.
 *
 * Nothing here talks to a network. Implementations come in a later phase; this
 * is the shape they will have to fit.
 */

export const PROVIDER_IDS = [
  'ollama',
  'groq',
  'openrouter',
  'openai',
  'google',
  'voyage',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderCapabilities {
  /** Can generate text from a prompt. */
  chat: boolean;
  /** Can turn text into an embedding vector. */
  embeddings: boolean;
  /** Can return the answer token by token instead of all at once. */
  streaming: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  /** Where the provider lives, when it is fixed. `null` means it must be configured. */
  defaultBaseUrl: string | null;
  /**
   * The model used when nothing more specific is configured.
   *
   * Per provider, because model names are not portable: `llama3.2:1b` means
   * nothing to Groq and `openai/gpt-oss-120b` means nothing to Ollama. This is
   * what lets LLM_PROVIDER be switched without also editing the model.
   *
   * These values go stale. Providers retire models on a published schedule,
   * and a default naming a retired one turns into a 404 with no obvious cause.
   * Groq shut down `llama-3.3-70b-versatile` on 2026-08-16, which is why the
   * Groq entry below now names its recommended replacement.
   */
  defaultModel: string;
  /** Whether a credential is required. Local providers need none. */
  requiresApiKey: boolean;
  capabilities: ProviderCapabilities;
  /** Flipped to true as each provider is actually built. */
  implemented: boolean;
  notes: string;
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderDescriptor> = {
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'llama3.2:1b',
    requiresApiKey: false,
    capabilities: { chat: true, embeddings: true, streaming: true },
    // Chat is implemented. Embeddings arrive in the embeddings phase.
    implemented: true,
    notes: 'Runs models on this machine. No API key, no network, no cost.',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    requiresApiKey: true,
    capabilities: { chat: true, embeddings: false, streaming: true },
    implemented: true,
    notes: 'Very fast hosted inference with a free tier. Text generation only.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    requiresApiKey: true,
    capabilities: { chat: true, embeddings: false, streaming: true },
    implemented: true,
    notes: 'One key, many models. Useful for comparing models side by side.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresApiKey: true,
    capabilities: { chat: true, embeddings: true, streaming: true },
    implemented: true,
    notes: 'Paid. Embedding dimensions differ from the local model, so switching needs a re-index.',
  },
  google: {
    id: 'google',
    label: 'Google AI Studio (Gemini)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    requiresApiKey: true,
    capabilities: { chat: true, embeddings: true, streaming: true },
    implemented: false,
    notes: 'Free tier with a very large context window.',
  },
  /**
   * Embeddings only, and the mirror image of Groq.
   *
   * Groq generates text and offers no embedding model. Voyage embeds text and
   * offers no chat model. Declaring `chat: false` here means pointing
   * LLM_PROVIDER at Voyage fails immediately with a clear message, rather than
   * producing a confusing 404 from an endpoint that does not exist.
   *
   * Chosen over the alternatives for three reasons that matter to this
   * project: a large free token allowance with no card required, output
   * dimensions reducible to 256 (see EMBEDDING_DIMENSIONS for why that
   * matters on a 512 MB cluster), and the same owner as MongoDB Atlas, which
   * is where the vectors are going.
   */
  voyage: {
    id: 'voyage',
    label: 'Voyage AI',
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    defaultModel: 'voyage-4-lite',
    requiresApiKey: true,
    capabilities: { chat: false, embeddings: true, streaming: false },
    implemented: true,
    notes: 'Embeddings only. Retrieval-tuned, with reducible output dimensions.',
  },
};

export function getProviderDescriptor(id: ProviderId): ProviderDescriptor {
  return PROVIDER_CATALOG[id];
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
