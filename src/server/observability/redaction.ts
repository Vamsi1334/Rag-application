/**
 * Log redaction.
 *
 * ------------------------------------------------------
 * WHY AN ALLOWLIST AND NOT A LIST OF BANNED FIELD NAMES
 * ------------------------------------------------------
 * The obvious design is a denylist: strip anything called `password`,
 * `token`, `apiKey`. It fails the first time someone writes `pwd`,
 * `bearer`, `chunkText` or `raw`. A denylist has to predict every mistake
 * anyone will ever make.
 *
 * So the rule is inverted. A key is dropped unless it is explicitly on the
 * list below. Adding a new field to a log line is a deliberate act, and the
 * default for anything unforeseen is to be thrown away.
 *
 * Two extra rules close the remaining gaps:
 *   - Values must be primitives. A nested object could carry anything, so
 *     objects and arrays of objects are dropped even under an allowed key.
 *   - Strings are truncated. A field like `operation` should never be 40 KB,
 *     and if it is, something is wrong and we do not want it in the logs.
 *
 * Things that must never reach a log, an error tracker or a crash message:
 * document text, chunk content, embedding vectors, prompts, completions,
 * OAuth tokens, session cookies, API keys, connection strings, email
 * addresses.
 */

/** Every field name allowed in structured log metadata. */
export const ALLOWED_META_KEYS = new Set<string>([
  // request identity
  'requestId',
  'userId',
  'operation',
  'method',
  'path',
  'statusCode',
  'durationMs',

  // errors
  'errorType',
  'errorCode',
  'isOperational',
  'attempt',
  'retryable',
  'variable',
  'variables',
  'feature',
  'stage',
  'status',

  // documents and ingestion
  'documentId',
  'documentCount',
  'chunkId',
  'chunkCount',
  'pageCount',
  'sizeBytes',
  'mimeType',
  'fileExtension',
  'batchSize',
  /**
   * The CLASS NAME of a parser failure, never its message.
   *
   * pdf.js distinguishes `PasswordException`, `InvalidPDFException` and
   * `MissingPDFException`, which are three quite different problems and worth
   * knowing apart. Its error MESSAGES carry file paths and fragments of the
   * document, so only the name is ever assigned to this field. Anything
   * putting a parser message here has misunderstood what it is for.
   */
  'parserError',

  // retrieval
  'candidatesRequested',
  'resultsReturned',
  'topScore',
  'indexName',
  'filterKeys',

  // models
  'provider',
  'model',
  'embeddingModel',
  'embeddingDimensions',
  'tokenCount',
  'promptTokens',
  'completionTokens',
  'finishReason',

  // conversations
  'conversationId',
  'messageId',

  // rate limiting
  'limit',
  'window',
  'remaining',
]);

const MAX_STRING_LENGTH = 256;
const MAX_ARRAY_LENGTH = 20;

type Primitive = string | number | boolean | null;

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function clampString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : value;
}

function sanitizeValue(value: unknown): Primitive | Primitive[] | undefined {
  if (typeof value === 'string') return clampString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;

  if (Array.isArray(value)) {
    const primitives = value.filter(isPrimitive).slice(0, MAX_ARRAY_LENGTH);
    // If the array held anything non-primitive, drop it entirely rather than
    // silently logging a partial list.
    if (primitives.length !== Math.min(value.length, MAX_ARRAY_LENGTH)) return undefined;
    return primitives.map((item) => (typeof item === 'string' ? clampString(item) : item));
  }

  // undefined, objects, functions, symbols, bigints: dropped.
  return undefined;
}

export interface SafeMeta {
  [key: string]: Primitive | Primitive[] | undefined;
  /** Present only when something was removed, so drops are never silent. */
  droppedKeys?: string[];
}

/**
 * Filters arbitrary metadata down to what is safe to write to a log.
 *
 * Returns the allowed, sanitized fields plus a `droppedKeys` list naming what
 * was removed. The names of dropped keys are kept because a key name is not
 * sensitive and knowing that `prompt` was dropped is useful when debugging;
 * the value never survives.
 */
export function safeMeta(meta: Record<string, unknown> | undefined): SafeMeta {
  if (!meta) return {};

  const result: SafeMeta = {};
  const dropped: string[] = [];

  for (const [key, rawValue] of Object.entries(meta)) {
    if (!ALLOWED_META_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    const value = sanitizeValue(rawValue);
    if (value === undefined) {
      dropped.push(key);
      continue;
    }
    result[key] = value;
  }

  if (dropped.length > 0) {
    result.droppedKeys = dropped.slice(0, MAX_ARRAY_LENGTH).map(clampString);
  }

  return result;
}

/**
 * Strips characters that would let a value forge extra log lines.
 *
 * Anything taken from a request header is attacker-controlled. A value
 * containing a newline can inject a whole fake entry into a line-delimited
 * log, which is how audit trails get poisoned.
 */
export function sanitizeLogValue(value: string, maxLength = 64): string {
  return value.replace(/[^\w.:-]/g, '').slice(0, maxLength);
}
