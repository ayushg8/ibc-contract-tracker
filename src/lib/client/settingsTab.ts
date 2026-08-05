/**
 * `?tab=` off the URL and back into the Settings tab id union.
 *
 * This is the whole reason the folder remedies -- the ones that fire when her
 * watch folder is on a drive that is no longer attached -- used to open the
 * model picker instead: nothing on the Settings screen ever read the query
 * string, so `/settings?tab=folders` and `/settings` were the same link.
 *
 * It was then a hand-written switch, whose comment claimed it was "checked
 * against the union at compile time, so a tab that is added cannot silently fall
 * through here". That was not true, and it was not true in the direction that
 * mattered: a switch on a `string` narrows what it matches, but nothing forces a
 * new union member to appear as a case. `updates` was added, no case was added,
 * and `/settings?tab=updates` quietly opened the Engine tab -- the same silent
 * fall-through the comment promised could not happen.
 *
 * So the list is a value now, and `assertCovers` makes the two directions a
 * compile error instead of a promise: an id in the union that is missing here,
 * or an id here that is not in the union, fails `tsc`.
 */

import type { SettingsTabId } from '@/components/settings/SettingsTabs';

const TAB_IDS = [
  'engine',
  'folders',
  'export',
  'data',
  'appearance',
  'updates',
  'diagnostics',
] as const;

type Listed = (typeof TAB_IDS)[number];

/** `true` only when the two types are mutually assignable; otherwise `never`. */
type AssertCovers<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/*
 * Load-bearing, despite looking like a no-op. If TAB_IDS and SettingsTabId ever
 * drift, `true` is not assignable to `never` and the build stops here rather than
 * in a deep link nobody tests by hand.
 */
const _covers: AssertCovers<Listed, SettingsTabId> = true;
void _covers;

export function toSettingsTab(value: string | null | undefined): SettingsTabId | null {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value)
    ? (value as SettingsTabId)
    : null;
}
