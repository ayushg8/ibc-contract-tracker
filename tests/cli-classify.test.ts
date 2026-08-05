import { describe, expect, it } from 'vitest';
import {
  buildCliArgv,
  classifyCliOutput,
  compareVersions,
  parseCliVersion,
  parseFlagSupport,
  parseResetAt,
  unwrapCliEnvelope,
  type CliRunOutcome,
} from '../src/lib/providers/cli';

const ANSWER = JSON.stringify({
  doc_type: 'nda',
  fields: {
    party_a: {
      value: 'International Battery Company, Inc.',
      quote: 'International Battery Company, Inc.',
      page: 1,
    },
  },
});

function envelope(result: string, isError = false): string {
  return JSON.stringify({
    type: 'result',
    subtype: isError ? 'error' : 'success',
    is_error: isError,
    duration_ms: 5120,
    session_id: 'sess_1',
    result,
  });
}

function outcome(over: Partial<CliRunOutcome> = {}): CliRunOutcome {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    toolsDisabled: true,
    ...over,
  };
}

describe('classifyCliOutput - success', () => {
  it('reads the answer out of a json envelope', () => {
    const res = classifyCliOutput(outcome({ stdout: envelope(ANSWER) }));
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.json['doc_type']).toBe('nda');
  });

  it('reads bare output from an older build with no envelope', () => {
    const res = classifyCliOutput(outcome({ stdout: ANSWER }));
    expect(res.kind).toBe('ok');
  });

  it('reads an answer wrapped in a fence inside the envelope', () => {
    const res = classifyCliOutput(
      outcome({ stdout: envelope('Here it is:\n```json\n' + ANSWER + '\n```') }),
    );
    expect(res.kind).toBe('ok');
  });

  it('strips update notices and ANSI before parsing', () => {
    const noisy =
      'npm notice New major version of npm available!\n' +
      '\u001B[33mUpdate available: 2.9.0\u001B[0m\n' +
      envelope(ANSWER);
    expect(classifyCliOutput(outcome({ stdout: noisy })).kind).toBe('ok');
  });

  it('does not mistake contract language for a permission prompt', () => {
    // A confidentiality clause that contains every phrase our error patterns hunt for.
    const clause =
      'Recipient shall not permit any third party to use the Confidential Information. ' +
      'Do you want to allow disclosure? The parties agree the limit reached under this ' +
      'Section resets at 5pm. Not logged in users are excluded.';
    const answer = JSON.stringify({
      doc_type: 'nda',
      fields: { party_a: { value: 'IBC', quote: clause, page: 3 } },
    });
    const res = classifyCliOutput(outcome({ stdout: envelope(answer) }));
    expect(res.kind).toBe('ok');
  });

  it('accepts a usable answer even when the process exited non-zero', () => {
    const res = classifyCliOutput(outcome({ stdout: envelope(ANSWER), exitCode: 1 }));
    expect(res.kind).toBe('ok');
  });
});

describe('classifyCliOutput - failures', () => {
  it('CLI_TIMEOUT when it timed out with output in flight', () => {
    const res = classifyCliOutput(outcome({ timedOut: true, stdout: 'partial...' }));
    expect(res.kind === 'error' && res.code).toBe('CLI_TIMEOUT');
  });

  it('CLI_TIMEOUT on a silent hang when tools were provably disabled', () => {
    const res = classifyCliOutput(outcome({ timedOut: true, toolsDisabled: true }));
    expect(res.kind === 'error' && res.code).toBe('CLI_TIMEOUT');
  });

  it('CLI_PERMISSION_PROMPT on a silent hang when tools could not be disabled', () => {
    const res = classifyCliOutput(outcome({ timedOut: true, toolsDisabled: false }));
    expect(res.kind === 'error' && res.code).toBe('CLI_PERMISSION_PROMPT');
  });

  it('CLI_TIMEOUT when cancelled', () => {
    const res = classifyCliOutput(outcome({ aborted: true }));
    expect(res.kind === 'error' && res.code).toBe('CLI_TIMEOUT');
  });

  it('CLI_PERMISSION_PROMPT on an approval prompt in stdout', () => {
    const res = classifyCliOutput(
      outcome({
        stdout: 'Claude wants to use Bash\n\nDo you want to allow this?\n1) Yes\n2) No',
        exitCode: 1,
      }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_PERMISSION_PROMPT');
  });

  it('CLI_NOT_AUTHENTICATED when told to log in', () => {
    const res = classifyCliOutput(
      outcome({ stderr: 'Error: You are not logged in. Please run /login.', exitCode: 1 }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_NOT_AUTHENTICATED');
  });

  it('CLI_NOT_AUTHENTICATED on an expired session', () => {
    const res = classifyCliOutput(
      outcome({ stdout: envelope('Your session expired. Sign in to continue.', true), exitCode: 1 }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_NOT_AUTHENTICATED');
  });

  it('CLI_USAGE_LIMIT with a parsed reset time', () => {
    const now = Date.parse('2026-07-29T10:00:00.000Z');
    const res = classifyCliOutput(
      outcome({
        stdout: envelope('Claude AI usage limit reached. Your limit resets at 2026-07-29T14:30:00Z', true),
        exitCode: 1,
      }),
      now,
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_USAGE_LIMIT');
    if (res.kind === 'error') {
      expect(res.limitResetsAt).toBe('2026-07-29T14:30:00.000Z');
      expect(res.retryAfterMs).toBe(4.5 * 3_600_000);
    }
  });

  it('CLI_USAGE_LIMIT on the 5-hour window wording', () => {
    const res = classifyCliOutput(
      outcome({ stderr: 'You have reached your 5-hour limit. Try again later.', exitCode: 1 }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_USAGE_LIMIT');
  });

  it('CLI_USAGE_LIMIT on the weekly window wording', () => {
    const res = classifyCliOutput(
      outcome({ stderr: 'Weekly limit reached for Opus. Switch models or wait.', exitCode: 1 }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_USAGE_LIMIT');
  });

  it('prefers CLI_USAGE_LIMIT over auth when a limit message mentions upgrading', () => {
    const res = classifyCliOutput(
      outcome({
        stderr: 'Usage limit reached. Upgrade to a higher plan or sign in to another account.',
        exitCode: 1,
      }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_USAGE_LIMIT');
  });

  it('CLI_VERSION_UNSUPPORTED when a required flag is rejected', () => {
    const res = classifyCliOutput(
      outcome({ stderr: "error: unknown option '--allowed-tools'", exitCode: 1 }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_VERSION_UNSUPPORTED');
  });

  it('CLI_BAD_OUTPUT when it exits clean with nothing', () => {
    const res = classifyCliOutput(outcome({ stdout: '   \n' }));
    expect(res.kind === 'error' && res.code).toBe('CLI_BAD_OUTPUT');
  });

  it('CLI_BAD_OUTPUT when it exits clean with prose instead of JSON', () => {
    const res = classifyCliOutput(
      outcome({ stdout: envelope('I was unable to find those fields in the document.') }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_BAD_OUTPUT');
  });

  it('CLI_BAD_OUTPUT when the JSON is truncated', () => {
    const res = classifyCliOutput(outcome({ stdout: '{"fields": {"party_a": {"value": "Inter' }));
    expect(res.kind === 'error' && res.code).toBe('CLI_BAD_OUTPUT');
  });

  it('CLI_CRASHED on a non-zero exit with stderr, carrying redacted detail', () => {
    const res = classifyCliOutput(
      outcome({
        stderr: 'TypeError: cannot read property of undefined\n  at main (index.js:1)\nx-api-key: sk-ant-abcdefghijklmnop',
        exitCode: 7,
      }),
    );
    expect(res.kind === 'error' && res.code).toBe('CLI_CRASHED');
    if (res.kind === 'error') {
      expect(res.detail).toContain('exit 7');
      expect(res.detail).not.toContain('sk-ant-abcdefghijklmnop');
    }
  });

  it('CLI_CRASHED when killed by a signal', () => {
    const res = classifyCliOutput(outcome({ exitCode: null, signal: 'SIGKILL' }));
    expect(res.kind === 'error' && res.code).toBe('CLI_CRASHED');
  });
});

describe('unwrapCliEnvelope', () => {
  it('pulls the result field out', () => {
    expect(unwrapCliEnvelope(envelope('hello')).text).toBe('hello');
  });

  it('flags an error envelope', () => {
    const env = unwrapCliEnvelope(envelope('boom', true));
    expect(env.isError).toBe(true);
    expect(env.text).toBe('boom');
  });

  it('falls back to raw stdout when there is no envelope', () => {
    expect(unwrapCliEnvelope('just text').text).toBe('just text');
    expect(unwrapCliEnvelope('just text').raw).toBeNull();
  });

  it('takes the last result line of newline-delimited json', () => {
    const ndjson = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'assistant', message: 'thinking' }),
      envelope('final'),
    ].join('\n');
    expect(unwrapCliEnvelope(ndjson).text).toBe('final');
  });

  it('handles empty stdout', () => {
    expect(unwrapCliEnvelope('').text).toBe('');
  });
});

describe('parseResetAt', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');

  it('reads an ISO timestamp', () => {
    expect(parseResetAt('resets at 2026-07-29T15:00:00Z', now)?.at).toBe(
      '2026-07-29T15:00:00.000Z',
    );
  });

  it('reads a unix-seconds suffix', () => {
    const at = Math.floor(now / 1000) + 3_600;
    expect(parseResetAt(`Claude usage limit reached|${at}`, now)?.ms).toBe(3_600_000);
  });

  it('reads a relative wait', () => {
    expect(parseResetAt('try again in 45 minutes', now)?.ms).toBe(45 * 60_000);
  });

  it('rolls a past clock time to tomorrow', () => {
    const parsed = parseResetAt('Your limit resets at 1am', now);
    expect(parsed).not.toBeNull();
    if (parsed) expect(parsed.ms).toBeGreaterThan(0);
  });

  it('returns null when there is nothing to parse', () => {
    expect(parseResetAt('usage limit reached', now)).toBeNull();
  });

  it('rejects a reset absurdly far in the future as a misparse', () => {
    expect(parseResetAt('resets at 2030-01-01T00:00:00Z', now)).toBeNull();
  });
});

describe('version handling', () => {
  it('parses a version string', () => {
    expect(parseCliVersion('2.1.4 (Claude Code)')).toBe('2.1.4');
    expect(parseCliVersion('claude 1.0.62')).toBe('1.0.62');
    expect(parseCliVersion('no numbers here')).toBeNull();
  });

  it('compares versions numerically, not lexically', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });
});

describe('flag probing and argv', () => {
  const modernHelp = [
    'Usage: claude [options] [prompt]',
    '  -p, --print                    Print response and exit',
    '  --output-format <format>       Output format (text, json, stream-json)',
    '  --model <model>                Model for the session',
    '  --allowed-tools <tools...>     Comma or space-separated list of tool names to allow',
    '  --disallowed-tools <tools...>  Tool names to deny',
    '  --permission-mode <mode>       Permission mode',
    '  --dangerously-skip-permissions Bypass all permission checks',
  ].join('\n');

  it('detects modern flags', () => {
    const flags = parseFlagSupport(modernHelp);
    expect(flags.allowedToolsKebab).toBe(true);
    expect(flags.disallowedTools).toBe(true);
    expect(flags.canDisableTools).toBe(true);
  });

  it('detects the older camelCase spelling', () => {
    const flags = parseFlagSupport('  --allowedTools <tools>  allow tools');
    expect(flags.allowedToolsCamel).toBe(true);
    expect(flags.allowedToolsKebab).toBe(false);
    expect(flags.canDisableTools).toBe(true);
  });

  it('reports that a bare build cannot disable tools', () => {
    const flags = parseFlagSupport('  -p, --print  print and exit');
    expect(flags.canDisableTools).toBe(false);
  });

  it('never passes the prompt as an argument and never skips permissions by default', () => {
    const argv = buildCliArgv({ modelId: 'claude-sonnet-5', flags: parseFlagSupport(modernHelp) });
    expect(argv[0]).toBe('-p');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-sonnet-5');
    expect(argv).toContain('--allowed-tools');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv.join(' ')).not.toContain('BEGIN DOCUMENT');
  });

  it('omits flags the installed build does not accept', () => {
    const argv = buildCliArgv({
      modelId: 'claude-sonnet-5',
      flags: parseFlagSupport('  -p, --print  print and exit'),
    });
    expect(argv).toEqual(['-p']);
  });

  it('adds the last-resort flag only when explicitly asked and supported', () => {
    const flags = parseFlagSupport(modernHelp);
    expect(
      buildCliArgv({ modelId: 'm', flags, dangerouslySkipPermissions: true }),
    ).toContain('--dangerously-skip-permissions');
    expect(
      buildCliArgv({
        modelId: 'm',
        flags: parseFlagSupport('  --allowed-tools <t>'),
        dangerouslySkipPermissions: true,
      }),
    ).not.toContain('--dangerously-skip-permissions');
  });
});
