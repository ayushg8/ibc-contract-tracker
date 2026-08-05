/**
 * The repair endpoint.
 *
 * Three callers, all local:
 *   * the updater, which POSTs a failure after it has already rolled back
 *   * the scheduled LaunchAgent, via repair.sh, which POSTs {"action":"resume"}
 *   * the app itself, which GETs the status for Diagnostics
 *
 * GET is not passive. It reconciles a promotion that outlived the process which
 * started it, and it starts a resume whose reset time has passed -- because
 * launchd is a trigger, not a guarantee, and a repair that is owed must not
 * depend on anything remembering to ask for it.
 *
 * POST returns immediately with the state it moved to. It never waits for a
 * repair: a Claude session plus four gates is twenty minutes, and an HTTP
 * request held open for twenty minutes is a request that will be killed at the
 * nineteenth by something in between.
 */

import { z } from 'zod';

import { conflict, parse, readJson, route } from '@/app/api/_lib/http';
import { log } from '@/lib/logger';
import {
  isRepairRunning,
  recentRepairAudit,
  reconcilePromotion,
  repairStatus,
  resumeIfDue,
  resumeRepair,
  runRepair,
  scheduleStatus,
  type RepairRequest,
} from '@/lib/repair';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The updater's half of the contract, validated rather than trusted.
 *
 * `rollback` is required in full. It is the precondition the whole design rests
 * on, and a caller that forgets to send it must be refused, not defaulted to
 * "probably fine".
 */
const Failure = z.object({
  stage: z.string().min(1).max(120),
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2_000),
  detail: z.string().max(200_000).optional(),
  logExcerpt: z.string().max(1_000_000).optional(),
});

const Rollback = z.object({
  performed: z.boolean(),
  healthy: z.boolean(),
  version: z.string().max(120).nullable(),
  at: z.string().max(60),
});

const Update = z.object({
  fromVersion: z.string().max(120).nullable(),
  toVersion: z.string().max(120).nullable(),
  diff: z.string().max(4_000_000),
});

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('repair'),
    failure: Failure,
    rollback: Rollback,
    update: Update,
    sourceDir: z.string().min(1).max(4_096).optional(),
  }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('status') }),
]);

export async function GET(): Promise<Response> {
  return route('api.repair.get', async () => {
    reconcilePromotion();
    // Fire and forget: a due resume starts here, and the caller gets the state as
    // it is now rather than waiting twenty minutes to be told the same thing.
    await resumeIfDue();
    // The status fields are spread at the top level, not nested under `status`:
    // the Updates tab reads `phase` from the root of this body, and that end of
    // the wire is owned by another agent. Extras go alongside them.
    return {
      ...repairStatus(),
      running: isRepairRunning(),
      schedule: scheduleStatus(),
      history: recentRepairAudit(20),
    };
  });
}

export async function POST(req: Request): Promise<Response> {
  return route('api.repair.post', async () => {
    const body = parse(Body, await readJson(req), 'repair request');

    if (body.action === 'status') {
      reconcilePromotion();
      return { ...repairStatus(), running: isRepairRunning() };
    }

    if (body.action === 'resume') {
      const status = await resumeRepair();
      return { ...status, running: isRepairRunning() };
    }

    if (isRepairRunning()) {
      throw conflict('A repair is already running.', {
        remedy: { action: 'none', label: 'OK' },
        extra: { status: repairStatus() },
      });
    }

    const request: RepairRequest = {
      failure: body.failure,
      rollback: body.rollback,
      update: body.update,
      ...(body.sourceDir === undefined ? {} : { sourceDir: body.sourceDir }),
    };

    // Logged before anything is spawned, so an update that takes the machine
    // down mid-repair still leaves a record of what was asked for.
    log.warn('repair.requested', {
      stage: request.failure.stage,
      code: request.failure.code,
      rolledBack: request.rollback.performed,
      healthy: request.rollback.healthy,
    });

    const status = await runRepair(request);
    return { ...status, running: isRepairRunning() };
  });
}
