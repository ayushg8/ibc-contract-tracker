'use client';

import { useEffect, useRef, useState } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';

import { IconButton, Input, Kbd } from '@/components/ui';

/**
 * Short enough that the table feels like it is filtering as she types, long
 * enough that a five-letter party name is one query and not five.
 */
const DEBOUNCE_MS = 120;

/** Escaped so the source stays ASCII; Kbd prints the glyph macOS prints. */
const CMD_KEYS = ['\u2318', 'F'] as const;

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Tag this field as the screen's search target. AppFrame's Cmd+F looks for
   * [data-app-search] and focuses it, so the shortcut is not bound twice.
   */
  shortcut?: boolean;
}

export function SearchBar({
  value,
  onChange,
  placeholder = 'Search parties, contracts, signers...',
  shortcut = true,
}: SearchBarProps) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  // The field is controlled by its own draft so typing never waits on a fetch,
  // but an external reset (the "Clear search" button in the empty state) still
  // has to land here.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);

  return (
    <Input
      ref={input}
      size="lg"
      type="search"
      aria-label="Search contracts"
      {...(shortcut ? { 'data-app-search': '' } : {})}
      spellCheck={false}
      autoComplete="off"
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (draft.length > 0) setDraft('');
        else input.current?.blur();
      }}
      icon={<MagnifyingGlass size={15} />}
      // The search input's native clear button is hidden by the appearance reset,
      // so the affordance has to be ours.
      className="[&::-webkit-search-cancel-button]:hidden"
      trailing={
        draft.length > 0 ? (
          <IconButton size="sm" label="Clear search" onClick={() => setDraft('')}>
            <X size={13} weight="bold" />
          </IconButton>
        ) : shortcut && !focused ? (
          <Kbd keys={CMD_KEYS} />
        ) : undefined
      }
    />
  );
}
