/**
 * Coming back when the subscription limit resets.
 *
 * The app already knows how to be told "you have hit your limit, it resets at
 * 3pm": classifyCliOutput returns CLI_USAGE_LIMIT with a parsed reset time, and
 * the extraction queue halts once rather than failing forty documents. Repair
 * uses the same verdict and the same reset time, and adds the one thing a queue
 * in memory cannot do -- surviving a logout, a reboot and a closed lid.
 *
 * A LaunchAgent with StartCalendarInterval does that. launchd runs a missed
 * calendar job when the Mac wakes, which is exactly the behaviour wanted: she
 * shuts the lid at six, the limit resets at nine, the repair runs when she opens
 * it again.
 *
 * But scheduling is a request, and `launchctl bootstrap` returning 0 means the
 * request was accepted, not that a job exists -- the same lesson the launcher
 * learned the hard way. So the job is read back with `launchctl print` before it
 * is called scheduled, and the durable state file, not the agent, remains the
 * source of truth about whether a repair is owed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { log } from '@/lib/logger';
import { dataDir, logDir } from '@/lib/paths';

import { journal, repairBinDir } from './state';

/** Sibling of the server's agent, deliberately a different label. */
export const REPAIR_AGENT_LABEL = 'com.internationalbattery.contract-tracker.repair';

/**
 * `IBC_LAUNCH_AGENTS_DIR` exists so a test can write and lint a real plist
 * without touching the LaunchAgents folder of whoever is running the tests.
 */
export function launchAgentsDir(): string {
  const override = process.env['IBC_LAUNCH_AGENTS_DIR'];
  if (override !== undefined && override.trim() !== '') return override.trim();
  return join(userInfo().homedir, 'Library', 'LaunchAgents');
}

export function repairPlistPath(): string {
  return join(launchAgentsDir(), `${REPAIR_AGENT_LABEL}.plist`);
}

/* ───────────────────────────── the template ─────────────────────────── */

/**
 * The one copy of this document that runs. packaging/app-template/RepairAgent.plist.in
 * holds the identical text for the installer to see, and tests/repair.test.ts
 * fails if the two ever drift.
 *
 * Two choices differ from the server's agent, and both are deliberate:
 *
 *   ProcessType Background, not Interactive. The server is Interactive because
 *   she is waiting on it the moment she clicks the icon; this is the opposite --
 *   real background work that must not compete with whatever she is doing. The
 *   disk-I/O throttling that made the server take 18.9s to boot is welcome here.
 *
 *   RunAtLoad false. Loading the agent must not start a repair; only the calendar
 *   entry may. Otherwise every login would kick one off.
 */
export const REPAIR_PLIST_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>@@LABEL@@</string>

	<!-- Resumes a repair that stopped on the Claude subscription limit. The
	     script asks the app; the app decides whether anything is owed. -->
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>@@REPAIR_SH@@</string>
		<string>resume</string>
	</array>

	<!-- Loading this agent must never start a repair. Only the calendar entry
	     below may, and it fires once, at the moment the limit resets. -->
	<key>RunAtLoad</key>
	<false/>

	<!-- launchd runs a calendar job it missed as soon as the Mac wakes, which is
	     the whole reason this is not an in-process timer: the limit resets at
	     9pm and the lid is shut at 6pm. -->
	<key>StartCalendarInterval</key>
	<dict>
		<key>Month</key>
		<integer>@@MONTH@@</integer>
		<key>Day</key>
		<integer>@@DAY@@</integer>
		<key>Hour</key>
		<integer>@@HOUR@@</integer>
		<key>Minute</key>
		<integer>@@MINUTE@@</integer>
	</dict>

	<!-- A crashed repair must not be respawned in a loop against a subscription
	     that is still capped. The state file decides when to try again. -->
	<key>KeepAlive</key>
	<false/>

	<!-- Genuinely background, unlike the server. She is not waiting on this, and
	     it must not compete with whatever she is actually doing. -->
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>5</integer>

	<key>StandardOutPath</key>
	<string>@@STDOUT@@</string>
	<key>StandardErrorPath</key>
	<string>@@STDERR@@</string>

	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>@@HOME@@</string>
		<!-- launchd hands a job almost no PATH, and this one has to find both
		     curl and the app's own runtime. -->
		<key>PATH</key>
		<string>@@PATH@@</string>
	</dict>
</dict>
</plist>
`;

export interface RepairPlistVars {
  label: string;
  repairSh: string;
  month: number;
  day: number;
  hour: number;
  minute: number;
  stdout: string;
  stderr: string;
  home: string;
  path: string;
}

/** Every placeholder the template uses. The drift test reads this. */
export const REPAIR_PLIST_PLACEHOLDERS: readonly string[] = [
  '@@LABEL@@',
  '@@REPAIR_SH@@',
  '@@MONTH@@',
  '@@DAY@@',
  '@@HOUR@@',
  '@@MINUTE@@',
  '@@STDOUT@@',
  '@@STDERR@@',
  '@@HOME@@',
  '@@PATH@@',
];

/**
 * XML escaping is not optional here: a home directory or an app path may contain
 * an ampersand, and a plist that will not parse is a repair that never runs and
 * never says why.
 */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderRepairPlist(vars: RepairPlistVars): string {
  const map: Record<string, string> = {
    '@@LABEL@@': xmlEscape(vars.label),
    '@@REPAIR_SH@@': xmlEscape(vars.repairSh),
    '@@MONTH@@': String(vars.month),
    '@@DAY@@': String(vars.day),
    '@@HOUR@@': String(vars.hour),
    '@@MINUTE@@': String(vars.minute),
    '@@STDOUT@@': xmlEscape(vars.stdout),
    '@@STDERR@@': xmlEscape(vars.stderr),
    '@@HOME@@': xmlEscape(vars.home),
    '@@PATH@@': xmlEscape(vars.path),
  };
  let out = REPAIR_PLIST_TEMPLATE;
  for (const [placeholder, value] of Object.entries(map)) {
    out = out.split(placeholder).join(value);
  }
  return out;
}

/**
 * The calendar fields for a moment.
 *
 * Local time, because StartCalendarInterval is local time. A reset in the past
 * is clamped to a minute from now: launchd would otherwise wait a year for the
 * date to come round again.
 */
export function calendarFor(at: Date, now: Date = new Date()): {
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const target = at.getTime() > now.getTime() ? at : new Date(now.getTime() + 60_000);
  return {
    month: target.getMonth() + 1,
    day: target.getDate(),
    hour: target.getHours(),
    minute: target.getMinutes(),
  };
}

/** The PATH a launchd job needs to find curl, the bundled node and `claude`. */
export function agentPath(home: string): string {
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
}

/* ─────────────────────────── install / verify ───────────────────────── */

function launchctl(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync('/bin/launchctl', args, { stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, output };
  } catch (e) {
    const output =
      typeof e === 'object' && e !== null && 'stderr' in e && typeof e.stderr === 'string'
        ? e.stderr
        : String(e);
    return { ok: false, output };
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? userInfo().uid}`;
}

/**
 * Is the job REALLY there?
 *
 * `launchctl print` is the read-back. bootstrap exiting 0 only means launchd
 * accepted the request -- the launcher already shipped one bug built on trusting
 * exactly that, and it cost 90 seconds of a blank screen.
 */
export function isScheduled(): boolean {
  const result = launchctl(['print', `${domain()}/${REPAIR_AGENT_LABEL}`]);
  return result.ok && result.output.includes(REPAIR_AGENT_LABEL);
}

export interface ScheduleOutcome {
  scheduled: boolean;
  at: string;
  detail: string;
}

/**
 * Write the plist, load it, and prove it loaded.
 *
 * A failure here is not fatal to the repair: state.suspended still says a resume
 * is owed and `dueForResume()` will pick it up the next time anything asks. The
 * agent is the punctual path, not the only one.
 */
export function scheduleResume(resumeAt: Date, repairScript: string): ScheduleOutcome {
  const home = userInfo().homedir;
  const calendar = calendarFor(resumeAt);
  const plist = renderRepairPlist({
    label: REPAIR_AGENT_LABEL,
    repairSh: repairScript,
    ...calendar,
    stdout: join(logDir(), 'repair-agent.out.log'),
    stderr: join(logDir(), 'repair-agent.err.log'),
    home,
    path: agentPath(home),
  });

  const target = repairPlistPath();
  try {
    mkdirSync(launchAgentsDir(), { recursive: true });
    mkdirSync(logDir(), { recursive: true });
    writeFileSync(target, plist, 'utf8');
  } catch (e) {
    log.error('repair.schedule.write-failed', { error: e });
    return { scheduled: false, at: resumeAt.toISOString(), detail: 'could not write the LaunchAgent' };
  }

  // A malformed plist is accepted by the filesystem and rejected by launchd with
  // nothing useful in the log, so it is linted here where the error is legible.
  const lint = (() => {
    try {
      execFileSync('/usr/bin/plutil', ['-lint', target], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!lint) {
    rmSync(target, { force: true });
    return { scheduled: false, at: resumeAt.toISOString(), detail: 'the LaunchAgent came out malformed' };
  }

  // Replace rather than reload: a bootstrap over a loaded job is an error, and a
  // stale calendar entry from a previous limit would fire at the wrong hour.
  launchctl(['bootout', `${domain()}/${REPAIR_AGENT_LABEL}`]);
  const bootstrap = launchctl(['bootstrap', domain(), target]);
  const scheduled = isScheduled();

  journal('repair.schedule', {
    resumeAt: resumeAt.toISOString(),
    calendar,
    bootstrapOk: bootstrap.ok,
    verified: scheduled,
  });

  return {
    scheduled,
    at: resumeAt.toISOString(),
    detail: scheduled
      ? `launchd will run the repair at ${resumeAt.toISOString()}`
      : `launchd accepted=${bootstrap.ok} but no job is loaded; the app will resume it on its own instead`,
  };
}

/** Take the agent away. Called on success, on exhaustion, and by repair.sh. */
export function unscheduleResume(): void {
  launchctl(['bootout', `${domain()}/${REPAIR_AGENT_LABEL}`]);
  try {
    rmSync(repairPlistPath(), { force: true });
  } catch {
    // A plist we cannot remove is a job that will fire once and find nothing owed.
  }
}

/** Where repair.sh was materialised, if it has been. */
export function promoterScriptPath(): string {
  return join(repairBinDir(), 'repair.sh');
}

export function promoterScriptExists(): boolean {
  return existsSync(promoterScriptPath());
}

/** For diagnostics: everything about the schedule, in one object. */
export function scheduleStatus(): { plist: string; exists: boolean; loaded: boolean } {
  return {
    plist: repairPlistPath(),
    exists: existsSync(repairPlistPath()),
    loaded: isScheduled(),
  };
}

/** Kept next to the rest so support knows where the repair logs are. */
export function repairLogPaths(): string[] {
  return [
    join(logDir(), 'repair-agent.out.log'),
    join(logDir(), 'repair-agent.err.log'),
    join(dataDir(), 'repair', 'journal.jsonl'),
  ];
}
