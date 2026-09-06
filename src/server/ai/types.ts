import type { ProviderId } from '@/server/config/providers';

/**
 * The contract every model provider has to satisfy.
 *
 * Nothing here is implemented yet. These are the shapes the application will
 * program against, so that no part of the codebase ever names a vendor.
 *
 * ---------------------------------------
 * CONCEPT: the two kinds of model we need
 * ---------------------------------------
 * A RAG application uses models for two completely different jobs.
 *
 * An EMBEDDING model turns a piece of text into a fixed-length list of numbers
 * positioned so that texts with similar meaning end up close together. That is
 * what makes search-by-meaning possible. It produces numbers, never words.
 *
 * An LLM (large language model) predicts text. Given the passages we retrieved
 * and the user's question, it writes the answer. It produces words, never
 * numbers.
 *
 * They are separate interfaces because they are separately configurable: the
 * sensible setup runs embeddings locally and generation on a hosted service.
 */

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Lower means more predictable. Grounded answers want a low value. */
  temperature?: number;
  maxOutputTokens?: number;
  /** Lets a caller abort a slow or cancelled generation. */
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'aborted' | 'error';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface Completion {
  text: string;
  finishReason: FinishReason;
  usage: TokenUsage;
}

/** One piece of a streamed answer. */
export interface StreamChunk {
  /** The text produced since the previous chunk. */
  delta: string;
  /** Present only on the final chunk. */
  finishReason?: FinishReason;
  usage?: TokenUsage;
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  /**
   * The total token budget for one request: system prompt, history, retrieved
   * passages, question and answer all share it.
   */
  readonly contextWindow: number;

  complete(request: CompletionRequest): Promise<Completion>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  /** Approximate token count. Exact tokenization differs per model family. */
  countTokens(text: string): number;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  readonly id: ProviderId;
  readonly model: string;
  /**
   * Vector length. Baked into the database index, so changing this means
   * re-embedding every stored document.
   */
  readonly dimensions: number;
  readonly maxInputTokens: number;

  /**
   * Embeds text that will be STORED and searched over.
   *
   * Deliberately separate from `embedQuery`. Some models are trained with a
   * different prefix for documents than for queries, and using the wrong one
   * does not error, it just quietly makes retrieval worse. Splitting the
   * methods puts that asymmetry in the interface instead of in a comment
   * someone has to remember.
   */
  embedDocuments(texts: string[]): Promise<number[][]>;

  /** Embeds a user's question, which will be compared against stored vectors. */
  embedQuery(text: string): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface LLMProviderConfig {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey?: string;
  temperature: number;
  maxOutputTokens: number;
  contextWindow: number;
  /**
   * How long to wait for a response.
   *
   * Configurable rather than constant because the right value depends
   * entirely on where the model runs: a hosted provider answers in a second,
   * while a local model on a CPU-only laptop can take a minute, plus several
   * more the first time it loads its weights into memory.
   */
  timeoutMs: number;
}

export interface EmbeddingProviderConfig {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey?: string;
  dimensions: number;
  documentPrefix: string;
  queryPrefix: string;
}

export type LLMProviderFactory = (config: LLMProviderConfig) => LLMProvider;
export type EmbeddingProviderFactory = (config: EmbeddingProviderConfig) => EmbeddingProvider;
