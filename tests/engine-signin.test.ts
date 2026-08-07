import { describe, expect, it } from 'vitest';

import { shellQuote } from '@/app/api/engine/signin/route';

/*
 * The sign-in command is assembled into a shell script and handed to Terminal, so
 * the quoting is the part that has to be right. The binary path is not a constant:
 * it comes from the installer's recorded path or from a probe, and on a Mac it can
 * easily contain a space -- "/Users/x/Library/Application Support/..." is the
 * shape the rest of this product is full of.
 *
 * An unquoted path with a space does not fail loudly. It runs the wrong command,
 * or a fragment of one, in a Terminal window she is watching.
 */
describe('shellQuote', () => {
  it('wraps a plain path', () => {
    expect(shellQuote('/usr/local/bin/claude')).toBe(`'/usr/local/bin/claude'`);
  });

  it('keeps a path containing spaces in one piece', () => {
    expect(shellQuote('/Applications/IBC Contracts.app/claude')).toBe(
      `'/Applications/IBC Contracts.app/claude'`,
    );
  });

  it('neutralises an embedded single quote rather than ending the string', () => {
    // The one input that could otherwise close the quote and let the rest of the
    // string be read as further commands.
    expect(shellQuote(`/tmp/o'brien/claude`)).toBe(`'/tmp/o'\\''brien/claude'`);
  });

  it.each([';rm -rf /', '&& curl evil.sh', '$(whoami)', '`id`', '|sh'])(
    'leaves %j inert inside single quotes',
    (nasty) => {
      const quoted = shellQuote(`/bin/claude${nasty}`);
      expect(quoted.startsWith(`'`)).toBe(true);
      expect(quoted.endsWith(`'`)).toBe(true);
      // Nothing between the outer quotes may terminate them.
      expect(quoted.slice(1, -1)).not.toContain(`'`);
    },
  );
});
