'use client';

import { forwardRef, useCallback, useLayoutEffect, useRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import { FIELD_INPUT, FIELD_SHELL, fieldRing } from './Input';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
  /** Grows with content instead of scrolling. For addresses and notice blocks. */
  autoResize?: boolean;
  maxRows?: number;
  wrapperClassName?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    invalid = false,
    mono = false,
    autoResize = false,
    maxRows = 8,
    rows = 3,
    className,
    wrapperClassName,
    disabled,
    onChange,
    ...rest
  },
  ref,
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const fit = useCallback(() => {
    const el = localRef.current;
    if (!el || !autoResize) return;
    el.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 16;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * maxRows + 12)}px`;
  }, [autoResize, maxRows]);

  useLayoutEffect(fit, [fit, rest.value]);

  return (
    <div
      className={clsx(
        FIELD_SHELL,
        'items-start px-[8px] py-[5px] text-body',
        fieldRing(invalid, disabled === true),
        wrapperClassName,
      )}
    >
      <textarea
        ref={setRefs}
        rows={rows}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          onChange?.(event);
          fit();
        }}
        className={clsx(
          FIELD_INPUT,
          'resize-none leading-[var(--lh-body)]',
          mono && 'font-mono',
          className,
        )}
        {...rest}
      />
    </div>
  );
});
