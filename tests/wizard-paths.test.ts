/**
 * Two promises the setup screens make, pinned.
 *
 * 1. There is no folder picker and there cannot be one -- a page is handed the
 *    bytes of a file, never its location -- so a typed path has to survive every
 *    form Finder and Terminal hand her.
 * 2. CLI_NOT_FOUND means two different things, and the Test step used to answer
 *    both with "install Claude Code" one step after the Engine step had told her
 *    Claude Code is installed.
 */

import { describe, expect, it } from 'vitest';

import {
  CLI_CASES,
  cliCaseInfoFor,
  describeCli,
  folderPathFromDrop,
  normalizeFolderPath,
} from '../src/lib/engine-diagnosis';

function drop(data: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

describe('a folder path typed, pasted or dropped', () => {
  it('leaves a plain path exactly as it is', () => {
    expect(normalizeFolderPath('/Users/bonnie/IBC/NDAs')).toBe('/Users/bonnie/IBC/NDAs');
  });

  it('takes the path out of a file:// URL, percent-encoding and all', () => {
    expect(normalizeFolderPath('file:///Users/bonnie/IBC/Signed%20NDAs')).toBe(
      '/Users/bonnie/IBC/Signed NDAs',
    );
  });

  it('unescapes a path dragged into Terminal', () => {
    expect(normalizeFolderPath('/Users/bonnie/Signed\\ NDAs')).toBe('/Users/bonnie/Signed NDAs');
  });

  it('drops the quotes a shell paste brings with it', () => {
    expect(normalizeFolderPath('"/Users/bonnie/IBC/NDAs"')).toBe('/Users/bonnie/IBC/NDAs');
  });

  it('strips the trailing slash so one folder cannot be stored two ways', () => {
    expect(normalizeFolderPath('/Users/bonnie/IBC/NDAs/')).toBe('/Users/bonnie/IBC/NDAs');
    // Root is a path, not a separator to trim away to nothing.
    expect(normalizeFolderPath('/')).toBe('/');
  });

  it('survives a stray percent that is not an escape', () => {
    expect(normalizeFolderPath('file:///Users/bonnie/100%')).toBe('/Users/bonnie/100%');
  });

  it('reads a path out of a drop that carried one', () => {
    expect(folderPathFromDrop(drop({ 'text/uri-list': 'file:///Users/bonnie/NDAs' }))).toBe(
      '/Users/bonnie/NDAs',
    );
    expect(folderPathFromDrop(drop({ 'text/plain': '/Users/bonnie/NDAs' }))).toBe(
      '/Users/bonnie/NDAs',
    );
  });

  it('skips the comment lines a uri-list is allowed to carry', () => {
    expect(
      folderPathFromDrop(drop({ 'text/uri-list': '# comment\r\nfile:///Users/bonnie/NDAs' })),
    ).toBe('/Users/bonnie/NDAs');
  });

  it('says null rather than guessing when the drop carried no location', () => {
    // The usual case: Chrome hands over the file, not where it lives. The UI has
    // to answer this with the Finder instruction, never with a broken value.
    expect(folderPathFromDrop(drop({}))).toBeNull();
    expect(folderPathFromDrop(drop({ 'text/plain': 'NDAs' }))).toBeNull();
  });
});

describe('which sentence a failed test run gets', () => {
  it('prefers the live verdict over the code when they name the same failure', () => {
    const verdict = describeCli('not-on-path', { binPath: '/opt/homebrew/bin/claude' });
    const info = cliCaseInfoFor('CLI_NOT_FOUND', verdict);

    // The regression: the code alone maps to 'not-installed', which tells her to
    // install software the previous step just told her she has.
    expect(info?.title).toBe(CLI_CASES['not-on-path'].title);
    expect(info?.title).not.toBe(CLI_CASES['not-installed'].title);
    expect(info?.command).toBe(CLI_CASES['not-on-path'].command);
  });

  it('falls back to the code when there is no verdict to prefer', () => {
    expect(cliCaseInfoFor('CLI_NOT_FOUND', null)).toEqual(CLI_CASES['not-installed']);
  });

  it('ignores a verdict about some other failure', () => {
    const verdict = describeCli('usage-limit');
    expect(cliCaseInfoFor('CLI_NOT_FOUND', verdict)).toEqual(CLI_CASES['not-installed']);
  });

  it('has nothing to say about a failure that is not a Claude Code setup fault', () => {
    expect(cliCaseInfoFor('SCHEMA_INVALID', null)).toBeNull();
    expect(cliCaseInfoFor(undefined, null)).toBeNull();
  });
});
