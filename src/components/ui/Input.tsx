'use client';

import { forwardRef, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';
import { ClipboardText, Eye, EyeSlash, X } from '@phosphor-icons/react';
import { IconButton } from './IconButton';
import { Spinner } from './Spinner';

export type FieldSize = 'sm' | 'md' | 'lg';

export const FIELD_SIZE: Record<FieldSize, string> = {
  sm: 'h-[24px] px-[6px] text-callout',
  md: 'h-[30px] px-[8px] text-body',
  lg: 'h-[36px] px-[10px] text-body',
};

/**
 * Shared shell for Input / TextArea / Select so the three read as one control
 * family. Exported from here rather than duplicated: the focus halo geometry is
 * the single most noticeable thing if it drifts between them.
 */
export const FIELD_SHELL =
  'sq relative flex items-center gap-[6px] rounded-control bg-sunken transition-shadow duration-[var(--dur-fast)] ease-fast';

/**
 * The rest ring is INSET so a field can sit flush against a hairline without a
 * half-pixel halo bleeding over it; the focus halo stays outset because it is
 * meant to be seen leaving the control.
 */
export const FIELD_RING_OK =
  'shadow-[inset_0_0_0_0.5px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3.5px_color-mix(in_srgb,var(--accent)_32%,transparent)]';

export const FIELD_RING_BAD =
  'shadow-[inset_0_0_0_1px_var(--bad)] focus-within:shadow-[inset_0_0_0_1px_var(--bad),0_0_0_3.5px_color-mix(in_srgb,var(--bad)_28%,transparent)]';

/** Disabled: the ring drops to the separator weight so the control reads as off. */
export const FIELD_RING_OFF = 'shadow-[inset_0_0_0_0.5px_var(--separator)]';

/** Picks the ring. One helper so all four field components agree. */
export function fieldRing(invalid: boolean, disabled: boolean): string {
  if (disabled) return FIELD_RING_OFF;
  return invalid ? FIELD_RING_BAD : FIELD_RING_OK;
}

/**
 * The bare field inside the shell. focus-visible:shadow-none suppresses the
 * global focus halo on the inner element - the halo belongs on the shell.
 */
export const FIELD_INPUT =
  'h-full min-w-0 flex-1 bg-transparent text-label outline-none placeholder:text-label-tertiary focus-visible:shadow-none disabled:text-[var(--text-disabled)]';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: FieldSize;
  invalid?: boolean;
  mono?: boolean;
  /** Leading glyph, e.g. <MagnifyingGlass size={14} />. */
  icon?: ReactNode;
  trailing?: ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    invalid = false,
    mono = false,
    icon,
    trailing,
    className,
    wrapperClassName,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <div
      className={clsx(
        FIELD_SHELL,
        FIELD_SIZE[size],
        fieldRing(invalid, disabled === true),
        wrapperClassName,
      )}
    >
      {icon !== undefined && (
        <span className="grid shrink-0 place-items-center text-label-tertiary">{icon}</span>
      )}
      <input
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={clsx(FIELD_INPUT, mono && 'font-mono', className)}
        {...rest}
      />
      {trailing !== undefined && <span className="flex shrink-0 items-center">{trailing}</span>}
    </div>
  );
});

export type SecretValidity = 'unknown' | 'checking' | 'valid' | 'invalid';

export interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Drives the validity dot. 'unknown' shows nothing. */
  validity?: SecretValidity;
  size?: FieldSize;
  id?: string;
  name?: string;
  label?: string;
  className?: string;
}

/**
 * The API key field. Masked by default, with Reveal / Paste / Clear as explicit
 * affordances - a key is pasted far more often than it is typed, and Bonnie
 * should never have to trust that a dot-string is the right length.
 */
export function SecretInput({
  value,
  onChange,
  placeholder = 'sk-ant-...',
  validity = 'unknown',
  size = 'md',
  id,
  name,
  label = 'API key',
  className,
}: SecretInputProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const inputRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(false);

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim().length > 0) onChange(text.trim());
    } catch {
      // Clipboard read can be denied. Put the caret where she can press Cmd-V
      // rather than reporting a permission error she cannot act on.
      inputRef.current?.focus();
    }
  }

  return (
    <div
      className={clsx(
        FIELD_SHELL,
        FIELD_SIZE[size],
        fieldRing(validity === 'invalid', false),
        'pr-[3px]',
        className,
      )}
    >
      <input
        ref={inputRef}
        id={inputId}
        name={name}
        aria-label={label}
        type={revealed ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(FIELD_INPUT, 'font-mono tracking-[0.02em]')}
      />

      {validity === 'checking' && <Spinner size={12} />}
      {(validity === 'valid' || validity === 'invalid') && (
        <span
          role="img"
          aria-label={validity === 'valid' ? 'Key accepted' : 'Key rejected'}
          className={clsx(
            'block size-[7px] shrink-0 rounded-full',
            'shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--label)_14%,transparent)]',
            validity === 'valid' ? 'bg-ok' : 'bg-bad',
          )}
        />
      )}

      <IconButton
        size="sm"
        label={revealed ? 'Hide key' : 'Reveal key'}
        onClick={() => setRevealed((r) => !r)}
      >
        {revealed ? <EyeSlash size={14} /> : <Eye size={14} />}
      </IconButton>
      <IconButton size="sm" label="Paste from clipboard" onClick={paste}>
        <ClipboardText size={14} />
      </IconButton>
      {value.length > 0 && (
        <IconButton size="sm" label="Clear key" onClick={() => onChange('')}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
