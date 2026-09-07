import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/server/observability/errors';
import {
  extractDocumentText,
  isSupportedMimeType,
  mimeTypeFromFilename,
  SUPPORTED_MIME_TYPES,
} from '@/server/rag/extract-text';
import { makePdf, makeScannedPdf } from '../fixtures/make-pdf';

/**
 * Text extraction.
 *
 * These run against real PDFs, built byte by byte in `fixtures/make-pdf.ts` and
 * parsed by the same pdf.js that runs in production. A stubbed parser would
 * only confirm that our code calls a function.
 *
 * The test that matters most is the scanned one. A scanned PDF opens fine, has
 * the right number of pages, and contains no text whatsoever. If that passes
 * silently you get a document marked `ready` with zero chunks, and months later
 * a chat feature that says "I could not find that in your documents" about a
 * file sitting right there in the list. Nothing in the logs would say why.
 */

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

describe('mime type detection', () => {
  it.each([
    ['handbook.pdf', 'application/pdf'],
    ['HANDBOOK.PDF', 'application/pdf'],
    ['notes.md', 'text/markdown'],
    ['notes.markdown', 'text/markdown'],
    ['notes.txt', 'text/plain'],
  ])('maps %s to %s', (filename, expected) => {
    expect(mimeTypeFromFilename(filename)).toBe(expected);
  });

  it('returns null for a type we cannot extract yet', () => {
    // Returning null rather than guessing. A .docx renamed to .pdf would
    // otherwise reach the PDF parser and fail with a confusing message.
    expect(mimeTypeFromFilename('report.docx')).toBeNull();
    expect(mimeTypeFromFilename('archive.zip')).toBeNull();
    expect(mimeTypeFromFilename('noextension')).toBeNull();
  });

  it('recognises exactly the types the pipeline supports', () => {
    expect(SUPPORTED_MIME_TYPES).toEqual(['application/pdf', 'text/plain', 'text/markdown']);
    expect(isSupportedMimeType('application/pdf')).toBe(true);
    expect(isSupportedMimeType('image/png')).toBe(false);
  });
});

describe('extracting a text PDF', () => {
  it('returns the text of a single page document', async () => {
    const pdf = makePdf([{ lines: ['Search intent decides which page ranks.'] }]);

    const result = await extractDocumentText(pdf, 'application/pdf');

    expect(result.text).toContain('Search intent decides which page ranks.');
    expect(result.characterCount).toBe(result.text.length);
    expect(result.pageCount).toBe(1);
  });

  it('keeps pages separate, with 1-based numbers', async () => {
    /**
     * Pages are kept apart so a citation can name one. Merging them into a
     * single string here would make page numbers unrecoverable later, and a
     * citation that cannot name a page is a citation nobody can check.
     */
    const pdf = makePdf([
      { lines: ['Page one covers technical SEO.'] },
      { lines: ['Page two covers answer engine optimisation.'] },
      { lines: ['Page three covers inbound and outbound.'] },
    ]);

    const result = await extractDocumentText(pdf, 'application/pdf');

    expect(result.pageCount).toBe(3);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages[1]?.text).toContain('answer engine optimisation');
  });

  it('joins every page into the text that gets chunked', async () => {
    const pdf = makePdf([
      { lines: ['First page content.'] },
      { lines: ['Second page content.'] },
    ]);

    const result = await extractDocumentText(pdf, 'application/pdf');

    expect(result.text).toContain('First page content.');
    expect(result.text).toContain('Second page content.');
  });

  it('can read the same bytes twice', async () => {
    /**
     * pdf.js takes ownership of the array it is handed and detaches the
     * underlying buffer. Without the defensive copy in `extractFromPdf`, a
     * second read of the same bytes throws `DataCloneError`, with nothing in
     * the message hinting that a buffer was consumed. The retry path in any
     * future upload handler would hit exactly this.
     */
    const pdf = makePdf([{ lines: ['Repeatable extraction.'] }]);

    const first = await extractDocumentText(pdf, 'application/pdf');
    const second = await extractDocumentText(pdf, 'application/pdf');

    expect(second.text).toBe(first.text);
  });
});

describe('documents with nothing to search', () => {
  it('rejects a scanned PDF: real pages, no text layer', async () => {
    const scanned = makeScannedPdf(3);

    // Reads as a perfectly valid PDF. That is the whole problem with it.
    await expect(extractDocumentText(scanned, 'application/pdf')).rejects.toThrow(ValidationError);
  });

  it('names the format in the failure so the cause is obvious', async () => {
    await expect(extractDocumentText(makeScannedPdf(1), 'application/pdf')).rejects.toThrow(
      /no extractable text/i,
    );
  });

  it('tells the operator it is a scan, not just that something was invalid', async () => {
    /**
     * The reason `ValidationError` takes an optional safeMessage.
     *
     * "The request was not valid." is the right default when the specific
     * reason would tell an attacker something. This reason tells nobody
     * anything except a fact about the file they just supplied, and it is the
     * difference between fixing the problem in a minute and reading logs to
     * find out that a PDF was scanned.
     */
    const error = await extractDocumentText(makeScannedPdf(2), 'application/pdf').catch(
      (caught: unknown) => caught,
    );

    expect((error as ValidationError).safeMessage).toMatch(/scanned/i);
    expect((error as ValidationError).safeMessage).toMatch(/OCR is not supported yet/);
    // Still says nothing about how extraction works or what was tried.
    expect((error as ValidationError).safeMessage).not.toMatch(/pdf\.js|unpdf|cleanText/i);
  });

  it('rejects an empty file before it reaches a parser', async () => {
    await expect(extractDocumentText(new Uint8Array(0), 'application/pdf')).rejects.toThrow(
      /empty/i,
    );
  });

  it('rejects a text file containing only whitespace', async () => {
    // Cleaning runs first, so a file of newlines and non-breaking spaces is
    // caught the same way a genuinely empty one is.
    await expect(extractDocumentText(bytes('   \n\n \t  '), 'text/plain')).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('unreadable input', () => {
  it('rejects bytes that are not a PDF at all', async () => {
    await expect(
      extractDocumentText(bytes('this is plainly not a pdf'), 'application/pdf'),
    ).rejects.toThrow(ValidationError);
  });

  it('does not leak the parser own message to the user', async () => {
    /**
     * pdf.js messages can carry file paths and fragments of document content,
     * so none of it is passed through. The replacement says what to do about
     * the file without repeating anything the parser said about it.
     */
    const error = await extractDocumentText(bytes('%PDF-1.4 truncated'), 'application/pdf').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).safeMessage).toBe(
      'The PDF could not be read. It may be corrupt, or protected with a password.',
    );
  });

  it('keeps the parser failure class for the logs, and nothing else from it', async () => {
    /**
     * The diagnostic half without the leaking half. `PasswordException` and
     * `InvalidPDFException` are three words apart and mean completely
     * different things to whoever is debugging; the message they come attached
     * to contains file paths and fragments of the document.
     */
    const error = (await extractDocumentText(bytes('%PDF-1.4 broken'), 'application/pdf').catch(
      (caught: unknown) => caught,
    )) as ValidationError;

    expect(typeof error.logMeta.parserError).toBe('string');
    expect(error.logMeta.parserError).not.toBe('');
    // A class name, not a sentence. Anything with spaces in it is a message
    // that got in here by mistake.
    expect(String(error.logMeta.parserError)).not.toMatch(/\s/);
  });

  it('refuses a type the pipeline does not handle', async () => {
    await expect(extractDocumentText(bytes('binary'), 'application/msword')).rejects.toThrow(
      /unsupported document type/i,
    );
  });
});

describe('plain text and Markdown', () => {
  it('decodes UTF-8, including characters outside ASCII', async () => {
    const result = await extractDocumentText(bytes('Café strategy — résumé'), 'text/plain');

    expect(result.text).toContain('Café');
    expect(result.text).toContain('résumé');
  });

  it('reports no pages, rather than inventing page 1', async () => {
    /**
     * A .md file has no pages. Returning `pages: []` is how the ingester knows
     * to store no page number at all. A fabricated "page 1" would surface in a
     * citation as if it meant something, which is worse than no page: it looks
     * checkable and is not.
     */
    const result = await extractDocumentText(bytes('# Heading\n\nBody text.'), 'text/markdown');

    expect(result.pages).toEqual([]);
    expect(result.pageCount).toBe(0);
  });

  it('applies the same cleaning the chunker expects', async () => {
    const result = await extractDocumentText(bytes('a\r\n\r\n\r\n\r\nb'), 'text/plain');

    expect(result.text).toBe('a\n\nb');
  });
});
