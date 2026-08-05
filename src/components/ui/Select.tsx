'use client';

import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import clsx from 'clsx';
import { CaretUpDown } from '@phosphor-icons/react';
import { FIELD_SHELL, FIELD_SIZE, fieldRing } from './Input';
import type { FieldSize } from './Input';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'children'> {
  options: readonly SelectOption<T>[];
  size?: FieldSize;
  invalid?: boolean;
  /** Rendered as a disabled first option when the value is empty. */
  placeholder?: string;
  wrapperClassName?: string;
}

/**
 * The native popup button. A native <select> is the right call for a form
 * control: it inherits keyboard, type-ahead and VoiceOver behaviour that a
 * hand-rolled listbox has to re-earn. Menu (DropdownMenu) covers command menus.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    options,
    size = 'md',
    invalid = false,
    placeholder,
    className,
    wrapperClassName,
    disabled,
    value,
    ...rest
  },
  ref,
) {
  return (
    <div
      className={clsx(
        FIELD_SHELL,
        FIELD_SIZE[size],
        'pr-[4px]',
        fieldRing(invalid, disabled === true),
        wrapperClassName,
      )}
    >
      <select
        ref={ref}
        disabled={disabled}
        value={value}
        aria-invalid={invalid || undefined}
        className={clsx(
          'h-full min-w-0 flex-1 appearance-none bg-transparent pr-[2px] text-label outline-none focus-visible:shadow-none disabled:text-[var(--text-disabled)]',
          className,
        )}
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <CaretUpDown
        size={12}
        weight="bold"
        aria-hidden
        className="pointer-events-none shrink-0 text-label-secondary"
      />
    </div>
  );
});
