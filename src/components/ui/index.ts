/**
 * The UI kit. Pure presentation: nothing here touches @/lib/db or
 * @/lib/providers, and nothing here knows what a contract is.
 *
 * See ./README.md for the one-line prop summary of every component.
 */

/* -- material + motion -- */
export { Glass, GlassPrewarm, SPRING_SNAPPY, SPRING_SMOOTH, RADIUS_CLASS } from './Glass';
export type { GlassProps, GlassTag, Radius } from './Glass';

/* -- controls -- */
export { Button, BUTTON_VARIANT } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { IconButton } from './IconButton';
export type { IconButtonProps } from './IconButton';

export { Segmented } from './Segmented';
export type { SegmentedOption, SegmentedProps, SegmentedSize } from './Segmented';

export { Switch } from './Switch';
export type { SwitchProps, SwitchSize } from './Switch';

export { Slider } from './Slider';
export type { SliderProps } from './Slider';

export { Checkbox } from './Checkbox';
export type { CheckboxProps, CheckedState } from './Checkbox';

/* -- fields -- */
export {
  Input,
  SecretInput,
  fieldRing,
  FIELD_INPUT,
  FIELD_RING_BAD,
  FIELD_RING_OFF,
  FIELD_RING_OK,
  FIELD_SHELL,
  FIELD_SIZE,
} from './Input';
export type { FieldSize, InputProps, SecretInputProps, SecretValidity } from './Input';

export { TextArea } from './TextArea';
export type { TextAreaProps } from './TextArea';

export { Select } from './Select';
export type { SelectOption, SelectProps } from './Select';

/* -- surfaces -- */
export { Card } from './Card';
export type { CardElevation, CardPadding, CardProps } from './Card';

export { Sheet } from './Sheet';
export type { SheetProps } from './Sheet';

export { Row } from './Row';
export type { RowProps, RowSize } from './Row';

export { SectionHeader } from './SectionHeader';
export type { SectionHeaderProps } from './SectionHeader';

export { DataList } from './DataList';
export type { DataListItem, DataListProps, DataListTone } from './DataList';

export { StatTile } from './StatTile';
export type { StatTileProps, StatTone } from './StatTile';

/* -- navigation + overlays -- */
export { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs';
export type {
  TabsContentProps,
  TabsListProps,
  TabsProps,
  TabsTriggerProps,
  TabsVariant,
} from './Tabs';

export { Tooltip, TooltipProvider } from './Tooltip';
export type { TooltipProps, TooltipProviderProps } from './Tooltip';

export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from './Menu';
export type {
  MenuCheckboxItemProps,
  MenuContentProps,
  MenuItemProps,
  MenuRadioItemProps,
} from './Menu';

export { ToastProvider, useToast } from './Toast';
export type { ToastAction, ToastOptions, ToastTone } from './Toast';

/* -- indicators -- */
export { Dot } from './Dot';
export type { DotProps } from './Dot';

export { Pill } from './Pill';
export type { PillProps, PillSize, PillTone } from './Pill';

export { StatusPill } from './StatusPill';
export type { AgreementStatus, StatusPillProps } from './StatusPill';

export { Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';

export { ProgressBar } from './ProgressBar';
export type { ProgressBarProps, ProgressTone } from './ProgressBar';

/* -- content -- */
export { Quote } from './Quote';
export type { QuoteDensity, QuoteProps } from './Quote';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { Kbd } from './Kbd';
export type { KbdProps } from './Kbd';
