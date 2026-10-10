/**
 * Pevqori UI kit — barrel. Import from here: `import { Button, DataTable, useHotkeys } from '../../ui/index.ts'`.
 * Styles: import 'src/renderer/styles/index.css' once at the app entry.
 */

// Foundations
export { Icon } from './Icon.tsx';
export type { IconProps, IconSize } from './Icon.tsx';
export { ICONS, ICON_NAMES, isIconName } from './icons.ts';
export type { IconName, IconDef } from './icons.ts';
export { Portal } from './Portal.tsx';
export type { PortalProps } from './Portal.tsx';
export { VisuallyHidden } from './VisuallyHidden.tsx';
export type { VisuallyHiddenProps } from './VisuallyHidden.tsx';
export { HotkeyScope, Hotkeys } from './HotkeyScope.tsx';
export type { HotkeyScopeProps, HotkeysProps } from './HotkeyScope.tsx';
export { applyTheme, applyDensity, resolvedTheme, onSystemThemeChange, prefersReducedMotion } from './theme.ts';
export type { ThemePreference } from './theme.ts';
export type { Tone, StatusTone, ControlSize, Density, Align, Space } from './types.ts';
export { spaceVar } from './types.ts';
export { cx } from './lib/cx.ts';

// Actions & feedback
export { Button, ButtonGroup } from './Button.tsx';
export type { ButtonProps, ButtonVariant, ButtonGroupProps } from './Button.tsx';
export { IconButton } from './IconButton.tsx';
export type { IconButtonProps } from './IconButton.tsx';
export { Kbd } from './Kbd.tsx';
export type { KbdProps } from './Kbd.tsx';
export { Badge, Tag } from './Badge.tsx';
export type { BadgeProps, TagProps } from './Badge.tsx';
export { Spinner } from './Spinner.tsx';
export type { SpinnerProps } from './Spinner.tsx';
export { Skeleton } from './Skeleton.tsx';
export type { SkeletonProps } from './Skeleton.tsx';
export { ProgressBar } from './ProgressBar.tsx';
export type { ProgressBarProps } from './ProgressBar.tsx';
export { Divider } from './Divider.tsx';
export type { DividerProps } from './Divider.tsx';
export { Tooltip } from './Tooltip.tsx';
export type { TooltipProps } from './Tooltip.tsx';
export { Popover } from './Popover.tsx';
export type { PopoverProps, Placement } from './Popover.tsx';
export { Menu, DropdownMenu } from './Menu.tsx';
export type { MenuProps, MenuItem, MenuEntry, MenuSeparator, MenuSectionLabel, DropdownMenuProps, MenuTriggerProps } from './Menu.tsx';

// Forms
export { Field, FieldGroup } from './Field.tsx';
export type { FieldProps, FieldGroupProps } from './Field.tsx';
export { FieldContext, useFieldControl } from './fieldContext.ts';
export type { FieldContextValue } from './fieldContext.ts';
export { TextInput } from './TextInput.tsx';
export type { TextInputProps } from './TextInput.tsx';
export { TextArea } from './TextArea.tsx';
export type { TextAreaProps } from './TextArea.tsx';
export { PasswordInput } from './PasswordInput.tsx';
export type { PasswordInputProps } from './PasswordInput.tsx';
export { Checkbox } from './Checkbox.tsx';
export type { CheckboxProps } from './Checkbox.tsx';
export { Switch } from './Switch.tsx';
export type { SwitchProps } from './Switch.tsx';
export { RadioGroup } from './RadioGroup.tsx';
export type { RadioGroupProps, RadioOption } from './RadioGroup.tsx';
export { Select } from './Select.tsx';
export type { SelectProps, SelectOption, SelectOptionGroup } from './Select.tsx';
export { SegmentedControl } from './SegmentedControl.tsx';
export type { SegmentedControlProps, SegmentOption } from './SegmentedControl.tsx';
export { NumberInput } from './NumberInput.tsx';
export type { NumberInputProps } from './NumberInput.tsx';
export { AmountInput } from './AmountInput.tsx';
export type { AmountInputProps, DrCrSide } from './AmountInput.tsx';
export { PercentInput } from './PercentInput.tsx';
export type { PercentInputProps } from './PercentInput.tsx';
export { QuantityInput } from './QuantityInput.tsx';
export type { QuantityInputProps } from './QuantityInput.tsx';
export { DateInput } from './DateInput.tsx';
export type { DateInputProps } from './DateInput.tsx';
export { Calendar } from './Calendar.tsx';
export type { CalendarProps } from './Calendar.tsx';
export { Combobox, Picker } from './Combobox.tsx';
export type { ComboboxProps, ComboboxRenderState } from './Combobox.tsx';

// Overlays
export { Modal, Dialog } from './Modal.tsx';
export type { ModalProps, ModalSize } from './Modal.tsx';
export { ConfirmDialog } from './ConfirmDialog.tsx';
export type { ConfirmDialogProps } from './ConfirmDialog.tsx';
export { Drawer } from './Drawer.tsx';
export type { DrawerProps } from './Drawer.tsx';
export { ToastProvider, useToast } from './Toast.tsx';
export type { ToastApi, ToastOptions, ToastAction, ToastProviderProps } from './Toast.tsx';

// Data display
export { DataTable } from './DataTable.tsx';
export type { DataTableProps, Column, ColumnKind, CellContext, SortState, FooterRow } from './DataTable.tsx';
export { KeyValueList } from './KeyValueList.tsx';
export type { KeyValueListProps, KeyValueItem } from './KeyValueList.tsx';
export { Card } from './Card.tsx';
export type { CardProps } from './Card.tsx';
export { KpiCard, Stat } from './KpiCard.tsx';
export type { KpiCardProps, KpiDelta, StatProps } from './KpiCard.tsx';
export { Sparkline } from './Sparkline.tsx';
export type { SparklineProps } from './Sparkline.tsx';
export { BarChart } from './BarChart.tsx';
export type { BarChartProps, ChartSeries, ChartSlot, ValueFormat } from './BarChart.tsx';
export { LineChart } from './LineChart.tsx';
export type { LineChartProps } from './LineChart.tsx';
export { Tabs } from './Tabs.tsx';
export type { TabsProps, TabItem } from './Tabs.tsx';
export { Breadcrumbs } from './Breadcrumbs.tsx';
export type { BreadcrumbsProps, BreadcrumbItem } from './Breadcrumbs.tsx';
export { EmptyState } from './EmptyState.tsx';
export type { EmptyStateProps } from './EmptyState.tsx';
export { Banner, Callout } from './Banner.tsx';
export type { BannerProps, CalloutProps } from './Banner.tsx';
export { Pagination } from './Pagination.tsx';
export type { PaginationProps } from './Pagination.tsx';

// Layout
export { Stack } from './Stack.tsx';
export type { StackProps, LayoutTag } from './Stack.tsx';
export { Inline, Cluster } from './Inline.tsx';
export type { InlineProps, ClusterProps } from './Inline.tsx';
export { Grid } from './Grid.tsx';
export type { GridProps } from './Grid.tsx';
export { Spacer } from './Spacer.tsx';
export type { SpacerProps } from './Spacer.tsx';
export { Panel } from './Panel.tsx';
export type { PanelProps } from './Panel.tsx';
export { PageHeader } from './PageHeader.tsx';
export type { PageHeaderProps } from './PageHeader.tsx';
export { Toolbar } from './Toolbar.tsx';
export type { ToolbarProps } from './Toolbar.tsx';
export { SplitPane } from './SplitPane.tsx';
export type { SplitPaneProps } from './SplitPane.tsx';
export { ScrollArea } from './ScrollArea.tsx';
export type { ScrollAreaProps } from './ScrollArea.tsx';
export { ActionRail } from './ActionRail.tsx';
export type { ActionRailProps, ActionRailItem } from './ActionRail.tsx';
export { CommandBar } from './CommandBar.tsx';
export type { CommandBarProps } from './CommandBar.tsx';
export { ReportFrame } from './ReportFrame.tsx';
export type { ReportFrameProps, ReportPeriod } from './ReportFrame.tsx';

// Hooks
export * from './hooks/index.ts';

// Pure helpers useful to screens
export { evaluateExpression, looksLikeExpression } from './lib/expr.ts';
export type { ExprResult } from './lib/expr.ts';
export { parseHotkey, parseHotkeyList, hotkeyParts, matchesHotkey, toAriaKeyShortcut, describeEvent } from './lib/hotkeys.ts';
export type { ParsedHotkey } from './lib/hotkeys.ts';
export { filterAndRank, matchFields, splitHighlight, highlightRanges } from './lib/match.ts';
export type { MatchResult, MatchFields, RankedItem, Segment, Range } from './lib/match.ts';
export { parseAmountText, parseNumberText, formatAmountText, formatNumberText, applySide, sideOf } from './lib/numeric.ts';
export { computeTreeInfo, visibleTreeIndices, parentIndices, keysUpToLevel } from './lib/tree.ts';
export { weekdayName, monthMatrix } from './lib/calendar.ts';
export { getEnterTargets, getTabbables, isEditableTarget, focusElement } from './lib/dom.ts';
