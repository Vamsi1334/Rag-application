import 'server-only';

import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';

import { ValidationError } from '@/server/observability/errors';
import { cleanText } from './chunking';

/**
 * Getting readable text out of a file.
 *
 * ------------------------------------------------------------------
 * Why this is its own service
 * ------------------------------------------------------------------
 * It is the only part of ingestion that cares what format a file is in.
 * Everything after it works on a string, so adding DOCX later means one new
 * branch here and no change to chunking, embedding or storage.
 *
 * ------------------------------------------------------------------
 * The failure that matters most
 * ------------------------------------------------------------------
 * A scanned PDF is a stack of photographs. It opens, it has pages, it looks
 * completely normal, and it contains zero extractable characters.
 *
 * If that passes silently you get a document marked ready with no chunks, and
 * later a chat feature that answers "I could not find that in your documents"
 * for a file that is sitting right there. The user concludes the search is
 * broken. Nothing in the logs says otherwise.
 *
 * So an empty extraction is an error here, with a message that names the
 * likely cause. OCR is the fix, and it is a later phase.
 *
 * ------------------------------------------------------------------
 * Why unpdf
 * ------------------------------------------------------------------
 * It wraps Mozilla's pdf.js, so it is pure JavaScript with no native binary to
 * compile or ship. That matters for the serverless deployment later, where a
 * native dependency is the thing that works locally and fails in the cloud.
 * It also returns text per page, which is what lets a citation say which page
 * an answer came from.
 */

/** Formats that can be ingested today. */
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export interface ExtractedPage {
  /** 1-based, matching how a person refers to a page. */
  pageNumber: number;
  text: string;
}

export interface ExtractedDocument {
  /** Cleaned, with pages joined. What gets chunked. */
  text: string;
  /**
   * Per page, for formats that have pages. Empty for plain text and Markdown,
   * which is how a caller knows not to attach a page number to a chunk.
   */
  pages: ExtractedPage[];
  characterCount: number;
  pageCount: number;
}

export function isSupportedMimeType(value: string): value is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(value);
}

/** Guesses the type from a filename, for the CLI where no browser supplies one. */
export function mimeTypeFromFilename(filename: string): SupportedMimeType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'text/plain';
  return null;
}

/**
 * Refuses a document with nothing to search.
 *
 * Runs on the cleaned text, so a PDF containing only whitespace and page
 * furniture is caught as well as one containing literally nothing.
 */
function assertHasText(text: string, mimeType: string): void {
  if (text.trim().length > 0) return;

  throw new ValidationError(
    `No extractable text found in a ${mimeType} document`,
    { operation: 'rag.extract', mimeType },
    // Specific on purpose. This is the failure someone will actually hit, and
    // the generic "not valid" would send them to the logs to learn something
    // that gives nothing away: a fact about the file they just handed over.
    mimeType === 'application/pdf'
      ? 'No extractable text found. The PDF appears to be scanned, which means it holds ' +
          'images of text rather than text. OCR is not supported yet.'
      : 'No extractable text found. The document appears to be empty.',
  );
}

async function extractFromPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  let pages: string[];
  let totalPages: number;

  try {
    /**
     * A fresh copy of the bytes, deliberately.
     *
     * pdf.js takes ownership of the array it is handed and detaches the
     * underlying buffer. Reusing the caller's array would leave them holding
     * an empty one, and the second read of the same file throws
     * `DataCloneError: Cannot transfer object of unsupported type`, which
     * gives no hint that a buffer was consumed. Copying costs one allocation
     * and removes a whole class of confusing bug.
     */
    const proxy = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractPdfText(proxy, { mergePages: false });

    pages = Array.isArray(result.text) ? result.text : [result.text];
    totalPages = result.totalPages;
  } catch (error) {
    /**
     * The parser's message is dropped, not wrapped.
     *
     * pdf.js puts file paths and fragments of the document itself into its
     * error text, and this error is going to be logged. Document content in
     * logs is the leak this project spends most of its care avoiding, so the
     * message does not travel, even into a destination we trust.
     *
     * The class NAME does travel, because it is the diagnostic half and
     * carries nothing: `PasswordException`, `InvalidPDFException` and
     * `MissingPDFException` say which of three quite different problems this
     * is, without quoting a single character of the file.
     */
    throw new ValidationError(
      'The PDF could not be read. It may be corrupt or encrypted.',
      {
        operation: 'rag.extract',
        mimeType: 'application/pdf',
        parserError: error instanceof Error ? error.name : 'unknown',
      },
      'The PDF could not be read. It may be corrupt, or protected with a password.',
    );
  }

  const cleanedPages: ExtractedPage[] = pages
    .map((text, index) => ({ pageNumber: index + 1, text: cleanText(text) }))
    // A blank page is real and normal. Dropping it here keeps it out of the
    // page list without disturbing the numbering of the pages that remain.
    .filter((page) => page.text.length > 0);

  const text = cleanText(cleanedPages.map((page) => page.text).join('\n\n'));
  assertHasText(text, 'application/pdf');

  return {
    text,
    pages: cleanedPages,
    characterCount: text.length,
    pageCount: totalPages,
  };
}

function extractFromPlainText(bytes: Uint8Array, mimeType: string): ExtractedDocument {
  const text = cleanText(new TextDecoder('utf-8').decode(bytes));
  assertHasText(text, mimeType);

  return {
    text,
    // No pages. The caller checks this rather than being handed a fabricated
    // page 1 that a citation would then display as if it were meaningful.
    pages: [],
    characterCount: text.length,
    pageCount: 0,
  };
}

/**
 * Extracts text from a supported file.
 *
 * Throws a ValidationError for an unsupported type, an unreadable file, or a
 * document with no extractable text. Never returns an empty string.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  mimeType: string,
): Promise<ExtractedDocument> {
  if (!isSupportedMimeType(mimeType)) {
    throw new ValidationError(
      `Unsupported document type. Supported: ${SUPPORTED_MIME_TYPES.join(', ')}`,
      { operation: 'rag.extract', mimeType },
      // The list of supported types is published in the README and printed by
      // the script. Repeating it here costs nothing and saves a lookup.
      `Unsupported document type. Supported: ${SUPPORTED_MIME_TYPES.join(', ')}.`,
    );
  }

  if (bytes.byteLength === 0) {
    throw new ValidationError(
      'The document is empty',
      { operation: 'rag.extract', mimeType },
      'The document is empty.',
    );
  }

  return mimeType === 'application/pdf'
    ? extractFromPdf(bytes)
    : extractFromPlainText(bytes, mimeType);
}
