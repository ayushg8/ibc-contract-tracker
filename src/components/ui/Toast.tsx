'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from './Button';
import { SPRING_SNAPPY } from './Glass';

/** Undo is the pattern, not a confirmation dialog. Ten seconds is Apple's window. */
const DEFAULT_DURATION = 10_000;
const MAX_VISIBLE = 3;

export type ToastTone = 'default' | 'ok' | 'warn' | 'bad';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms. 0 pins the toast until it is dismissed. */
  duration?: number;
  /** Shown as a plain "Undo" button. Dismisses the toast when pressed. */
  onUndo?: () => void;
  action?: ToastAction;
}

interface ToastRecord extends ToastOptions {
  id: string;
}

interface ToastApi {
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const TONE_RULE: Record<ToastTone, string | null> = {
  default: null,
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, { id: ReturnType<typeof setTimeout>; endsAt: number }>());
  const counter = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer.id);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setItems((current) => current.filter((item) => item.id !== id));
    },
    [clearTimer],
  );

  const arm = useCallback(
    (id: string, ms: number) => {
      if (ms <= 0) return;
      clearTimer(id);
      timers.current.set(id, {
        id: setTimeout(() => dismiss(id), ms),
        endsAt: Date.now() + ms,
      });
    },
    [clearTimer, dismiss],
  );

  const toast = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      const id = `t${counter.current}`;
      setItems((current) => [...current, { ...options, id }].slice(-MAX_VISIBLE));
      arm(id, options.duration ?? DEFAULT_DURATION);
      return id;
    },
    [arm],
  );

  // Pause the countdown while the pointer is over the stack: a toast that
  // vanishes as you reach for Undo is worse than no undo at all.
  const remaining = useRef(new Map<string, number>());

  const pauseAll = useCallback(() => {
    const now = Date.now();
    for (const [id, timer] of timers.current) {
      remaining.current.set(id, Math.max(0, timer.endsAt - now));
      clearTimeout(timer.id);
    }
    timers.current.clear();
  }, []);

  const resumeAll = useCallback(() => {
    for (const [id, ms] of remaining.current) {
      arm(id, ms);
    }
    remaining.current.clear();
  }, [arm]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer.id);
      timers.current.clear();
    },
    [],
  );

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-[24px] left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-[8px]"
      >
        <AnimatePresence initial={false}>
          {items.map((item) => {
            const rule = TONE_RULE[item.tone ?? 'default'];
            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: 28, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.97 }}
                transition={SPRING_SNAPPY}
                onPointerEnter={pauseAll}
                onPointerLeave={resumeAll}
                className="glass sq pointer-events-auto relative flex min-w-[280px] max-w-[420px] items-center gap-[12px] overflow-hidden rounded-card px-[14px] py-[10px]"
              >
                {rule !== null && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-0 h-full w-[2px]"
                    style={{ background: rule }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-label">{item.title}</p>
                  {item.description !== undefined && (
                    <p className="truncate text-callout text-label-secondary">
                      {item.description}
                    </p>
                  )}
                </div>
                {item.action !== undefined && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-accent"
                    onClick={() => {
                      item.action?.onClick();
                      dismiss(item.id);
                    }}
                  >
                    {item.action.label}
                  </Button>
                )}
                {item.onUndo !== undefined && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-accent"
                    onClick={() => {
                      item.onUndo?.();
                      dismiss(item.id);
                    }}
                  >
                    Undo
                  </Button>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
