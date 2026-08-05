/**
 * Settings are assembled from two stores, on purpose: everything ordinary lives in
 * the database, and whether an API key exists is asked of the keychain at read time.
 * The database is never allowed to imply that a key is present.
 */

import { getSettings as readStoredSettings } from '@/lib/db/queries';
import type { AppSettings } from '@/lib/db/types';
import { getKey } from '@/lib/providers/keychain';

/**
 * The keychain distinguishes a real keychain entry from the restricted-file
 * fallback; AppSettings does not. Both are "stored locally and not in the
 * database", which is the only distinction the UI acts on.
 */
export async function keyState(): Promise<{
  hasApiKey: boolean;
  apiKeySource: AppSettings['apiKeySource'];
}> {
  try {
    const lookup = await getKey();
    if (lookup.key === null) return { hasApiKey: false, apiKeySource: 'none' };
    return {
      hasApiKey: true,
      apiKeySource: lookup.source === 'env' ? 'env' : 'keychain',
    };
  } catch {
    // A keychain we cannot read is reported as "no key", never as an error page.
    return { hasApiKey: false, apiKeySource: 'none' };
  }
}

export async function currentSettings(): Promise<AppSettings> {
  return readStoredSettings(await keyState());
}
