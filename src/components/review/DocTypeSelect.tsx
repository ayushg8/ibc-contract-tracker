'use client';

import { CaretDown } from '@phosphor-icons/react';
import {
  Button,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@/components/ui';
import { DOC_TYPES, DOC_TYPE_LABELS } from '@/lib/fields';
import type { DocType } from '@/lib/db/types';

export interface DocTypeSelectProps {
  value: DocType | null;
  onChange: (value: DocType) => void;
  disabled?: boolean;
  busy?: boolean;
}

/** Which export sheet the record lands on, so it is a decision, not a label. */
export function DocTypeSelect({ value, onChange, disabled = false, busy = false }: DocTypeSelectProps) {
  const label = value === null ? 'Set document type' : DOC_TYPE_LABELS[value];

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          size="sm"
          loading={busy}
          disabled={disabled}
          trailingIcon={<CaretDown size={10} weight="bold" />}
        >
          {label}
        </Button>
      </MenuTrigger>
      <MenuContent align="start" minWidth={200}>
        <MenuRadioGroup
          value={value ?? ''}
          onValueChange={(next) => {
            const picked = DOC_TYPES.find((t) => t === next);
            if (picked !== undefined && picked !== value) onChange(picked);
          }}
        >
          {DOC_TYPES.map((type) => (
            <MenuRadioItem key={type} value={type}>
              {DOC_TYPE_LABELS[type]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
