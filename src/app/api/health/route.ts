import { route } from '@/app/api/_lib/http';
import { currentSettings } from '@/app/api/_lib/settings';
import { SCHEMA_VERSION } from '@/lib/db/migrate';
import { recentErrors } from '@/lib/db/queries';
import type { AppSettings, ErrorRow } from '@/lib/db/types';
import { checkFolder, checkFolderWritable, dataDir, ensureDir, logDir } from '@/lib/paths';
import { healthAll } from '@/lib/providers';
import { errorInfo, toEngineError } from '@/lib/providers/errors';
import { keychainStatus } from '@/lib/providers/keychain';
import type { HealthCheck, HealthState, ProviderHealth } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RECENT_ERRORS = 10;

/** Worst state wins, so one red row cannot hide behind five green ones. */
const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };

function folderCheck(
  id: string,
  label: string,
  dir: string | null,
  mode: 'read' | 'write',
): HealthCheck {
  if (dir === null) {
    return { id, label, state: 'warn', detail: 'Not chosen yet.', errorCode: 'FOLDER_MISSING' };
  }
  try {
    // The folders we own are created rather than reported missing.
    if (mode === 'write') ensureDir(dir);
  } catch (e) {
    const err = toEngineError(e, 'FOLDER_UNREADABLE');
    return { id, label, state: 'fail', detail: err.info.message, errorCode: err.code };
  }
  const problem = mode === 'write' ? checkFolderWritable(dir) : checkFolder(dir);
  if (problem) {
    return { id, label, state: 'fail', detail: problem.info.message, errorCode: problem.code };
  }
  return { id, label, state: 'ok', detail: dir };
}

async function keychainCheck(settings: AppSettings | null): Promise<HealthCheck> {
  try {
    const status = await keychainStatus();
    if (settings?.provider === 'api' && !settings.hasApiKey) {
      return {
        id: 'keychain',
        label: 'API key',
        state: 'fail',
        detail: errorInfo('API_KEY_MISSING').message,
        errorCode: 'API_KEY_MISSING',
      };
    }
    return {
      id: 'keychain',
      label: 'API key storage',
      state: status.keychainAvailable ? 'ok' : 'warn',
      detail: status.detail,
      ...(status.keychainAvailable ? {} : { errorCode: 'KEYCHAIN_UNAVAILABLE' }),
    };
  } catch (e) {
    const err = toEngineError(e, 'KEYCHAIN_UNAVAILABLE');
    return {
      id: 'keychain',
      label: 'API key storage',
      state: 'fail',
      detail: err.info.message,
      errorCode: err.code,
    };
  }
}

export async function GET(): Promise<Response> {
  return route('api.health', async () => {
    const checks: HealthCheck[] = [];

    // Reading settings is also the database probe: it opens the file and runs a query.
    let settings: AppSettings | null = null;
    try {
      settings = await currentSettings();
      checks.push({
        id: 'db',
        label: 'Database',
        state: 'ok',
        detail: `Open and writable, schema v${SCHEMA_VERSION}`,
      });
    } catch (e) {
      const err = toEngineError(e, 'DB_CORRUPT');
      checks.push({
        id: 'db',
        label: 'Database',
        state: 'fail',
        detail: err.info.message,
        errorCode: err.code,
      });
    }

    checks.push(folderCheck('data', 'Application data', dataDir(), 'write'));
    checks.push(folderCheck('logs', 'Log folder', logDir(), 'write'));
    checks.push(folderCheck('watch', 'Watched folder', settings?.watchFolder ?? null, 'read'));
    checks.push(folderCheck('archive', 'PDF archive', settings?.archiveFolder ?? null, 'write'));
    checks.push(folderCheck('export', 'Export folder', settings?.exportFolder ?? null, 'write'));
    checks.push(await keychainCheck(settings));

    let engine: ProviderHealth;
    try {
      const all = await healthAll();
      engine = all[all.active];
    } catch (e) {
      engine = {
        provider: settings?.provider ?? 'cli',
        state: 'fail',
        summary: toEngineError(e).info.message,
        checks: [],
      };
    }

    let errors: ErrorRow[] = [];
    try {
      errors = recentErrors(RECENT_ERRORS);
    } catch {
      // The database row above already carries this failure; do not double-report it.
    }

    const overall = [...checks.map((c) => c.state), engine.state].reduce<HealthState>(
      (worst, s) => (RANK[s] > RANK[worst] ? s : worst),
      'ok',
    );

    return { overall, checks, engine, recentErrors: errors };
  });
}
