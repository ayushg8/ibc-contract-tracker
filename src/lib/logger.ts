/**
 * Append-only JSONL log.
 *
 * Deliberately synchronous and dependency-light. This is the one module that has to
 * keep working while everything else is failing, so it never awaits, never throws,
 * and never imports anything that itself logs. A logger that can take the app down
 * is worse than no logger.
 *
 * Every string that reaches disk goes through redact() first, because these files
 * end up pasted into a support email.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { logDir } from '@/lib/paths';
import { redact } from '@/lib/providers/errors';

const MAX_BYTES = 5 * 1024 * 1024;
/** app.log plus app.log.1 .. app.log.3 */
const KEEP_ROTATED = 3;
/** Never read more than this from the end of a file to answer recentLines(). */
const TAIL_BYTES = 1024 * 1024;
const MAX_LINES = 5000;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;

export type LogLevel = 'info' | 'warn' | 'error';
export type LogData = Record<string, unknown>;

function logFile(n = 0): string {
  return join(logDir(), n === 0 ? 'app.log' : `app.log.${n}`);
}

/** redact() collapses the empty string to undefined; keep the caller's value. */
function safe(s: string): string {
  return redact(s) ?? s;
}

function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'string':
      return safe(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    default:
      break;
  }

  if (value instanceof Error) {
    return { name: value.name, message: safe(value.message) };
  }
  if (depth >= MAX_DEPTH) return '[deep]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((v) => clean(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[safe(k)] = clean(v, depth + 1);
    return out;
  }
  return '[unloggable]';
}

function rotate(): void {
  const oldest = logFile(KEEP_ROTATED);
  if (existsSync(oldest)) rmSync(oldest, { force: true });
  for (let n = KEEP_ROTATED - 1; n >= 0; n -= 1) {
    const from = logFile(n);
    if (existsSync(from)) renameSync(from, logFile(n + 1));
  }
}

function write(level: LogLevel, event: string, data?: LogData): void {
  try {
    const dir = logDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const path = logFile();
    // Rotate before appending so one record can never straddle two files.
    if (existsSync(path) && statSync(path).size >= MAX_BYTES) rotate();

    const record: Record<string, unknown> = {
      at: new Date().toISOString(),
      level,
      event: safe(event),
    };
    if (data) record.data = clean(data);
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Swallowed on purpose. See the header comment.
  }
}

export const log = {
  info: (event: string, data?: LogData): void => write('info', event, data),
  warn: (event: string, data?: LogData): void => write('warn', event, data),
  error: (event: string, data?: LogData): void => write('error', event, data),
};

function tail(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    if (size === 0) return [];

    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }

    const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
    // Starting mid-file means the first line is a fragment.
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  }
}

/**
 * The last `n` records, oldest first, reaching back into rotated files when the
 * current one is short. Raw JSONL lines — the Diagnostics viewer parses them.
 */
export function recentLines(n: number): string[] {
  const wanted = Math.max(0, Math.min(Math.trunc(n), MAX_LINES));
  if (wanted === 0) return [];

  let out: string[] = [];
  for (let i = 0; i <= KEEP_ROTATED && out.length < wanted; i += 1) {
    const chunk = tail(logFile(i));
    if (chunk.length === 0) continue;
    const room = wanted - out.length;
    out = [...chunk.slice(Math.max(0, chunk.length - room)), ...out];
  }
  return out;
}
