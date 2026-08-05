/**
 * Parsing a plist in a test, on a machine that may not be a Mac.
 *
 * WHY THIS FILE EXISTS
 *
 * Four separate tests shelled out to `plutil`, which ships only with macOS,
 * and the release workflow's `verify` job ran on ubuntu-latest -- so the gate
 * in front of every publish failed on the absence of a tool rather than on
 * anything wrong with the release.
 *
 * `verify` has since moved to macos-14, because eleven OTHER tests in this
 * suite genuinely need macOS: they run update.sh and install.command rather
 * than reading them. So plutil is present again on the path that matters, and
 * this file is no longer load-bearing for CI.
 *
 * It stays anyway, for two reasons. The suite should be runnable by anyone on
 * any machine, and python3's `plistlib` is STRICTER than plutil -- it
 * immediately caught a `--` inside an XML comment in LaunchAgent.plist.in
 * (illegal in XML, tolerated by plutil) that had sat there unnoticed.
 *
 * If neither parser exists these functions THROW. They must never skip: a green
 * run on a plist nobody parsed is worse than a red one, because a plist launchd
 * rejects is an app that never starts and no test said so.
 */

import { execFileSync } from 'node:child_process';

function have(tool: string): boolean {
  try {
    execFileSync('/usr/bin/env', ['sh', '-c', `command -v "$1" >/dev/null 2>&1`, 'sh', tool], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

const PLUTIL = have('plutil');
const PYTHON = have('python3');

function noParser(): never {
  throw new Error(
    'no plist parser on this machine: plutil (macOS) or python3 with plistlib is required',
  );
}

/** Throws if the file is not a plist. The assertion is the absence of a throw. */
export function lintPlist(file: string): void {
  if (PLUTIL) {
    execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });
    return;
  }
  if (PYTHON) {
    execFileSync(
      'python3',
      ['-c', 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))', file],
      { stdio: 'pipe' },
    );
    return;
  }
  noParser();
}

/** The plist as a plain object. Lints on the way through. */
export function readPlist(file: string): Record<string, unknown> {
  if (PLUTIL) {
    execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', file], {
      encoding: 'utf8',
    });
    return JSON.parse(json) as Record<string, unknown>;
  }
  if (PYTHON) {
    const json = execFileSync(
      'python3',
      [
        '-c',
        'import plistlib,json,sys; json.dump(plistlib.load(open(sys.argv[1],"rb")), sys.stdout)',
        file,
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(json) as Record<string, unknown>;
  }
  return noParser();
}

/**
 * A template's `@@TOKEN@@` holes filled with something of the right TYPE.
 *
 * Filling every hole with the word "placeholder" put a string inside
 * `<integer>`, which plutil shrugs at and a strict parser rejects -- so the
 * test's own substitution was the malformed part, and it took the stricter
 * parser to say so.
 */
export function fillPlistTemplate(body: string): string {
  return body
    .replace(/(<integer>)@@[A-Z_]+@@(<\/integer>)/g, '$11$2')
    .replace(/@@[A-Z_]+@@/g, 'placeholder');
}
