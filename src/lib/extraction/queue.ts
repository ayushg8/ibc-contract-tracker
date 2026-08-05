/**
 * The in-process work queue.
 *
 * The behaviour that matters is what happens when the engine goes down mid-batch.
 * Forty documents must not each produce their own error card: the first halting
 * failure (usage limit, no network, bad key) pauses the queue, leaves everything
 * still waiting as `queued`, and exposes one halt reason for the UI to show as one
 * banner with one Resume button.
 *
 * Retryable failures back off with jitter and honour the engine's retryAfterMs.
 * Everything else fails the document and moves on — one bad PDF does not stop a batch.
 */

import type { EngineError, SerialisedEngineError } from '@/lib/providers/errors';
import { toEngineError } from '@/lib/providers/errors';
import type { ModelTier, Provider } from '@/lib/providers/types';
import { getActiveProvider, getActiveTier } from '@/lib/providers';
import { listDocumentIdsByStatus, updateDocument } from '@/lib/db/queries';

import { extractDocument } from './pipeline';

export interface QueueStatus {
  running: number;
  queued: number;
  paused: boolean;
  /** Set only when a halting error stopped the queue. Cleared by resume(). */
  haltReason: SerialisedEngineError | null;
  /** Documents finished since the process started. For the Inbox progress line. */
  completed: number;
  failed: number;
}

export type QueueListener = (status: QueueStatus) => void;

/** Total attempts per document before it is left failed for a human to retry. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Codes the queue will not retry, whatever the catalogue says about them.
 *
 * ALL_CITATIONS_FAILED is marked retryable because a human clicking Retry is a
 * sensible thing to offer -- Retry clears the cached answer first, so it really can
 * end differently. An automatic retry cannot. By the time the pipeline raises it, it
 * has already asked the model, verified every quote, and (on a scan) re-read the whole
 * document down the vision branch. Two more identical passes is five minutes of CPU
 * spent reaching a conclusion we already have.
 */
const NO_AUTO_RETRY = new Set<string>(['ALL_CITATIONS_FAILED']);

/**
 * Should the queue put this document back on its own?
 *
 * Exported because it is the whole of the "three identical passes" regression: a
 * predicate with a test is harder to quietly widen than a condition inside a catch.
 */
export function autoRetryable(err: EngineError, attempts: number): boolean {
  if (!err.info.retryable) return false;
  if (NO_AUTO_RETRY.has(err.code)) return false;
  return attempts < MAX_ATTEMPTS;
}

interface Job {
  documentId: string;
  attempts: number;
  /** Epoch ms before which this job must not be started again. */
  notBefore: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Full jitter: two documents that fail together must not retry in lockstep. */
function backoffMs(attempts: number, retryAfterMs: number | null): number {
  const floor = retryAfterMs ?? 0;
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  return Math.max(floor, Math.round(exponential * (0.5 + Math.random() * 0.5)));
}

class ExtractionQueue {
  private jobs: Job[] = [];
  private running = new Set<string>();
  private paused = false;
  private halt: SerialisedEngineError | null = null;
  private completed = 0;
  private failed = 0;
  private listeners = new Set<QueueListener>();
  private pumping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private engine: { provider: Provider; tier: ModelTier } | null = null;
  /** One per in-flight document, so a wedged scan can actually be stopped. */
  private controllers = new Map<string, AbortController>();
  /** Documents cancelled while running. They must not come back on a backoff. */
  private cancelled = new Set<string>();

  /* ─────────────────────────── public surface ─────────────────────────── */

  add(documentId: string): void {
    if (this.running.has(documentId)) return;
    if (this.jobs.some((j) => j.documentId === documentId)) return;
    this.jobs.push({ documentId, attempts: 0, notBefore: 0 });
    updateDocument(documentId, { status: 'queued', updatedAt: nowIso() });
    this.emit();
    void this.pump();
  }

  addMany(documentIds: readonly string[]): void {
    for (const id of documentIds) this.add(id);
  }

  pause(): void {
    this.paused = true;
    this.emit();
  }

  /**
   * Stop one document, wherever it is.
   *
   * Queued: it simply leaves the queue. Running: the AbortSignal it was started with
   * is fired, which is what OcrOptions.signal has always been for and what nothing in
   * the app ever supplied -- so before this, a scan wedged inside tesseract could only
   * be waited out. The pipeline's own catch records the stop on the document; the
   * cancelled set is what stops the queue from politely trying again.
   *
   * Returns false when the document was neither queued nor running.
   */
  cancel(documentId: string): boolean {
    const queuedAt = this.jobs.findIndex((j) => j.documentId === documentId);
    if (queuedAt !== -1) {
      this.jobs.splice(queuedAt, 1);
      this.emit();
      return true;
    }
    const controller = this.controllers.get(documentId);
    if (!controller) return false;
    this.cancelled.add(documentId);
    controller.abort();
    return true;
  }

  /** Clears the halt reason as well: Resume means "I fixed it, try again". */
  resume(): void {
    this.paused = false;
    this.halt = null;
    for (const job of this.jobs) job.notBefore = 0;
    this.emit();
    void this.pump();
  }

  status(): QueueStatus {
    return {
      running: this.running.size,
      queued: this.jobs.length,
      paused: this.paused,
      haltReason: this.halt,
      completed: this.completed,
      failed: this.failed,
    };
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Crash recovery. Anything the last process left mid-flight is queued again:
   * `extracting` is a claim, not a result, and a claim does not survive a restart.
   */
  recover(): void {
    const stranded = listDocumentIdsByStatus(['extracting', 'queued']);
    this.addMany(stranded);
  }

  /* ───────────────────────────── the pump ─────────────────────────────── */

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  /** Re-read every pass: switching engines mid-batch changes the limit. */
  private async concurrency(): Promise<number> {
    if (!this.engine) {
      this.engine = { provider: await getActiveProvider(), tier: getActiveTier() };
    }
    return Math.max(1, this.engine.provider.maxConcurrency);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.paused && this.jobs.length > 0) {
        const limit = await this.concurrency();
        if (this.running.size >= limit) break;

        const now = Date.now();
        const index = this.jobs.findIndex((j) => j.notBefore <= now);
        if (index === -1) {
          this.scheduleWake();
          break;
        }
        const [job] = this.jobs.splice(index, 1);
        if (!job) break;
        void this.run(job);
      }
    } catch (e) {
      // A failure to even reach the engine is a halt, not a document failure.
      this.haltWith(e);
    } finally {
      this.pumping = false;
    }
  }

  /** Wake exactly when the earliest backoff expires, not on a polling interval. */
  private scheduleWake(): void {
    if (this.timer || this.jobs.length === 0) return;
    const soonest = Math.min(...this.jobs.map((j) => j.notBefore));
    const delay = Math.max(50, soonest - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, delay);
  }

  private async run(job: Job): Promise<void> {
    this.running.add(job.documentId);
    this.emit();
    const engine = this.engine;
    const controller = new AbortController();
    this.controllers.set(job.documentId, controller);
    try {
      await extractDocument(job.documentId, {
        provider: engine?.provider,
        tier: engine?.tier,
        signal: controller.signal,
        // A retry that replays the stored answer is not a retry. The cache is keyed by
        // (file, model, prompt, fields) and says nothing about why the last pass
        // failed, so without this every attempt after the first re-derives the same
        // outcome from the same bytes and the backoff buys nothing.
        bypassCache: job.attempts > 0,
      });
      this.completed += 1;
    } catch (e) {
      const err = toEngineError(e);
      const attempts = job.attempts + 1;

      // Cancelled on purpose. The pipeline already recorded why on the document.
      if (this.cancelled.has(job.documentId)) {
        this.cancelled.delete(job.documentId);
        this.failed += 1;
        return;
      }

      if (err.info.halt) {
        // Never burn the rest of the batch against a broken engine. The document
        // that tripped it goes back to queued so Resume picks it up unchanged.
        updateDocument(job.documentId, { status: 'queued', updatedAt: nowIso() });
        this.jobs.unshift({ ...job, attempts, notBefore: 0 });
        this.requeueRest();
        this.haltWith(err);
        return;
      }

      if (autoRetryable(err, attempts)) {
        updateDocument(job.documentId, { status: 'queued', updatedAt: nowIso() });
        this.jobs.push({
          documentId: job.documentId,
          attempts,
          notBefore: Date.now() + backoffMs(attempts, err.info.retryAfterMs ?? null),
        });
      } else {
        // The pipeline already recorded status='failed' and the error code.
        this.failed += 1;
      }
    } finally {
      this.controllers.delete(job.documentId);
      this.cancelled.delete(job.documentId);
      this.running.delete(job.documentId);
      this.emit();
      void this.pump();
    }
  }

  /** Everything still waiting stays waiting, and says so in the database. */
  private requeueRest(): void {
    for (const job of this.jobs) {
      updateDocument(job.documentId, { status: 'queued', updatedAt: nowIso() });
    }
  }

  private haltWith(e: unknown): void {
    const err = toEngineError(e);
    this.halt = err.toJSON();
    this.paused = true;
    // The engine handle may itself be stale (key changed, CLI logged out).
    this.engine = null;
    this.emit();
  }
}

/** One queue per process. The app is a single local process by design. */
export const extractionQueue = new ExtractionQueue();
