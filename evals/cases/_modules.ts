/**
 * The only file in the eval suite that reaches into src/lib.
 *
 * Everything is loaded through a dynamic import wrapped in a try/catch, for one reason:
 * this suite has to run while the rest of the app is still being built. A module that
 * does not exist yet, or that fails to import because one of ITS imports is wrong, must
 * turn into a legible SKIP line - not a stack trace that hides the twelve cases behind it.
 *
 * If a signature below stops matching src/lib, this is the file to change.
 */

export const modules = {
  dates: () => import('../../src/lib/util/dates'),
  status: () => import('../../src/lib/status'),
  normalize: () => import('../../src/lib/util/normalize'),
  parties: () => import('../../src/lib/parties'),
  rules: () => import('../../src/lib/extraction/rules'),
  verify: () => import('../../src/lib/extraction/verify'),
  pdf: () => import('../../src/lib/extraction/pdf'),
  prompt: () => import('../../src/lib/extraction/prompt'),
  cache: () => import('../../src/lib/extraction/cache'),
  pipeline: () => import('../../src/lib/extraction/pipeline'),
  queries: () => import('../../src/lib/db/queries'),
  providers: () => import('../../src/lib/providers/index'),
  excel: () => import('../../src/lib/excel/export'),
  paths: () => import('../../src/lib/paths'),
} as const;

export type Modules = {
  [K in keyof typeof modules]: Awaited<ReturnType<(typeof modules)[K]>>;
};

export interface Loaded<T> {
  mod: T | null;
  /** One line naming the module and the reason, ready to print as a skip note. */
  reason: string | null;
}

const cache = new Map<string, Loaded<unknown>>();

/**
 * `label` is the path a human would open. Failures are cached so twelve cases asking for
 * the same missing module produce one import attempt and twelve identical skip lines.
 */
export async function load<K extends keyof typeof modules>(key: K): Promise<Loaded<Modules[K]>> {
  const hit = cache.get(key);
  if (hit) return hit as Loaded<Modules[K]>;
  let result: Loaded<Modules[K]>;
  try {
    const mod = (await modules[key]()) as Modules[K];
    result = { mod, reason: null };
  } catch (e) {
    result = { mod: null, reason: `${key} did not load: ${firstLine(e)}` };
  }
  cache.set(key, result);
  return result;
}

function firstLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = raw.split('\n')[0] ?? raw;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
