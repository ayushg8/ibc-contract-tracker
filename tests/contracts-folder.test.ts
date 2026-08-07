import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  contractsRoot,
  defaultContractsRoot,
  folderNameFor,
  isInside,
  safeFolder,
  textFileHeader,
  uniqueFolder,
} from '@/lib/contracts-folder';
import { archiveDir } from '@/lib/paths';

describe('contractsRoot', () => {
  /*
   * The setting was offered, validated, health-checked and reported in the support
   * bundle, and then ignored: ingest wrote to a hardcoded path. Moving the folder
   * did nothing, silently. This is the test that says it does something.
   */
  it('honours the archiveFolder setting', () => {
    expect(contractsRoot({ archiveFolder: '/Users/b/Documents/IBC Contracts' })).toBe(
      '/Users/b/Documents/IBC Contracts',
    );
  });

  it.each([null, undefined, '', '   '])('falls back to the data dir for %j', (v) => {
    expect(contractsRoot({ archiveFolder: v })).toBe(archiveDir());
  });

  it('falls back when there are no settings at all', () => {
    expect(contractsRoot(null)).toBe(archiveDir());
  });
});

describe('defaultContractsRoot', () => {
  it('suggests Documents, where she can actually find it', () => {
    // Not Application Support. A folder she cannot find is a folder that does
    // not exist, and the whole point of this feature is Finder.
    expect(defaultContractsRoot('/Users/bonnie')).toBe('/Users/bonnie/Documents/IBC Contracts');
  });
});

describe('folderNameFor', () => {
  it('uses the counterparty and the effective date when both are known', () => {
    expect(
      folderNameFor({
        counterparty: 'Helios Anode Systems, Inc.',
        effectiveDate: '2024-02-29',
        filename: 'scan001.pdf',
      }),
    ).toBe('Helios Anode Systems, Inc. - 2024-02-29');
  });

  it('uses the counterparty alone when the date is unknown', () => {
    expect(
      folderNameFor({ counterparty: 'Acme Cells GmbH', effectiveDate: null, filename: 'a.pdf' }),
    ).toBe('Acme Cells GmbH');
  });

  it.each(['not-a-date', '2024', '29/02/2024', ''])(
    'ignores %j, which is not a date it can trust',
    (d) => {
      expect(folderNameFor({ counterparty: 'Acme', effectiveDate: d, filename: 'a.pdf' })).toBe(
        'Acme',
      );
    },
  );

  it('falls back to the filename before the document has been read', () => {
    // A queued document has no counterparty yet. Naming its folder "Unknown"
    // would be worse than naming it after the file she dropped in.
    expect(
      folderNameFor({ counterparty: null, effectiveDate: null, filename: 'Helios_NDA.pdf' }),
    ).toBe('Helios_NDA');
  });

  it('drops the .pdf extension only at the end, and case-insensitively', () => {
    expect(folderNameFor({ counterparty: null, effectiveDate: null, filename: 'a.PDF' })).toBe('a');
    expect(
      folderNameFor({ counterparty: null, effectiveDate: null, filename: 'a.pdf.backup.pdf' }),
    ).toBe('a.pdf.backup');
  });

  it('treats whitespace-only values as absent', () => {
    expect(
      folderNameFor({ counterparty: '   ', effectiveDate: '  ', filename: 'x.pdf' }),
    ).toBe('x');
  });
});

describe('safeFolder', () => {
  it.each([
    ['a/b', 'a_b'],
    ['a\\b', 'a_b'],
    ['a:b', 'a_b'],
    ['a*b?', 'a_b_'],
  ])('replaces the separator in %j', (input, expected) => {
    expect(safeFolder(input)).toBe(expected);
  });

  /*
   * The two names that are not obviously dangerous. A folder called ".." would be
   * created one level up from the root, outside the tree the reveal route checks
   * against, and every later path built from it would point somewhere else.
   */
  it.each(['.', '..', '...', '', '   '])('refuses to build a folder called %j', (name) => {
    expect(safeFolder(name)).toBe('Contract');
  });

  it('strips a leading dot, which Finder hides', () => {
    expect(safeFolder('.hidden')).toBe('hidden');
  });

  it('strips trailing dots and spaces', () => {
    expect(safeFolder('Acme Corp. ')).toBe('Acme Corp');
  });

  it('keeps an interior dot, which is a normal part of a company name', () => {
    expect(safeFolder('Acme Inc. v2')).toBe('Acme Inc. v2');
  });
});

describe('uniqueFolder', () => {
  it('takes the plain name when nothing is there', () => {
    expect(uniqueFolder('/root', 'Acme', () => false)).toBe('Acme');
  });

  it('numbers the second one rather than overwriting the first', () => {
    // An amended agreement looks exactly like a duplicate: same counterparty,
    // same date. Overwriting would destroy a signed contract.
    const taken = new Set(['/root/Acme']);
    expect(uniqueFolder('/root', 'Acme', (p) => taken.has(p))).toBe('Acme (2)');
  });

  it('keeps counting past the second', () => {
    const taken = new Set(['/root/Acme', '/root/Acme (2)', '/root/Acme (3)']);
    expect(uniqueFolder('/root', 'Acme', (p) => taken.has(p))).toBe('Acme (4)');
  });
});

describe('isInside', () => {
  const root = '/Users/b/Documents/IBC Contracts';

  it('accepts the root itself', () => {
    expect(isInside(root, root)).toBe(true);
  });

  it('accepts a folder within it', () => {
    expect(isInside(root, path.join(root, 'Acme', 'a.pdf'))).toBe(true);
  });

  /*
   * The server listens on localhost with no authentication, so anything that
   * turns a caller-supplied path into an `open` is a way to read the disk. These
   * are the shapes that get past a naive startsWith.
   */
  it('rejects a sibling that merely shares a prefix', () => {
    expect(isInside(root, '/Users/b/Documents/IBC Contracts Evil/x.pdf')).toBe(false);
  });

  it('rejects a traversal back out of the root', () => {
    expect(isInside(root, path.join(root, '..', '..', '.ssh', 'id_rsa'))).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isInside(root, '/etc/passwd')).toBe(false);
  });
});

describe('textFileHeader', () => {
  it('says plainly that this is not the contract', () => {
    const h = textFileHeader({
      filename: 'a.pdf',
      textSource: 'pdf',
      ocrConfidence: null,
      pagesReadRanges: null,
    });
    expect(h).toContain('NOT the contract itself');
    expect(h).toContain("the PDF's own text layer");
  });

  it('discloses OCR, and its confidence', () => {
    // The disclosure the citation guard cannot make for itself: a digit OCR gets
    // wrong appears identically in the quote and in the text it is checked
    // against, so it verifies. Saying so is the only honest answer.
    const h = textFileHeader({
      filename: 'scan.pdf',
      textSource: 'ocr',
      ocrConfidence: 0.912,
      pagesReadRanges: '1-4',
    });
    expect(h).toContain('optical character recognition');
    expect(h).toContain('91.2%');
    expect(h).toContain('Pages read: 1-4');
  });

  it('says that nothing was checked when the pages went as images', () => {
    const h = textFileHeader({
      filename: 'scan.pdf',
      textSource: 'vision',
      ocrConfidence: null,
      pagesReadRanges: null,
    });
    expect(h).toContain('Nothing here was checked');
  });
});
