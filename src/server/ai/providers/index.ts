import { registerEmbeddingProvider, registerLLMProvider } from '../registry';
import { createOllamaProvider } from './ollama';
import { createOpenAICompatibleProvider } from './openai-compatible';
import { createVoyageEmbeddingProvider } from './voyage';

/**
 * Provider registration.
 *
 * The single place where a vendor implementation is connected to the registry.
 * Adding Groq later is one import and one line here; nothing else in the
 * application changes, because nothing else in the application names a vendor.
 *
 * Importing this module is what makes providers available, so it is imported
 * once by `factory.ts` rather than by every caller.
 */

let registered = false;

export function registerProviders(): void {
  // Module scope is re-evaluated by hot reload, so this is idempotent rather
  // than a top-level side effect.
  if (registered) return;

  registerLLMProvider('ollama', createOllamaProvider);

  // These three speak the same OpenAI-style /chat/completions API, so one
  // implementation serves all of them. They differ only in base URL and model
  // name, both of which come from configuration.
  registerLLMProvider('groq', createOpenAICompatibleProvider);
  registerLLMProvider('openrouter', createOpenAICompatibleProvider);
  registerLLMProvider('openai', createOpenAICompatibleProvider);

  // Google's Gemini API is NOT OpenAI-compatible: different paths, different
  // request shape, key in a header of its own. It would need its own file.
  //   registerLLMProvider('google', createGoogleProvider);
  //   registerEmbeddingProvider('google', createGoogleEmbeddingProvider);

  /**
   * Embeddings, registered into a separate map from generation.
   *
   * Voyage appears only here and Groq only above, which is the registry
   * expressing something true: neither vendor can do the other's job. Pointing
   * LLM_PROVIDER at Voyage fails at configuration time with a message saying
   * so, rather than at the first request with a 404.
   */
  registerEmbeddingProvider('voyage', createVoyageEmbeddingProvider);

  registered = true;
}

export { createOllamaProvider, getOllamaStatus } from './ollama';
export { createOpenAICompatibleProvider } from './openai-compatible';
export { createVoyageEmbeddingProvider, VOYAGE_SUPPORTED_DIMENSIONS } from './voyage';
