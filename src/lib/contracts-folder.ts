/**
 * Where a contract lives on disk, and what sits next to it.
 *
 * The archive used to be one flat folder of `<uuid>-<name>.pdf` inside Application
 * Support: correct, addressable, and completely unusable by a human being with a
 * Finder window. This gives every document a folder of its own, named the way she
 * would name it, holding the original bytes and the two things you would otherwise
 * have to open the app to see.
 *
 *   <contracts root>/
 *     Helios Anode Systems, Inc. - 2024-02-29/
 *       Helios_Anode_NDA.pdf        the original, byte for byte
 *       What the reader saw.txt     the text the model was actually given
 *       Record.txt                  the sixteen fields and both expiry clocks
 *
 * Server-only: reads settings and touches the filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';

import { archiveDir, safeFilename } from '@/lib/paths';

/**
 * The folder holding every contract folder.
 *
 * This reads the `archiveFolder` setting, which until now was a lie: the settings
 * screen offered it, the route validated it, health checked it and the support
 * bundle reported it, and then ingest wrote to a hardcoded path regardless. Moving
 * it did nothing at all.
 */
export function contractsRoot(settings: { archiveFolder?: string | null } | null): string {
  const chosen = settings?.archiveFolder;
  if (typeof chosen === 'string' && chosen.trim() !== '') return path.resolve(chosen.trim());
  return archiveDir();
}

/** Where a brand-new install should suggest keeping contracts. */
export function defaultContractsRoot(home: string): string {
  // Documents, not Application Support. She is expected to open this in Finder,
  // and a folder she cannot find is a folder that does not exist.
  return path.join(home, 'Documents', 'IBC Contracts');
}

/**
 * A folder name a person would have chosen, and that a filesystem will accept.
 *
 * Falls back down a ladder rather than inventing anything: counterparty and date,
 * then counterparty, then the original filename. A document that has not been read
 * yet has no counterparty, and naming its folder "Unknown" would be worse than
 * naming it after the file she dropped in.
 */
export function folderNameFor(input: {
  counterparty?: string | null;
  effectiveDate?: string | null;
  filename: string;
}): string {
  const party = clean(input.counterparty);
  const date = isIsoDate(input.effectiveDate) ? input.effectiveDate : null;

  if (party !== null && date !== null) return safeFolder(`${party} - ${date}`);
  if (party !== null) return safeFolder(party);
  return safeFolder(stripPdf(input.filename));
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function isIsoDate(v: string | null | undefined): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function stripPdf(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/**
 * Filesystem-safe, and safe against the two names that are not obviously
 * dangerous: `.` and `..`, which would place the folder somewhere else entirely.
 * A leading dot is stripped for the duller reason that Finder hides those.
 */
export function safeFolder(name: string): string {
  // Deliberately NOT safeFilename(): its fallback is "document.pdf", which is a
  // sensible name for a file and an absurd one for a folder. Borrowing it would
  // have created a folder called document.pdf for any name that cleaned to empty.
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[.\s]+$/, '') // trailing dots are Windows-hostile and invisible
    .replace(/^\.+/, '') // a leading dot hides the folder in Finder
    .trim();
  if (cleaned === '') return 'Contract';
  return cleaned;
}

/**
 * The first name in the series that is not already taken.
 *
 * Two NDAs with the same counterparty and the same date are not a mistake -- an
 * amended agreement looks exactly like that -- so the second one gets `(2)` rather
 * than being refused or silently overwriting the first.
 */
export function uniqueFolder(root: string, desired: string, exists = defaultExists): string {
  if (!exists(path.join(root, desired))) return desired;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${desired} (${n})`;
    if (!exists(path.join(root, candidate))) return candidate;
  }
  // A thousand collisions is not a naming problem any more.
  return `${desired} (${Date.now()})`;
}

function defaultExists(p: string): boolean {
  return fs.existsSync(p);
}

/**
 * True when `child` is inside `root`.
 *
 * Every path that reaches Finder goes through this. The server listens on
 * localhost with no authentication, so a route that reveals whatever path it is
 * handed is a route that reveals anything on the disk; the answer is that callers
 * name a document and never a path, and that whatever comes back is checked
 * against the root before it is opened.
 */
export function isInside(root: string, child: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(child);
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Human-readable name of the text file kept beside the original. */
export const TEXT_FILENAME = 'What the reader saw.txt';
/** Human-readable name of the record summary kept beside the original. */
export const RECORD_FILENAME = 'Record.txt';

/**
 * The header on the text file, which has to say where the text came from.
 *
 * A reviewer is entitled to know that a quote was checked against OCR output
 * rather than against an embedded text layer, because OCR can transcribe a date
 * wrong and still "verify" -- the guard cannot catch that, so the disclosure is
 * the honest answer. The same sentence already appears on the record inside the
 * app; this puts it on the file someone might read instead.
 */
export function textFileHeader(input: {
  filename: string;
  textSource: string | null;
  ocrConfidence: number | null;
  pagesReadRanges: string | null;
}): string {
  const lines = [
    `Text read from: ${input.filename}`,
    '',
    'This is what the model was actually given. It is NOT the contract itself --',
    `the original is in this folder, and it is the only authoritative copy.`,
    '',
  ];
  switch (input.textSource) {
    case 'ocr':
      lines.push(
        'Source: OCR. This PDF had no text layer, so the pages were read by',
        'optical character recognition on this Mac. A character OCR gets wrong',
        'appears the same way here as in the quote checked against it, so any',
        'value taken from this text deserves a second look at the original.',
      );
      if (input.ocrConfidence !== null) {
        lines.push(`OCR confidence: ${(input.ocrConfidence * 100).toFixed(1)}%`);
      }
      break;
    case 'vision':
      lines.push(
        'Source: page images. Nothing here was checked against the document,',
        'because there was no text to check against.',
      );
      break;
    default:
      lines.push("Source: the PDF's own text layer.");
  }
  if (input.pagesReadRanges !== null && input.pagesReadRanges.trim() !== '') {
    lines.push('', `Pages read: ${input.pagesReadRanges}`);
  }
  lines.push('', '-'.repeat(60), '');
  return lines.join('\n');
}
