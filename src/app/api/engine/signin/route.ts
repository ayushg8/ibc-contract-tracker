/**
 * Start the Claude Code sign-in, and return immediately.
 *
 * The login is an interactive prompt plus a browser round-trip. Nothing here can
 * complete it, and nothing here waits for it: the request returns as soon as the
 * window is open, and Recheck -- which now reads `claude auth status` rather than
 * spending a request -- is what confirms the result. A route that blocked on the
 * OAuth flow would hold a connection for as long as she took to find her password.
 *
 * This is a permanent affordance, not an onboarding step. Tokens expire and people
 * sign out, so it is reachable from the wizard, Settings -> Engine and Diagnostics
 * alike.
 */

import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { NextResponse } from 'next/server';

import { resolveClaudeBinary } from '@/lib/providers/cli';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * An email only pre-fills a field on the login page, but it still reaches a
 * command line -- so anything that is not plainly an address is dropped rather
 * than passed along.
 */
function safeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(trimmed) ? trimmed : null;
}

/** Single-quote one argv element for /bin/sh. A path may contain spaces. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export async function POST(request: Request): Promise<NextResponse> {
  const bin = await resolveClaudeBinary();
  if (bin === null) {
    return NextResponse.json(
      {
        started: false,
        reason: 'Claude Code is not installed on this Mac, so there is nothing to sign in to.',
      },
      { status: 409 },
    );
  }

  let email: string | null = null;
  try {
    const body: unknown = await request.json();
    if (body !== null && typeof body === 'object' && 'email' in body) {
      email = safeEmail((body as { email: unknown }).email);
    }
  } catch {
    // No body is the normal case.
  }

  const argv = [bin, 'auth', 'login', '--claudeai'];
  if (email !== null) argv.push('--email', email);

  /*
   * Terminal, rather than a bare child process. `auth login` draws a prompt and
   * expects a keyboard; spawned headless it would sit on a pipe nobody is attached
   * to, present as a hang, and leave her no way to answer it.
   *
   * `open -a Terminal` runs a file rather than a string, so the command is written
   * to a .command first. Every argument is quoted, so a path containing a space --
   * "Application Support" is one -- cannot break the line apart.
   */
  const script = join(tmpdir(), `ibc-claude-signin-${process.pid}.command`);
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'echo "Signing in to Claude for the IBC Contract Tracker."',
      'echo "Finish the login in your browser, then go back to the tracker"',
      'echo "and press Recheck. You can close this window afterwards."',
      'echo',
      argv.map(shellQuote).join(' '),
      'echo',
      'echo "Done. Go back to the tracker and press Recheck."',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);

  spawn('/usr/bin/open', ['-a', 'Terminal', script], {
    stdio: 'ignore',
    detached: true,
  }).unref();

  return NextResponse.json({ started: true });
}
