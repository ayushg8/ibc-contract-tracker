/**
 * Engine registry, concurrency gate, and self test.
 *
 * The one rule this module exists to enforce: there is NO automatic failover
 * between engines. If the active engine fails, the EngineError propagates and the
 * user decides. Silent failover would let the same document produce different
 * output on different days, which is the single thing this product is not allowed
 * to do. The UI offers the switch; the code never takes it.
 *
 * Server-only: pulls in both engines, which pull in child_process and the SDK.
 */

import { EngineError, toEngineError } from './errors';
import {
  DEFAULT_TIER,
  type ExtractOptions,
  type ExtractionRequest,
  type ExtractionResponse,
  type ModelTier,
  type Provider,
  type ProviderHealth,
  type ProviderId,
} from './types';
import { ApiProvider } from './api';
import { CliProvider } from './cli';
import { getSettings } from '../db/queries';
import { countVerifiableQuotes, SELF_TEST_FIELDS, SELF_TEST_TEXT } from './parse';

const cliProvider = new CliProvider();
const apiProvider = new ApiProvider();

/** Direct, synchronous access when the caller already knows which engine it wants. */
export function providerFor(id: ProviderId): Provider {
  return id === 'cli' ? cliProvider : apiProvider;
}

export function allProviders(): Provider[] {
  return [cliProvider, apiProvider];
}

/* ─────────────────────────── settings access ───────────────────── */

/**
 * The persisted engine choice, defaulting to the subscription (zero marginal cost).
 * A database that will not answer must not stop the app from telling the user which
 * engine it would have used, so every failure here degrades to the default.
 */
export function getActiveProviderId(): ProviderId {
  try {
    return getSettings().provider;
  } catch {
    return 'cli';
  }
}

export function getActiveTier(): ModelTier {
  try {
    return getSettings().tier;
  } catch {
    return DEFAULT_TIER;
  }
}

/**
 * Escape hatch for `--dangerously-skip-permissions`, which is off by default and is
 * NOT a stored setting: it must be a deliberate act, not a checkbox someone forgets
 * they ticked. Set IBC_CLI_SKIP_PERMISSIONS=1 to allow it, or call
 * `cliProvider.configure()` from a UI that labels the risk explicitly.
 */
function cliSkipPermissionsFromEnv(): boolean {
  const raw = process.env['IBC_CLI_SKIP_PERMISSIONS'];
  return raw === '1' || raw === 'true';
}

/**
 * The engine the next extraction will use. Reading the setting on every call is what
 * makes an engine switch in Settings take effect immediately, with no restart.
 *
 * Called with no argument it resolves the active engine; called with an id it hands
 * back that engine, so a caller that already knows does not need a second function.
 */
export async function getProvider(id?: ProviderId): Promise<Provider> {
  const resolved = id ?? getActiveProviderId();
  if (resolved === 'cli') {
    cliProvider.configure({ dangerouslySkipPermissions: cliSkipPermissionsFromEnv() });
  }
  return providerFor(resolved);
}

/** Named for the contract; identical to `getProvider()` with no argument. */
export async function getActiveProvider(): Promise<Provider> {
  return getProvider();
}

/* ────────────────────────── concurrency gate ───────────────────── */

/**
 * One gate per engine, sized by that engine's own limit. The CLI's limit of 1 is not
 * a performance choice: parallel spawns are the fastest way to trip a subscription
 * usage cap, and a tripped cap halts the whole queue.
 */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      throw new EngineError('UNKNOWN', { detail: 'Cancelled before it started.' });
    }
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseOnce();
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(wake);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new EngineError('UNKNOWN', { detail: 'Cancelled while queued.' }));
      };
      const wake = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiting.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    this.active += 1;
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    };
  }
}

const gates: Record<ProviderId, Gate> = {
  cli: new Gate(cliProvider.maxConcurrency),
  api: new Gate(apiProvider.maxConcurrency),
};

export function gateStatus(): Record<ProviderId, { inFlight: number; queued: number }> {
  return {
    cli: { inFlight: gates.cli.inFlight, queued: gates.cli.queued },
    api: { inFlight: gates.api.inFlight, queued: gates.api.queued },
  };
}

/** Run an extraction on a named engine, respecting that engine's concurrency limit. */
export async function extractWith(
  id: ProviderId,
  req: ExtractionRequest,
  opts: ExtractOptions = {},
): Promise<ExtractionResponse> {
  const provider = await getProvider(id);
  const release = await gates[id].acquire(opts.signal);
  try {
    return await provider.extract(req, opts);
  } catch (e) {
    // No failover. The error is the answer.
    throw toEngineError(e);
  } finally {
    release();
  }
}

/** Run an extraction on whichever engine Settings currently names. */
export async function extract(
  req: ExtractionRequest,
  opts: ExtractOptions = {},
): Promise<ExtractionResponse> {
  return extractWith(getActiveProviderId(), req, opts);
}

/* ──────────────────────────── diagnostics ──────────────────────── */

export interface AllHealth {
  active: ProviderId;
  cli: ProviderHealth;
  api: ProviderHealth;
}

/**
 * Both engines, always. Diagnostics shows the inactive one too, so switching is an
 * informed decision rather than a hope.
 */
export async function healthAll(): Promise<AllHealth> {
  const [cli, api] = await Promise.all([cliProvider.health(), apiProvider.health()]);
  return { active: getActiveProviderId(), cli, api };
}

export interface SelfTestResult {
  provider: ProviderId;
  ok: boolean;
  durationMs: number;
  /** Fields that came back with a quote we could find in the source text. */
  fieldsFound: number;
  fieldsTotal: number;
  costUsd: number | null;
  error?: EngineError;
}

/**
 * A real extraction of four fields from a synthetic NDA built in code, scored on how
 * many answers carry a quote that actually appears in the text. Proving the citation
 * contract end to end is the only self test worth showing a first-run wizard: an
 * endpoint ping passes happily on a machine where extraction cannot work.
 */
export async function selfTest(
  id?: ProviderId,
  opts: ExtractOptions = {},
): Promise<SelfTestResult> {
  const providerId = id ?? getActiveProviderId();
  const provider = await getProvider(providerId);
  const release = await gates[providerId].acquire(opts.signal);
  try {
    const result = await provider.selfTest(opts);
    return { provider: providerId, ...result };
  } finally {
    release();
  }
}

/** Exposed so the wizard can show what the self test is grading against. */
export const SELF_TEST_INFO = {
  text: SELF_TEST_TEXT,
  fields: SELF_TEST_FIELDS,
  score: countVerifiableQuotes,
} as const;
