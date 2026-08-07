import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * An app launched from the Dock or by a LaunchAgent does not inherit her shell's
 * PATH, which is why "installed, but this app cannot run it" is documented as the
 * failure that actually happens. The installer knows exactly where it put the
 * binary, so it writes the path down and the probe reads it instead of searching.
 *
 * The rule this file pins: a recorded path is trusted only while it still runs. A
 * stale one is discarded and the four discovery probes still follow, so an install
 * that moved degrades to the old behaviour rather than to a dead engine.
 */
describe('recordedClaudePath', () => {
  let dir: string;
  const original = process.env['IBC_DATA_DIR'];

  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), 'ibc-claude-'));
    process.env['IBC_DATA_DIR'] = dir;
  });

  afterEach(() => {
    if (original === undefined) delete process.env['IBC_DATA_DIR'];
    else process.env['IBC_DATA_DIR'] = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it('is null when the installer never wrote one', async () => {
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBeNull();
  });

  it('is null when the recorded path no longer exists', async () => {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'claude-path'), '/nowhere/claude\n');
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBeNull();
  });

  it('is null when the recorded path exists but is not executable', async () => {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const bin = join(dir, 'claude');
    writeFileSync(bin, 'not executable');
    chmodSync(bin, 0o644);
    writeFileSync(join(dir, 'runtime', 'claude-path'), `${bin}\n`);
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBeNull();
  });

  it('is null when the file is empty', async () => {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'claude-path'), '\n');
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBeNull();
  });

  it('returns the trimmed path when it is executable', async () => {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, 'runtime', 'claude-path'), `  ${bin}  \n`);
    const { recordedClaudePath } = await import('@/lib/paths');
    expect(recordedClaudePath()).toBe(bin);
  });
});
