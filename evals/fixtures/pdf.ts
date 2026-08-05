/**
 * A PDF writer, so the fixtures can stay as text.
 *
 * The pipeline's entry point takes a file path and reads it with pdfjs, which means an
 * end-to-end test needs real PDF bytes. Committing binary fixtures would make them
 * unreviewable and undiffable, so instead this builds a minimal, uncompressed, one
 * text-run-per-line PDF from a fixture's pages at test time. Nothing here is product
 * code; it exists only so the eval suite can exercise the real reader.
 */

/** WinAnsi byte for the handful of non-Latin-1 characters the fixtures use. */
const WINANSI: Record<string, number> = {
  '\u2018': 0x91,
  '\u2019': 0x92,
  '\u201c': 0x93,
  '\u201d': 0x94,
  '\u2013': 0x96,
  '\u2014': 0x97,
  '\ufb01': 0x66, // no ligature glyph in the base fonts; "fi" is the honest round trip
  '\ufb02': 0x66,
  '\u200b': -1,
  '\ufeff': -1,
};

function encodeLatin1(line: string): number[] {
  const out: number[] = [];
  for (const ch of line) {
    const mapped = WINANSI[ch];
    if (mapped !== undefined) {
      if (mapped >= 0) out.push(mapped);
      continue;
    }
    const code = ch.codePointAt(0) ?? 63;
    out.push(code <= 0xff ? code : 63);
  }
  return out;
}

/** PDF string literal escaping, applied to already-encoded bytes. */
function pdfStringBytes(line: string): number[] {
  const out: number[] = [];
  for (const b of encodeLatin1(line)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return out;
}

const LINES_PER_PAGE = 62;

/** Hard-wrap so long clauses do not run off the page and vanish from the text layer. */
function wrap(line: string, width = 105): string[] {
  if (line.length <= width) return [line];
  const words = line.split(' ');
  const out: string[] = [];
  let current = '';
  for (const w of words) {
    if (current === '') current = w;
    else if (`${current} ${w}`.length <= width) current = `${current} ${w}`;
    else {
      out.push(current);
      current = w;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

function contentStream(lines: string[]): number[] {
  const bytes: number[] = [];
  const push = (s: string) => {
    for (const b of encodeLatin1(s)) bytes.push(b);
  };
  push('BT\n/F1 9 Tf\n11 TL\n36 756 Td\n');
  for (const line of lines) {
    push('(');
    for (const b of pdfStringBytes(line)) bytes.push(b);
    push(') Tj\nT*\n');
  }
  push('ET\n');
  return bytes;
}

/**
 * One PDF page per fixture page. Text-only, no compression, so a failure is
 * inspectable with `strings`.
 */
export function makePdf(pages: string[]): Uint8Array {
  const bodies = pages.map((page) => {
    const lines = page.split('\n').flatMap((l) => wrap(l));
    return lines.slice(0, LINES_PER_PAGE);
  });

  const objects: number[][] = [];
  const pageCount = bodies.length;
  const firstPageObj = 4;
  const pageIds = bodies.map((_b, i) => firstPageObj + i * 2);

  const enc = (s: string): number[] => encodeLatin1(s);

  objects.push(enc('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(
    enc(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`),
  );
  objects.push(
    enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  );

  bodies.forEach((lines, i) => {
    const contentId = pageIds[i] === undefined ? 0 : (pageIds[i] ?? 0) + 1;
    objects.push(
      enc(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    const stream = contentStream(lines);
    const head = enc(`<< /Length ${stream.length} >>\nstream\n`);
    const tail = enc('\nendstream');
    objects.push([...head, ...stream, ...tail]);
  });

  const out: number[] = [];
  const offsets: number[] = [];
  const write = (s: string) => {
    for (const b of encodeLatin1(s)) out.push(b);
  };

  write('%PDF-1.4\n');
  objects.forEach((body, i) => {
    offsets.push(out.length);
    write(`${i + 1} 0 obj\n`);
    for (const b of body) out.push(b);
    write('\nendobj\n');
  });

  const xrefAt = out.length;
  write(`xref\n0 ${objects.length + 1}\n`);
  write('0000000000 65535 f \n');
  for (const off of offsets) write(`${String(off).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return new Uint8Array(out);
}
