/**
 * Server startup.
 *
 * Next calls register() once per server process, before the first request is
 * handled. It is the only hook that runs without a page being opened, which is
 * exactly what the watched folder needs: Bonnie drops PDFs into Drive during the
 * day and may not open the tracker until the evening. A watcher that started on
 * first render would be a watcher that only works while she is already looking.
 *
 * Two things happen here, and both exist because they must happen with nobody
 * watching: work stranded by the last process is put back on the queue, and the
 * folder starts being read. Neither is allowed to fail startup.
 */

export async function register(): Promise<void> {
  // instrumentation.ts is loaded for the edge runtime too, where node:fs does not
  // exist. The import is dynamic and guarded so the edge bundle never contains it.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  // `next build` bootstraps a server to prerender pages. Starting a poll loop
  // there would hold the build open and touch the real database on a machine that
  // is only compiling.
  if (process.env['NEXT_PHASE'] === 'phase-production-build') return;

  try {
    const { extractionQueue } = await import('@/lib/extraction/queue');
    // `extracting` is a claim the LAST process made, not a result, and nothing
    // clears it when that process is killed or crashes. recover() has existed
    // since the queue was written and was never called from anywhere, so a
    // document caught mid-flight sat in the Inbox looking busy forever -- three
    // of them were still stranded twenty-five minutes after a restart. This is
    // the only hook that runs before the first request, which is the whole point:
    // she must not have to open a screen for her own work to resume.
    extractionQueue.recover();
  } catch (e) {
    // Same reasoning as the watcher below: startup never fails over a document.
    const { log } = await import('@/lib/logger');
    log.error('instrumentation.recover.failed', { error: e });
  }

  try {
    const { folderWatcher } = await import('@/lib/watch');
    // Idempotent, and the watcher itself survives hot-reload on globalThis.
    folderWatcher().start();
  } catch (e) {
    // Startup must never fail because of a folder. The watcher reports its own
    // problems through GET /api/watch; this catch is for the import itself.
    const { log } = await import('@/lib/logger');
    log.error('instrumentation.watch.failed', { error: e });
  }
}
