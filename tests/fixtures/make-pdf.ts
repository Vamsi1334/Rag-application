/**
 * Builds real PDF files in memory, for tests.
 *
 * ------------------------------------------------------------------
 * Why build them instead of committing them
 * ------------------------------------------------------------------
 * The extraction tests need a text PDF, a multi-page PDF and, most importantly,
 * a PDF with pages and no text at all. Committed binaries would make those
 * cases opaque: a reviewer sees `scanned.pdf` and has to take on faith that it
 * really has no text layer. Here the difference is one visible argument.
 *
 * These are genuine PDFs with a correct cross-reference table, not fragments
 * that happen to satisfy our own parser. pdf.js reads them the same way it
 * reads a file from Word or Acrobat, which is the point: a fixture the real
 * parser rejects would prove nothing about the real parser.
 *
 * Deliberately minimal. No compression, no font embedding, Helvetica only,
 * because everything beyond that is PDF machinery we are not testing.
 */

/** Characters PDF treats as syntax inside a string literal. */
function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * How many 20pt lines fit between y=720 and the bottom of a US Letter page.
 *
 * Beyond this the text is positioned off the page, and pdf.js drops it during
 * extraction. That is correct behaviour on its part and a trap here: a fixture
 * asking for 400 lines would silently yield about 36, and a test expecting a
 * long document would quietly assert against a short one. Hence the guard in
 * `makePdf`: overflow a page, add a page.
 */
const MAX_LINES_PER_PAGE = 36;

/** One page's content stream: lines of text down the page, or nothing at all. */
function contentStream(lines: string[]): string {
  if (lines.length === 0) {
    // A page object with an empty stream. Valid, renderable, and containing
    // zero extractable characters, which is what a scanned page looks like to
    // a text extractor.
    return '';
  }

  const body = lines
    .map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 20} Td (${escapePdfText(line)}) Tj ET`)
    .join('\n');

  return `${body}\n`;
}

export interface PdfPage {
  /** Lines of visible text. An empty array produces a page with no text layer. */
  lines: string[];
}

/**
 * Assembles a PDF from pages of plain text.
 *
 * The byte offsets in the cross-reference table have to be exact or pdf.js
 * refuses the file, so the document is built as a list of objects and the
 * offsets are measured as it is written, rather than guessed.
 */
export function makePdf(pages: PdfPage[]): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');

  const overflowing = pages.findIndex((page) => page.lines.length > MAX_LINES_PER_PAGE);
  if (overflowing !== -1) {
    throw new Error(
      `Page ${overflowing + 1} has ${pages[overflowing]!.lines.length} lines; ` +
        `only ${MAX_LINES_PER_PAGE} fit on a page and the rest would be dropped ` +
        `during extraction. Split it across more pages.`,
    );
  }

  const encoder = new TextEncoder();

  // Object numbering: 1 catalog, 2 page tree, 3 font, then per page a page
  // object and its content stream.
  const firstPageObject = 4;
  const pageObjectNumbers = pages.map((_, index) => firstPageObject + index * 2);

  const objects: string[] = [];

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] ` +
      `/Count ${pages.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (const [index, page] of pages.entries()) {
    const contentNumber = pageObjectNumbers[index]! + 1;
    const stream = contentStream(page.lines);

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    );
    // Length must count bytes, not characters, or the parser reads past the end
    // of the stream on any non-ASCII text.
    objects.push(
      `<< /Length ${encoder.encode(stream).byteLength} >>\nstream\n${stream}endstream`,
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (const [index, body] of objects.entries()) {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = encoder.encode(pdf).byteLength;

  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(pdf);
}

/** A PDF whose pages exist but carry no text, the way a scan does. */
export function makeScannedPdf(pageCount = 2): Uint8Array {
  return makePdf(Array.from({ length: pageCount }, () => ({ lines: [] })));
}
