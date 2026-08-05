/**
 * The support bundle.
 *
 * One plain-text blob, no attachment, no zip: Bonnie clicks Copy and pastes it into
 * Mail. That constraint is the whole design -- a human has to be able to read it in a
 * mail client, and it has to be safe to send, so every string goes through redact()
 * and the API key is represented only by the fact that one exists.
 */

import { readFile } from 'node:fs/promises';
import { arch, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { SCHEMA_VERSION } from '@/lib/db/migrate';
import {
  documentCountsByStatus,
  getSettings,
  getStats,
  recentErrors,
  usageRollup,
} from '@/lib/db/queries';
import type { AppSettings, ErrorRow } from '@/lib/db/types';
import { log, recentLines } from '@/lib/logger';
import { dataDir, dbPath, logDir } from '@/lib/paths';
import { healthAll } from '@/lib/providers';
import { redact, toEngineError } from '@/lib/providers/errors';
import { getKey } from '@/lib/providers/keychain';
import type { ProviderHealth } from '@/lib/providers/types';

const LOG_LINES = 200;
const FAILED_DOCUMENTS = 10;
const RULE = '-'.repeat(64);
const LABEL_WIDTH = 20;

export interface SupportBundle {
  filename: string;
  contents: string;
}

function safe(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const s = typeof value === 'string' ? value : String(value);
  return redact(s) ?? s;
}

function field(label: string, value: unknown): string {
  return `${label.padEnd(LABEL_WIDTH, ' ')} ${safe(value)}`;
}

const PackageJson = z.object({ version: z.string() });

async function appVersion(): Promise<string> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = PackageJson.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The key itself never enters this function. Only whether one resolves, and from
 * where, which is the only part a support reply can act on.
 */
async function settingsBlock(): Promise<string[]> {
  let hasApiKey = false;
  let apiKeySource: AppSettings['apiKeySource'] = 'none';
  try {
    const lookup = await getKey();
    hasApiKey = lookup.key !== null;
    if (hasApiKey) apiKeySource = lookup.source === 'env' ? 'env' : 'keychain';
  } catch {
    // Reported as "no key". A bundle must build even when the keychain is broken.
  }

  const s = getSettings({ hasApiKey, apiKeySource });
  return [
    field('provider', s.provider),
    field('model tier', s.tier),
    field('api key present', s.hasApiKey),
    field('api key source', s.apiKeySource),
    field('watch folder', s.watchFolder),
    field('archive folder', s.archiveFolder),
    field('export folder', s.exportFolder),
    field('auto extract', s.autoExtract),
    field('escalate low yield', s.escalateOnLowYield),
    field('glass intensity', s.glassIntensity),
    field('density', s.density),
    field('last exported', s.lastExportedAt),
    field('onboarding done', s.onboardingComplete),
  ];
}

function oneEngine(label: string, health: ProviderHealth): string[] {
  const lines = [
    field(`${label} state`, health.state),
    field(`${label} summary`, health.summary),
  ];
  if (health.version !== undefined) lines.push(field(`${label} version`, health.version));
  if (health.limitResetsAt !== undefined) {
    lines.push(field(`${label} limit resets`, health.limitResetsAt));
  }
  for (const check of health.checks) {
    lines.push(`  [${check.state.toUpperCase().padEnd(7, ' ')}] ${safe(check.label)} - ${safe(check.detail)}`);
  }
  return lines;
}

async function engineBlock(): Promise<string[]> {
  try {
    const all = await healthAll();
    return [
      field('active engine', all.active),
      ...oneEngine('cli', all.cli),
      ...oneEngine('api', all.api),
    ];
  } catch (e) {
    return [`unavailable: ${safe(toEngineError(e).info.message)}`];
  }
}

function failuresBlock(errors: ErrorRow[]): string[] {
  if (errors.length === 0) return ['(no failures recorded)'];
  return errors.map(
    (e) =>
      `${safe(e.at)}  ${safe(e.code)}  ${safe(e.filename)}\n` +
      `    ${safe(e.message)}${e.detail ? `\n    ${safe(e.detail)}` : ''}`,
  );
}

function section(title: string, lines: string[]): string {
  return [title, RULE, ...lines].join('\n');
}

export async function buildSupportBundle(): Promise<SupportBundle> {
  const now = new Date();
  const sections: string[] = [
    ['IBC Contract Tracker - support bundle', field('generated', now.toISOString())].join('\n'),
    section('ENVIRONMENT', [
      field('app version', await appVersion()),
      field('node version', process.version),
      field('platform', `${platform()} ${release()} (${arch()})`),
      field('memory', `${Math.round(totalmem() / 1024 / 1024 / 1024)} GB`),
      field('data dir', dataDir()),
      field('database', dbPath()),
      field('log dir', logDir()),
      field('schema version', SCHEMA_VERSION),
    ]),
  ];

  try {
    sections.push(section('SETTINGS', await settingsBlock()));
  } catch (e) {
    sections.push(section('SETTINGS', [`unreadable: ${safe(toEngineError(e).info.message)}`]));
  }

  sections.push(section('ENGINE HEALTH', await engineBlock()));

  try {
    const stats = getStats();
    const usage = usageRollup();
    const byStatus = documentCountsByStatus();
    sections.push(
      section('COUNTS', [
        ...Object.entries(byStatus).map(([status, n]) => field(`documents ${status}`, n)),
        field('contracts', stats.contracts),
        field('expiring', stats.expiring),
        field('expired', stats.expired),
        field('needs attention', stats.needsAttention),
        field('failed', stats.failed),
        field('month', usage.month),
        field('month calls', usage.calls),
        field('month documents', usage.documents),
        field('month cost usd', usage.costUsd.toFixed(4)),
      ]),
    );
  } catch (e) {
    sections.push(section('COUNTS', [`unreadable: ${safe(toEngineError(e).info.message)}`]));
  }

  try {
    sections.push(
      section(`LAST ${FAILED_DOCUMENTS} FAILURES`, failuresBlock(recentErrors(FAILED_DOCUMENTS))),
    );
  } catch (e) {
    sections.push(
      section(`LAST ${FAILED_DOCUMENTS} FAILURES`, [
        `unreadable: ${safe(toEngineError(e).info.message)}`,
      ]),
    );
  }

  const lines = recentLines(LOG_LINES);
  sections.push(
    section(
      `LOG (last ${lines.length} of ${LOG_LINES} requested)`,
      lines.length === 0 ? ['(log is empty)'] : lines.map((l) => safe(l)),
    ),
  );

  sections.push('End of bundle.');

  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  log.info('support.bundle.built', { sections: sections.length });

  return {
    filename: `IBC-Tracker-Support-${stamp}.txt`,
    contents: `${sections.join('\n\n')}\n`,
  };
}
