import 'server-only';

import { getEmbeddingConfig, getEmbeddingProvider } from '@/server/ai/factory';
import { getServerEnv } from '@/server/config/env';
import { ConfigurationError, ValidationError } from '@/server/observability/errors';
import { logInfo } from '@/server/observability/logger';
import { VOYAGE_SUPPORTED_DIMENSIONS } from '@/server/ai/providers';

/**
 * The application's view of embedding.
 *
 * ------------------------------------------------------------------
 * Why this exists on top of the provider
 * ------------------------------------------------------------------
 * The provider knows how to talk to one vendor. This knows the rules that hold
 * regardless of vendor, and it is the only thing the RAG pipeline calls:
 *
 *   - which model produced a vector, recorded alongside it
 *   - that dimensions are consistent with what the index expects
 *   - that a configured dimension is one the provider can actually return
 *   - what gets logged, and what must not
 *
 * The pipeline never imports a provider directly. Swapping Voyage for another
 * vendor is a change to configuration and one registration line, and nothing
 * in ingestion or retrieval is touched.
 *
 * ------------------------------------------------------------------
 * The rule this file exists to enforce
 * ------------------------------------------------------------------
 * NEVER MIX EMBEDDINGS FROM DIFFERENT MODELS IN ONE INDEX.
 *
 * Two models produce coordinates in unrelated spaces. Vectors from model A and
 * model B can have the same length and still mean nothing to each other, so
 * comparing them returns a number that looks like a similarity score and is
 * noise. Nothing errors. Search just quietly returns nonsense, and it is very
 * hard to trace back.
 *
 * Which is why `embeddingModel` is stored on every chunk: it is what makes a
 * model change detectable and migratable rather than silently corrupting.
 */

export interface EmbeddedText {
  vector: number[];
  /** Recorded per chunk, so a later model change can be found and migrated. */
  model: string;
  dimensions: number;
}

export interface EmbeddingModelInfo {
  provider: string;
  model: string;
  dimensions: number;
  maxInputTokens: number;
}

/**
 * Dimensions each provider will actually return.
 *
 * Checked at configuration time rather than on the first upload. A dimension
 * the provider rejects is a deployment mistake, and the useful moment to find
 * out is before a user has waited for a document to process.
 */
const SUPPORTED_DIMENSIONS: Record<string, readonly number[]> = {
  voyage: VOYAGE_SUPPORTED_DIMENSIONS,
};

function assertSupportedDimensions(provider: string, dimensions: number): void {
  const supported = SUPPORTED_DIMENSIONS[provider];
  if (supported && !supported.includes(dimensions)) {
    throw new ConfigurationError(
      `EMBEDDING_DIMENSIONS is ${dimensions}, which "${provider}" does not support. ` +
        `Allowed: ${supported.join(', ')}.`,
      { variable: 'EMBEDDING_DIMENSIONS', provider },
    );
  }
}

/** What the vector index has to be built for. Safe to expose: no credentials. */
export function getEmbeddingModelInfo(): EmbeddingModelInfo {
  const config = getEmbeddingConfig();
  assertSupportedDimensions(config.provider, config.dimensions);

  return {
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    maxInputTokens: getEmbeddingProvider().maxInputTokens,
  };
}

/**
 * Rejects input that would waste a call or poison the index.
 *
 * Whitespace-only text embeds to a vector that is a near-match for other
 * whitespace, so it surfaces as a false positive for unrelated questions.
 * Cheaper to refuse than to store.
 */
function assertEmbeddable(text: string, position?: number): void {
  if (text.trim().length === 0) {
    throw new ValidationError(
      position === undefined
        ? 'Cannot embed empty text'
        : `Cannot embed empty text at position ${position}`,
      { operation: 'rag.embed' },
    );
  }
}

/**
 * Embeds passages that will be STORED.
 *
 * Separate from `embedQuery` because the model is told which it is dealing
 * with, and the wrong answer degrades retrieval without erroring. See the
 * comment on `EmbeddingProvider` for why that asymmetry lives in the interface.
 */
export async function embedDocumentChunks(texts: string[]): Promise<EmbeddedText[]> {
  if (texts.length === 0) return [];
  texts.forEach((text, position) => assertEmbeddable(text, position));

  const provider = getEmbeddingProvider();
  assertSupportedDimensions(provider.id, provider.dimensions);

  const startedAt = Date.now();
  const vectors = await provider.embedDocuments(texts);

  if (vectors.length !== texts.length) {
    throw new ConfigurationError(
      `Embedding provider returned ${vectors.length} vectors for ${texts.length} inputs`,
      { provider: provider.id },
    );
  }

  /**
   * Logs the shape of the work, never the text.
   *
   * Chunk content is the user's private document. Token counts, timing and
   * model name are what you need to diagnose slow or failed ingestion, and
   * none of them reveal anything about what was uploaded.
   */
  logInfo(
    {
      operation: 'rag.embed',
      provider: provider.id,
      embeddingModel: provider.model,
      embeddingDimensions: provider.dimensions,
      chunkCount: texts.length,
      durationMs: Date.now() - startedAt,
    },
    'Embedded document chunks',
  );

  return vectors.map((vector) => ({
    vector,
    model: provider.model,
    dimensions: provider.dimensions,
  }));
}

/** Embeds a question, to be compared against stored passages. */
export async function embedSearchQuery(text: string): Promise<EmbeddedText> {
  assertEmbeddable(text);

  const provider = getEmbeddingProvider();
  assertSupportedDimensions(provider.id, provider.dimensions);

  const startedAt = Date.now();
  const vector = await provider.embedQuery(text);

  logInfo(
    {
      operation: 'rag.embedQuery',
      provider: provider.id,
      embeddingModel: provider.model,
      embeddingDimensions: provider.dimensions,
      durationMs: Date.now() - startedAt,
    },
    'Embedded search query',
  );

  return { vector, model: provider.model, dimensions: provider.dimensions };
}

/** Chunking settings, read once so callers do not each reach for the environment. */
export function getChunkingOptions(): { chunkSize: number; overlap: number } {
  const env = getServerEnv();
  return { chunkSize: env.CHUNK_SIZE, overlap: env.CHUNK_OVERLAP };
}
