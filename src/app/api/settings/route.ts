import { z } from 'zod';

import { badRequest, parse, readJson, route } from '@/app/api/_lib/http';
import { currentSettings } from '@/app/api/_lib/settings';
import { updateSettings } from '@/lib/db/queries';
import { log } from '@/lib/logger';
import { checkFolder, checkFolderWritable, ensureDir } from '@/lib/paths';
import { PROVIDER_IDS } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * strictObject, so hasApiKey / apiKeySource / lastExportedAt are rejected loudly rather
 * than silently ignored. Those three are derived, and a caller trying to set them has a
 * bug worth surfacing.
 *
 * THE OTHER HALF OF THAT BARGAIN: every key the client is allowed to send has to be
 * listed here. `appearance` was not, so choosing Dark answered 400, the control snapped
 * back to Light and a reload undid it -- the strictObject working exactly as designed
 * over a field somebody forgot. SettingsPatch in components/settings/SettingsTabs.tsx is
 * the client's half of the same contract; the test walks it key by key against this
 * schema so the next omission fails a build rather than a setting.
 */
const Patch = z.strictObject({
  provider: z.enum(PROVIDER_IDS).optional(),
  tier: z.enum(['fast', 'balanced', 'deep']).optional(),
  watchFolder: z.string().min(1).nullable().optional(),
  archiveFolder: z.string().min(1).optional(),
  exportFolder: z.string().min(1).optional(),
  autoExtract: z.boolean().optional(),
  appearance: z.enum(['system', 'light', 'dark']).optional(),
  glassIntensity: z.number().min(0).max(1).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  escalateOnLowYield: z.boolean().optional(),
  onboardingComplete: z.boolean().optional(),
});

function assertUsable(dir: string, label: string, mode: 'read' | 'write'): void {
  if (mode === 'write') ensureDir(dir);
  const problem = mode === 'write' ? checkFolderWritable(dir) : checkFolder(dir);
  if (problem) throw problem;
}

export async function GET(): Promise<Response> {
  return route('api.settings.get', async () => {
    return { settings: await currentSettings() };
  });
}

export async function PATCH(req: Request): Promise<Response> {
  return route('api.settings.patch', async () => {
    const patch = parse(Patch, await readJson(req), 'settings');
    if (Object.keys(patch).length === 0) throw badRequest('That request changed nothing.');

    // Fail here rather than at extraction time, when she has walked away.
    if (patch.watchFolder !== undefined && patch.watchFolder !== null) {
      assertUsable(patch.watchFolder, 'watch folder', 'read');
    }
    if (patch.archiveFolder !== undefined) assertUsable(patch.archiveFolder, 'archive', 'write');
    if (patch.exportFolder !== undefined) assertUsable(patch.exportFolder, 'export', 'write');

    updateSettings(patch);
    log.info('settings.updated', { keys: Object.keys(patch) });
    return { settings: await currentSettings() };
  });
}
