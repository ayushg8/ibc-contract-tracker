'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { DragEvent, ReactNode } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { FolderOpen, Tray } from '@phosphor-icons/react';
import { Button, SPRING_SNAPPY } from '@/components/ui';
import { readWatch, type WatchStatus } from '@/lib/client/watch';

/** Slow on purpose: this line is reassurance, not telemetry. */
const WATCH_POLL_MS = 6_000;

export interface DropZoneHandle {
  /** The file-picker fallback. The page's "Add PDFs" button calls this. */
  openPicker: () => void;
}

export interface DropZoneProps {
  onFiles: (files: File[]) => void;
  /**
   * 'panel'   the large dashed target that IS the empty state.
   * 'overlay' an invisible catcher wrapped around the grid, so a drop anywhere
   *           on the page works without a second visible target.
   */
  mode: 'panel' | 'overlay';
  watchFolder?: string | null;
  onChangeFolder?: () => void;
  /** Called with the names of dropped files that were not PDFs. */
  onRejected?: (names: string[]) => void;
  children?: ReactNode;
  className?: string;
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/**
 * Asks the server what the watcher is doing, rather than inferring it from the
 * fact that a path is stored in settings.
 *
 * That inference is what the old copy made: it printed "Watching <folder>"
 * whenever a folder had been chosen, at a time when nothing in the tree read the
 * setting at all. A folder that is configured but unreachable -- an ejected drive,
 * a Drive account signed out -- would still have read "Watching". This line may
 * only say the word when the answer comes from the thing doing the watching.
 *
 * Only mounted in panel mode, which is the empty Inbox: the overlay renders no
 * copy, so there is nothing there to be wrong.
 */
function useWatchStatus(active: boolean): WatchStatus | null {
  const [status, setStatus] = useState<WatchStatus | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const read = () => {
      void readWatch().then((next) => {
        if (alive && next !== null) setStatus(next);
      });
    };
    read();
    const timer = window.setInterval(read, WATCH_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active]);

  return status;
}

export const DropZone = forwardRef<DropZoneHandle, DropZoneProps>(function DropZone(
  { onFiles, mode, watchFolder, onChangeFolder, onRejected, children, className },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child element, so a boolean flickers.
  const depth = useRef(0);
  const watch = useWatchStatus(mode === 'panel');

  useImperativeHandle(ref, () => ({ openPicker: () => input.current?.click() }), []);

  const take = useCallback(
    (list: FileList | null) => {
      const all = Array.from(list ?? []);
      const pdfs = all.filter(isPdf);
      const rejected = all.filter((f) => !isPdf(f)).map((f) => f.name);
      if (rejected.length > 0) onRejected?.(rejected);
      if (pdfs.length > 0) onFiles(pdfs);
    },
    [onFiles, onRejected],
  );

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    // Without this the browser navigates to the file instead of giving it to us.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      take(e.dataTransfer.files);
    },
    [take],
  );

  const picker = (
    <input
      ref={input}
      type="file"
      accept="application/pdf,.pdf"
      multiple
      className="hidden"
      onChange={(e) => {
        take(e.target.files);
        // Reset so re-picking the same file still fires a change event.
        e.target.value = '';
      }}
    />
  );

  if (mode === 'overlay') {
    return (
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={clsx('relative', className)}
      >
        {children}
        {picker}
        <AnimatePresence>
          {dragging && (
            <motion.div
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={SPRING_SNAPPY}
              className="sq pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-panel border-[1.5px] border-accent bg-accent-quiet"
            >
              <span className="flex items-center gap-[8px] text-title-3 font-medium text-label">
                <Tray size={20} weight="fill" className="text-accent" />
                Drop to add
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={clsx('flex flex-col items-center gap-[12px]', className)}
    >
      {picker}
      <motion.div
        animate={{ scale: dragging ? 1.01 : 1 }}
        transition={SPRING_SNAPPY}
        className={clsx(
          // Dashed on the canvas, not a glass panel: this is the content layer,
          // and an empty target should read as an outline, not as a card.
          'sq flex w-full max-w-[560px] flex-col items-center justify-center gap-[10px] rounded-panel border-[1.5px] px-[24px] py-[56px] transition-colors duration-[var(--dur-fast)] ease-fast',
          dragging
            ? 'border-solid border-accent bg-accent-quiet'
            : 'border-dashed border-border-strong bg-canvas',
        )}
      >
        <Tray
          size={32}
          weight={dragging ? 'fill' : 'regular'}
          className={dragging ? 'text-accent' : 'text-label-tertiary'}
        />
        <p className="text-title-2 font-medium text-label">Drop NDAs here</p>
        <p className="text-callout text-label-secondary">
          PDFs only. They are copied into the tracker, never moved.
        </p>
        <Button className="mt-[4px]" onClick={() => input.current?.click()}>
          Choose files
        </Button>
      </motion.div>

      <p className="flex flex-wrap items-center justify-center gap-[6px] text-callout text-label-secondary">
        <FolderOpen size={14} className="text-label-tertiary" />
        <WatchCopy watch={watch} watchFolder={watchFolder ?? null} />
        {onChangeFolder && (
          <>
            <span aria-hidden className="text-label-quaternary">
              {'\u00B7'}
            </span>
            <Button variant="ghost" size="sm" onClick={onChangeFolder}>
              <span className="text-accent">Change</span>
            </Button>
          </>
        )}
      </p>

      {children}
    </div>
  );
});

/**
 * The four honest things this line can say.
 *
 * `watchFolder` is the settings value and is only a fallback for the folder's
 * name while the first request is in flight. It never decides the verb: the
 * server does, because the server is what is actually reading the folder.
 */
function WatchCopy({
  watch,
  watchFolder,
}: {
  watch: WatchStatus | null;
  watchFolder: string | null;
}) {
  const folder = watch?.folder ?? watchFolder;

  if (folder === null) return <>No watched folder yet</>;

  // Still asking. Name the folder, claim nothing about it.
  if (watch === null) {
    return (
      <>
        Folder <span className="font-mono text-label">{folder}</span>
      </>
    );
  }

  if (watch.error !== null) {
    return (
      <>
        <span className="font-mono text-label">{folder}</span>
        <span className="text-bad">{watch.error.message}</span>
      </>
    );
  }

  if (!watch.running) {
    return (
      <>
        <span className="font-mono text-label">{folder}</span>
        <span className="text-warn">is not being checked</span>
      </>
    );
  }

  return (
    <>
      Watching <span className="font-mono text-label">{folder}</span>
    </>
  );
}
