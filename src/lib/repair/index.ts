/**
 * Self-repair, one entry point.
 *
 * Server-only: importing this pulls in node:child_process and node:sqlite. A
 * client component that wants to render the status imports `./types`, which is
 * types and constants alone.
 *
 * The updater's whole surface is `runRepair(request)`. Everything else here is
 * for the API route, for diagnostics and for support.
 */

export type {
  AttemptOutcome,
  AttemptRecord,
  ChangeSet,
  FailureReport,
  GateId,
  GateResult,
  PendingPromotion,
  ProtectedViolation,
  RepairPhase,
  RepairRequest,
  RepairState,
  RepairStatus,
  RollbackReport,
  SuspendedAttempt,
  UpdateReport,
} from './types';

export { MAX_ATTEMPTS_PER_SIGNATURE, TERMINAL_PHASES } from './types';

export {
  isRepairRunning,
  reconcilePromotion,
  repairArtifacts,
  repairStatus,
  resumeIfDue,
  resumeRepair,
  runRepair,
} from './run';

export { PROTECTED_RULES, protectedRuleFor, protectedViolations } from './protected';
export { failureSignature } from './signature';
export { recentRepairAudit } from './audit';
export { REPAIR_AGENT_LABEL, repairLogPaths, scheduleStatus, unscheduleResume } from './schedule';
export { describeGrant, REPAIR_ALLOWED_TOOLS, REPAIR_DISALLOWED_TOOLS } from './claude';
export { dueForResume, journalPath, loadState, repairDir } from './state';
