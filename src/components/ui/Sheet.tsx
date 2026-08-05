'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'motion/react';
import { X } from '@phosphor-icons/react';
import { IconButton } from './IconButton';
import { SPRING_SNAPPY } from './Glass';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Always required for the accessibility tree; hideTitle only hides it visually. */
  title: string;
  hideTitle?: boolean;
  description?: string;
  width?: number;
  /** 'paper' when the sheet body holds document text or a data table. */
  surface?: 'glass' | 'paper';
  /** Controls parked at the right of the header, before the close button. */
  toolbar?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  description,
  width = 640,
  surface = 'glass',
  toolbar,
  footer,
  className,
  children,
}: SheetProps) {
  /**
   * Apple's modality depth cue: the page behind a sheet recedes very slightly.
   * The shell opts in by putting data-app-shell on its outermost element; if it
   * is absent the sheet still works, it just loses the depth.
   */
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-app-shell]');
    if (!shell) return;
    shell.style.transition = 'transform var(--dur-snappy) var(--ease-snappy)';
    shell.style.transform = open ? 'scale(0.995)' : '';
    return () => {
      shell.style.transform = '';
    };
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                // 18%, not 9%. On light both planes are near-white, so a scrim
                // that barely tints leaves the table behind fully readable and
                // competing with the sheet for attention.
                className="fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--label)_18%,transparent)]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>

            {/* Radix links aria-describedby to Dialog.Description automatically and
                warns when there is none; passing the attribute explicitly as
                undefined is the documented way to say "there is no description". */}
            <Dialog.Content
              asChild
              forceMount
              {...(description === undefined ? { 'aria-describedby': undefined } : {})}
            >
              <motion.div
                className={clsx(
                  'sq fixed inset-y-0 right-0 z-40 flex max-w-full flex-col overflow-hidden rounded-l-panel shadow-e3',
                  // A hairline down the leading edge. Light-mode shadows are
                  // deliberately faint, which is right for elevation but leaves
                  // two white planes touching with nothing between them.
                  'border-l-[0.5px] border-border',
                  // 'paper' lands on the CANVAS, not on white: the sheet body is
                  // the recessed plane, and the one surface inside it is what
                  // reads as raised.
                  surface === 'glass' ? 'glass' : 'bg-canvas',
                  className,
                )}
                style={{ width }}
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={SPRING_SNAPPY}
              >
                <header className="flex h-[48px] shrink-0 items-center gap-[8px] px-[12px] hairline-b">
                  <Dialog.Title
                    className={clsx(
                      'min-w-0 flex-1 truncate text-title-3 font-semibold text-label',
                      hideTitle && 'sr-only',
                    )}
                  >
                    {title}
                  </Dialog.Title>
                  {toolbar}
                  <Dialog.Close asChild>
                    <IconButton label="Close" size="sm">
                      <X size={14} weight="bold" />
                    </IconButton>
                  </Dialog.Close>
                </header>

                {description !== undefined && (
                  <Dialog.Description className="shrink-0 px-[16px] pt-[10px] text-callout text-label-secondary">
                    {description}
                  </Dialog.Description>
                )}

                <div className="scroll-edge min-h-0 flex-1 overflow-y-auto px-[16px] py-[12px]">
                  {children}
                </div>

                {footer !== undefined && (
                  <footer className="flex shrink-0 items-center justify-end gap-[8px] px-[12px] py-[10px] hairline-t">
                    {footer}
                  </footer>
                )}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
