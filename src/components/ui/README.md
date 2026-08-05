# UI kit

Pure presentation. Nothing here imports `@/lib/db` or `@/lib/providers`; the only
lib import in the whole directory is the `Confidence` type from `@/lib/fields`.

Import from the barrel: `import { Button, Row, useToast } from '@/components/ui';`

## The two-plane rule — read this before composing anything

Light is the primary theme, and depth comes from **canvas vs surface plus a
hairline**, never from stacking rounded boxes.

- `--canvas` (`bg-canvas`) is the recessed plane: window, sidebar, the area
  behind content, and the body of a `Sheet surface="paper"`.
- `--surface` (`bg-surface`, or the `surface` utility) is the raised plane. **One
  per region.** That is what `<Card>` is.
- `--surface-sunken` (`bg-sunken`) is for wells only: inputs, code blocks, the
  `Segmented` track, `Kbd` chips.

If you are about to put a bordered or shadowed element inside another bordered or
shadowed element, stop. `Card` will `console.warn` at you in dev, naming the
nesting — that warning is the whole reason this kit was rebuilt. The replacements
are `SectionHeader rule` (a hairline that fences a region without a box),
`DataList` (a definition list with hairlines and no box per row), and whitespace.

## Other house rules the screens must not break

- **Glass is chrome only.** `Glass`, `Sheet` (default), `Menu`, `Tooltip` and
  `Toast` are glass. Never wrap a data table or PDF text in `Glass` — use `Card`,
  which is opaque by design. That is an Apple HIG prohibition, not a preference.
- **Evidence is quieter than the answer.** `Quote` is `--t-callout` on a 2.8%
  wash. If a quote looks heavier than the value it supports, the field is wrong,
  not the quote. Use `density="inline"` anywhere a screen shows many at once.
- **Springs, not durations.** `SPRING_SNAPPY` (damping 21.36) for anything the
  user drives; `SPRING_SMOOTH` (damping 25.13) when overshoot would lie, e.g. a
  progress bar. Never `visualDuration` — it zeroes entry velocity so an
  interrupted animation restarts instead of redirecting. Never bouncy (17.59).
- **Two line weights.** `--separator` (`hairline-b/t/r`, `bg-separator`) divides
  rows *inside* a surface. `--border` outlines a surface *against* the canvas.
  They are not interchangeable.
- **Colour overrides go on children, not `className`.** Tailwind emits
  `.text-accent` before `.text-label`, so a `className="text-bad"` on a
  component that sets its own colour loses. `Button variant="ghost"` and
  `MenuItem` are colour-neutral on purpose so overrides work; everywhere else,
  colour the child node.
- **Every rounded surface pairs `sq` with a `rounded-*` token.** `--r-control`
  must never exceed half the element's shorter side (that is why `Kbd` chips are
  22px and `Checkbox` uses `rounded-sm`).
- Icons: `@phosphor-icons/react`, `weight="regular"`, flipping to `weight="fill"`
  on selection. `Segmented` and `TabsTrigger` do that flip for you — pass the
  icon *component*, not an element.
- `Sheet` scales the page behind it to 0.995 if the shell puts `data-app-shell`
  on its outermost element. Without the attribute the sheet still works.
- Mount `<ToastProvider>` once at the app root. `<TooltipProvider>` is optional
  (each `Tooltip` carries its own) but sharing one gives a single skip-delay
  window across a toolbar. `<GlassPrewarm />` at the root moves the one-time
  filter-graph build onto an invisible pixel.

## Material and motion

| Export | Notes |
| --- | --- |
| `SPRING_SNAPPY`, `SPRING_SMOOTH` | `Transition` objects. Defined in `Glass.tsx` so components can import them without cycling through the barrel. |
| `Glass` | `as?` (div/aside/header/footer/section/nav/ul/form) · `depth?: 1 \| 2` · `radius?: 'control' \| 'row' \| 'card' \| 'panel' \| 'none'` (default panel) · plus all div props. depth 2 = tint + rim, no second blur. |
| `GlassPrewarm` | No props. Mount once at the root. |
| `RADIUS_CLASS` | `Radius` → Tailwind radius class, for components that take a radius prop. |

## Controls

| Component | Props |
| --- | --- |
| `Button` | `variant?: 'primary' \| 'secondary' \| 'ghost' \| 'destructive'` (default secondary — **white with a hairline, not a grey fill**) · `size?: 'sm'(24) \| 'md'(30) \| 'lg'(36)` · `loading?` holds width and swaps the label for a Spinner · `icon?`, `trailingIcon?: ReactNode` · `fullWidth?` (avoid — a full-width button is an AI-slop tell) · `disabled?` uses `--text-disabled`, never opacity · all `motion.button` props. Presses to 0.97 on a snappy spring. |
| `BUTTON_VARIANT` | The variant → class map, shared by `Button` and `IconButton` so the two families cannot drift. |
| `IconButton` | `label: string` (required — becomes aria-label and the title) · `variant?` (default ghost) · `size?` · `loading?` · `active?` for a toggled look · children = the icon. |
| `Segmented<T>` | `options: {value: T; label: string; icon?: Icon; disabled?}[]` · `value: T` · `onChange(value)` · `ariaLabel: string` · `size?: 'sm'(26) \| 'md'(30)` · `fullWidth?`. Sunken track, `bg-surface` + shadow-1 thumb (the macOS pattern), radiogroup semantics, full arrow/Home/End keys, thumb slides via `layoutId`. |
| `Switch` | `checked?` / `defaultChecked?` / `onCheckedChange?` · `disabled?` · `size?: 'sm'(30x18) \| 'md'(38x22)` · `label?` (wires a `<label>`) or `ariaLabel?` · `id?`, `name?`. |
| `Slider` | `value?` / `defaultValue?` (single number) · `onValueChange?` · `onValueCommit?` (persist here, not on change) · `min? max? step?` · `disabled?` · `ariaLabel: string` (required) · `ticks?: number`. |
| `Checkbox` | `checked?` / `defaultChecked?`: `boolean \| 'indeterminate'` · `onCheckedChange?` · `disabled?` · `label?: ReactNode` or `ariaLabel?` · `id?`, `name?`. |

## Fields

Field shells are the **sunken** plane with an inset `--border` hairline; the focus
halo is the only outset ring.

| Component | Props |
| --- | --- |
| `Input` | `size?: 'sm' \| 'md' \| 'lg'` · `invalid?` · `mono?` · `icon?`, `trailing?: ReactNode` · `wrapperClassName?` · all input props except `size`. Focus halo lives on the shell, not the input. |
| `SecretInput` | `value: string` · `onChange(value)` · `placeholder?` · `validity?: 'unknown' \| 'checking' \| 'valid' \| 'invalid'` (drives the dot) · `size?` · `label?` (accessible name, default "API key") · `id?`, `name?`. Masked by default with Reveal / Paste / Clear. |
| `TextArea` | `invalid?` · `mono?` · `autoResize?` with `maxRows?` (default 8) · `rows?` · `wrapperClassName?` · all textarea props. |
| `Select` | `options: {value; label; disabled?}[]` · `value` · `onChange` · `size?` · `invalid?` · `placeholder?` (disabled first option) · `wrapperClassName?`. Native popup button. |
| `fieldRing(invalid, disabled)` | Picks `FIELD_RING_BAD` / `FIELD_RING_OFF` / `FIELD_RING_OK`. Use it rather than composing rings by hand — two `shadow-[…]` utilities on one element have undefined order. |
| `FIELD_SHELL`, `FIELD_SIZE`, `FIELD_RING_OK`, `FIELD_RING_BAD`, `FIELD_RING_OFF`, `FIELD_INPUT` | Class-string constants, for a one-off control that must match the field family. |

## Surfaces

| Component | Props |
| --- | --- |
| `Card` | `elevation?: 'surface' \| 'sunken' \| 'none'` (default surface) — **`surface` is the one raised container for a region; `sunken` is a well; `none` draws nothing and only groups.** Nesting two `surface` cards `console.warn`s in dev, naming the offender · `as?: 'div' \| 'section' \| 'ul' \| 'li' \| 'form'` · `padding?: 'none' \| 'sm' \| 'md' \| 'lg'` (default md) · `elevated?` swaps shadow-1 for shadow-e2 (popovers only) · `divided?` puts a 0.5px separator between direct children. Opaque — this is the content layer. |
| `Sheet` | `open`, `onOpenChange` · `title: string` (always required for a11y) · `hideTitle?` · `description?` · `width?` (default 640) · `surface?: 'glass' \| 'paper'` — `paper` puts the body on the **canvas**, so the one `Card` inside it reads as raised · `toolbar?`, `footer?: ReactNode`. Slides from the right on a snappy spring, 9% scrim, Escape and click-away close, focus returns to the trigger. |
| `Row` | `as?: 'div' \| 'li'` · `size?: 'sm'(32) \| 'md'(44)` · `selected?` (a 10% accent wash with accent text — never a saturated blue bar) · `unemphasized?` (inactive-pane selection, `--neutral-quiet`) · `disabled?` · `leading?`, `trailing?`, `title?`, `subtitle?` — or pass `children` to take over the middle · `onClick?` adds button semantics plus Enter/Space. Emits `data-selected` and `aria-current`. |
| `SectionHeader` | `title: string` · `trailing?: ReactNode` · `rule?: boolean` draws a hairline from the end of the label to the right edge — **this is the grouping device that replaces a box** · `as?: 'h2' \| 'h3' \| 'div'`. Uses the `eyebrow` utility. |
| `DataList` | `items: { label, value, hint?, mono?, tone? }[]` where `tone?: 'default' \| 'quiet' \| 'ok' \| 'warn' \| 'bad' \| 'accent'` · `labelWidth?: number` (px tab stop, default 132) · `className?`. A real `<dl>`: labels left in `--label-secondary` on one tab stop, values right in `--label`, hairline between rows, **no box per row**. This is what a record is made of. |
| `StatTile` | `label: string` (eyebrow) · `value: ReactNode` (26px semibold, tabular) · `supporting?: ReactNode` · `tone?: 'default' \| 'ok' \| 'warn' \| 'bad' \| 'accent'` · `icon?: Icon` · `className?`. Draws **no** background or border on purpose — sit two of them side by side inside the region's one `Card`, divided by a hairline. Used for the two clocks. |

## Navigation and overlays

| Component | Props |
| --- | --- |
| `Tabs` | `value?` / `defaultValue?` / `onValueChange?` · `variant?: 'toolbar' \| 'underline'` (toolbar = the Settings icon bar). |
| `TabsList` | `ariaLabel: string`. |
| `TabsTrigger` | `value: string` · `label: string` · `icon?: Icon` (regular → fill on selection) · `disabled?`. |
| `TabsContent` | `value: string`. |
| `Tooltip` | `content: ReactNode` · `keys?: readonly string[]` renders a `Kbd` after the text · `side?`, `align?` · `delayDuration?` (500) · `disabled?` skips it entirely · children = the trigger (cloned via asChild, so it must forward a ref). |
| `TooltipProvider` | `delayDuration?`, `skipDelayDuration?`. Optional; see house rules. |
| `Menu` / `MenuTrigger` | Radix `DropdownMenu.Root` / `.Trigger` re-exported. Use `MenuTrigger asChild` around a `Button`. |
| `MenuContent` | `align?`, `side?`, `minWidth?` (180). Glass, spring-in, no exit animation on purpose. |
| `MenuItem` | `onSelect?` · `icon?: Icon` · `keys?: readonly string[]` · `disabled?` · `destructive?`. |
| `MenuCheckboxItem` | `checked`, `onCheckedChange?`, `disabled?`. |
| `MenuRadioGroup` / `MenuRadioItem` | Radix radio group; item takes `value`, `disabled?`. |
| `MenuSeparator`, `MenuLabel` | No props / `children`. `MenuLabel` uses the `eyebrow` utility. |
| `ToastProvider` | `children`. Renders the bottom-centre stack (max 3, offset, hover pauses the countdown). |
| `useToast()` | `toast({ title, description?, tone?: 'default' \| 'ok' \| 'warn' \| 'bad', duration? (10s; 0 pins), onUndo?, action? }) => id` and `dismiss(id)`. |

## Indicators

| Component | Props |
| --- | --- |
| `Dot` | `confidence: 'high' \| 'medium' \| 'none'` (the `Confidence` type from `@/lib/fields`) · `label?` overrides the accessible name · `muted?: boolean` drops it to low emphasis. 7px, static — never animate it. **On an approved record, prefer dropping the dot entirely: confidence on a settled value is noise, and a red dot on a field that is correctly absent is a lie.** |
| `Pill` | `tone?: 'neutral' \| 'quiet' \| 'accent' \| 'ok' \| 'warn' \| 'bad'` · `size?: 'sm'(16) \| 'md'(20)` · `leading?: ReactNode` · `mono?` · span props. Wash background with the solid status colour as text (`bg-ok-quiet text-ok`); `quiet` is the hairline-only variant. Capsule, tabular numerals. |
| `StatusPill` | `status: 'active' \| 'expiring' \| 'expired' \| 'unknown'` · `days?` (read when expiring → "63 days") · `label?` overrides the text, e.g. for the confidentiality clock · `size?: 'sm' \| 'md'`. Expired maps to `neutral`, not `quiet` — the old grey-on-grey chip was invisible on white. |
| `Spinner` | `size?` (14) · `label?` · `className?` sets the colour via `currentColor`. Eight stepped spokes. |
| `ProgressBar` | `value?` 0..1 · `indeterminate?` · `size?: 'sm'(4) \| 'md'(6)` · `tone?: 'accent' \| 'ok' \| 'warn' \| 'bad'` · `label?`. |

## Content

| Component | Props |
| --- | --- |
| `Quote` | `text: string` (verbatim, never paraphrased) · `page?` renders `p.N` as a footnote-size tertiary marker **inline at the end of the text**, not a chip row · `verified?` (default true; false switches the rule to `--warn` and appends a quiet "unverified") · `onClick?` for jump-to-PDF · `density?: 'inline' \| 'block'` (default block) — `inline` is one clamped line that opens on hover or focus, and is what the detail sheet uses so sixteen quotes are not a wall · `clamp?: 2 \| 3 \| 4 \| 5 \| false` (default 3, block density only). 12px `--quote-text` on a 2.8% wash with a 2px `--quote-rule`. |
| `EmptyState` | `icon?: Icon` · `title: string` · `body?: string` (one line) · `action?: ReactNode`. |
| `Kbd` | `keys: readonly string[]` (e.g. `['⌘','F']`) · `variant?: 'bare' \| 'chip'` (bare matches a macOS menu). |
