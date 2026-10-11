# Pevqori UI kit (`src/renderer/ui`)

The design system for Pevqori: tokens, base styles and ~60 React 19 components/hooks for a
**calm, dense-but-readable, keyboard-complete** accounting app. Everything a screen needs is here —
screens should not write their own CSS for controls, colours or spacing.

```ts
import { Button, DataTable, Field, Combobox, useHotkeys } from '../../ui/index.ts';
```

Load the styles **once** at the renderer entry: `import '../styles/index.css';`
(tokens → base → components).

---

## 1. Principles

1. **Keyboard first, mouse friendly.** Every control is reachable and operable by keyboard; Enter
   advances through forms, Esc goes back. **Keys are learned, not printed (2.1):** a button's key is
   in its tooltip ("Print · Alt+P", `keyTip`), in `aria-keyshortcuts`, shown as plain text on
   `:focus-visible` and while Ctrl is held (`html[data-keys]`); menus print keys as plain right-aligned
   text; boxed key caps appear only in the F1 card (and the opt-in shortcut bar).
2. **Dense but calm.** 13px base text, 36px controls (28px compact), one flat surface (2.1: cards,
   panels and tables draw no border or fill — hairlines and space separate), one interactive colour
   (indigo). Five sizes 12/13/14/18/24, two weights 400/600, radii 4/8. Data is loud; chrome is quiet.
3. **Numbers are sacred.** Amounts are right-aligned, tabular, Indian-grouped (`12,34,567.00`).
   In reports a sign is never a bare minus — use `Dr`/`Cr` (`kind: 'drcr'`).
4. **Colour is never the only signal.** Selection has a fill (and an inset bar while the grid has
   focus), deltas have ▲/▼ and a sign, status badges carry text, the Dr/Cr suffix is muted text.
5. **Accessible by construction.** WCAG AA contrast is unit-tested (`lib/contrast.test.ts`), focus
   rings are always visible on keyboard focus, every overlay manages focus and `aria-*`.
6. **No HTML strings.** Nothing in the kit uses `dangerouslySetInnerHTML`; highlighting is done
   with text segments.

---

## 2. Tokens (`styles/tokens.css`)

Never use palette tokens (`--indigo-600`) in screens — use **semantic** tokens.

| Group | Tokens |
|---|---|
| Surfaces | `--surface-0` app canvas = `--surface-1` cards/inputs/tables (2.1: one flat surface, `#ffffff` / `#15181f`) · `--surface-2` hover/pressed fill only (no longer for table headers, toolbars or totals) · `--surface-3` strong fill · `--surface-overlay` dialogs/popovers · `--surface-sunken` print-preview canvas · `--backdrop` |
| Text | `--text-primary` `--text-secondary` `--text-muted` `--text-placeholder` `--text-disabled` `--text-inverse` `--text-link` |
| Borders | `--border-subtle` (dividers) `--border-default` `--border-strong` (control outlines, ≥3:1) |
| Brand | `--brand` (the one interactive colour: indigo-600 light / indigo-400 dark — primary buttons, focus ring, links, selected-row bar, checked controls) `--brand-hover` `--brand-active` `--on-brand` (white in light, near-black in dark) `--brand-text` `--brand-subtle` · accent (saffron: brand mark, “not today” date flag, Get-started progress only) `--accent` `--accent-text` `--accent-subtle` |
| Interaction | `--focus-ring` (= brand) `--selection-bg` `--row-hover` `--row-selected` (active-row fill, always) `--row-selected-indicator` (the 2px bar, only while the grid has focus) `--ghost-hover` `--control-fill` |
| Accounting | `--positive` `--negative` (KPIs only). 2.1: the Dr/Cr suffix is `--text-muted` (`--dr`/`--cr` are gone, as are `--row-zebra`/`--row-group`: group rows are 600 weight, no fill) |
| Tones | `--{neutral,brand,accent,success,warning,danger,info}-{bg,text,solid,icon}` + `--on-{tone}-solid` (brand/accent text: `--brand-tone-text`, `--accent-tone-text`) |
| Charts | `--chart-1…5` (fixed order: indigo, saffron, aqua, gold, magenta — validated for CVD/contrast in both themes), `--chart-other`, `--chart-grid`, `--chart-axis` |
| Type | `--font-sans` (Segoe UI Variable Text…) `--font-display` `--font-mono` · `--fs-11/12/13/14/18/24` (`--fs-11` only for boxed `Kbd` chips and the three chart text selectors; `cssUsage.test.ts` enforces it; `--fs-16/20/32` retire when their last module reader goes) · roles `--text-caption` 12 · `--text-small` 12 · `--text-base` 13 (tables, menus, context runs) · `--text-body` 14 (inputs, pickers, the voucher grid) · `--text-subtitle` 14, always 600 (section, panel, card titles) · `--text-title` 18 / 600 (h1, dialog titles, stat values) · `--text-heading` 24 (Home figures) · `--text-display` (retired: = 24) · `--lh-tight/snug/normal/relaxed` · weights: `--fw-regular` 400, `--fw-semibold` 600 (`--fw-medium` = 400 and `--fw-bold` = 600 in 2.1: two weights). No upper-case captions |
| Space | `--space-0 … --space-16` (`spaceVar(step)` builds `var(--space-N)` for every `Space` step; a test keeps each one defined) (4px base: 1=4, 2=8, 3=12, 4=16, 6=24, 8=32; new CSS uses 4/8/12/16/24/32) plus `--space-0-5`, `--space-1-5`, `--space-2-5` |
| Radii | `--radius-xs` 2 · `--radius-sm` 4 · `--radius-md` 4 (controls) · `--radius-lg` 8 · `--radius-xl` 8 (menus, popovers, dialogs, drawers) · `--radius-full` (avatar, switch, focus dot only — no pills) |
| Elevation | roles: `--elev-popover` (menus, popovers, listboxes, tooltips, toasts) · `--elev-dialog` (modals, drawers); scale `--shadow-1/2/3` (per theme). Cards, panels and tables are flat (no border, no shadow). Use the roles in components. |
| Z-index | `--z-sticky` 10 · `--z-rail` 20 · `--z-header` 30 · `--z-drawer` 300 · `--z-modal` 400 · `--z-popover` 500 · `--z-tooltip` 600 · `--z-toast` 700 |
| Motion | `--dur-fast` 100ms · `--dur-base` 160ms · `--dur-slow` 240ms · `--dur-tooltip-delay` · `--ease-standard/enter` (all durations → 0 under `prefers-reduced-motion`) |
| Density | `--control-h` 36/28 · `--control-h-sm` 28/24 (menu rows, text tabs) · `--hit-min` 44/32 · `--row-h` 32/26 · `--option-h` · `--cell-px` · `--form-gap` |
| Layout | `--rail-width` 188 · `--field-label-width` 168 · `--indent-step` 16 · `--modal-sm/md/lg/xl` · `--drawer-sm/md/lg` · `--toast-inset-right/bottom` |

**Theme:** `<html data-theme="light|dark">` always holds the *resolved* theme; the user's choice
(`light | dark | system`) is in `data-theme-pref`. `applyTheme('system')` resolves the OS setting in
JS and follows OS changes live (`resolveTheme(pref, osDark)` is the pure rule), so tokens.css has
exactly one light block (`:root, [data-theme="light"]`) and one dark block — no
`prefers-color-scheme` copy. Tokens identical in both themes (solid tone fills, accent, chart 4/5)
are declared once in `:root`. `index.html` carries `data-theme="system"` only until preferences
bootstrap; until then the page lets the theme-matched native window colour show (no flash).
**Density:** `data-density="comfortable|compact"` on `<html>` or any subtree (e.g. one table).
Helpers: `applyTheme(t)`, `applyDensity(d)`, `resolveTheme(pref, osDark)`, `getComputedTheme()`
(alias `resolvedTheme()`), `onSystemThemeChange(cb)`.

Inline `style` is only for geometry (widths, positions). Custom properties in inline style must be
cast: `style={{ '--level': 2 } as CSSProperties}` (the real `@types/react` rejects unknown keys).

---

## 3. CSS conventions

- Prefix `bx-`, BEM-ish: `bx-block`, `bx-block__element`, `bx-block--modifier`; state classes
  `is-active`, `is-selected`, `is-invalid`, `is-disabled`, `is-open`, `has-*`.
- Lists: the base reset (`:where(ol[class], ul[class])`, zero specificity) removes padding and markers from
  classed lists; a component that wants bullets or numbers sets `padding-left` and `list-style` itself.
- Utilities in base.css: `.bx-num` (tabular figures), `.bx-mono`, `.bx-sr-only`, `.bx-truncate`,
  `.bx-muted`; hide from print with the `data-print-hide` attribute. The Dr/Cr suffix is muted text
  (`DataTable` `drcr` cells).
- Retiring tokens (2.1): a lane that leaves a semantic token without a reader lists it in
  `RETIRING_TOKENS` (`styles/cssUsage.test.ts`, one sorted line with the reason); the integrator deletes
  those tokens at the next wave merge and empties the list.
- **No dead CSS** (`styles/cssUsage.test.ts`): every class a stylesheet defines must be used by
  renderer code, literally or through a prefix declared in its `DYNAMIC_CLASSES` list (with the
  template literal that builds it). Delete unused rules rather than allowlisting them.
- **Weight budget** (`styles/cssBudget.test.ts`): all renderer CSS ≤ 180 KB, `components.css` ≤ 67.5 KB,
  `tokens.css` ≤ 16 KB (source bytes). Reuse a token or component rule before adding a copy.
- Overlays render in portals into `document.body` and carry `data-bx-overlay`. Outside-click and
  focus-trap logic treat *later* overlays as nested (a picker inside a dialog is "inside").
- Mouse hit areas are expanded with an invisible `::after` to `--hit-min` (44px comfortable, 32px
  compact) without changing layout.
- Focus: `:focus-visible` draws a 2px `--focus-ring` outline. Inputs draw the ring on the wrapper
  (border + 1px shadow) so focusing never shifts layout.

---

## 4. Components

All components: named exports, typed props, `className` passthrough, React 19 `ref` prop.

### Foundations

| Component | Key props |
|---|---|
| `Icon` | `name: IconName` (84 icons, `ICON_NAMES`), `size?: 'xs'\|'sm'\|'md'\|'lg'\|'xl'\|number`, `label?` (else aria-hidden) |
| `Kbd` | `keys?: 'Ctrl+A'` (lists `'Ctrl+G, Ctrl+K'` render "or"), `size?`, `tone?: 'default'\|'inverse'\|'subtle'`, or children. 2.1: `subtle` renders **one plain text run** (`bx-kbd--plain`, "Ctrl+F8") for menus, tooltips and the button key reveal; `default` (boxed chips) is for the F1 card only |
| `Portal` | `container?` |
| `VisuallyHidden` | `focusable?` |
| `HotkeyScope` | `active?`, `blocking?` — see §6 |

Icons: home search plus minus edit trash save print download upload export external filter
calendar chevron-left/right/up/down chevrons-up-down close check alert info help check-circle
x-circle settings sliders user users lock unlock key shield building bank wallet rupee percent gst
receipt invoice file folder cart box warehouse truck chart line-chart pie book ledger journal
refresh sync link copy eye eye-off more more-vertical menu logout sun moon keyboard arrow-up/down/
left/right drill undo redo star clock database sort sort-asc sort-desc bell grid list columns
panel-right mail phone tag layers hash calculator scale dot command zap.

### Actions & feedback

| Component | Key props |
|---|---|
| `Button` | `variant?: 'primary'\|'secondary'(default)\|'ghost'\|'danger'\|'link'`, `size?: 'sm'\|'md'`, `loading?` (keeps width & focus, aria-busy), `icon?`, `iconRight?`, `shortcut?: 'Ctrl+A'` (aria-keyshortcuts; the key is hidden at rest and shown as plain text on `:focus-visible` and under `html[data-keys]` (hold Ctrl); default `title` "Label · Key" when the label is text; *register the key yourself*), `fullWidth?`; `type` defaults to `"button"`. One filled (`primary`) button per screen, and it means "commit" |
| `IconButton` | `icon`, **`aria-label` (required)**, `variant?: 'ghost'\|'secondary'\|'primary'\|'danger'`, `size?`, `tooltip?: boolean\|node` (default shows the label), `shortcut?`, `pressed?` (toggle), `loading?` |
| `ButtonGroup` | `aria-label`; `attached?` accepted (2.1 groups are always spaced) |
| `Badge` | `tone?: Tone`, `variant?: 'subtle'\|'solid'\|'outline'` (2.1: every variant draws the subtle look), `size?`, `icon?`, `dot?` — for exceptions only |
| `Tag` | `tone?`, `icon?`, `onRemove?` (Backspace/Delete on the × removes), `removeLabel?` |
| `Spinner` | `size?: 'xs'\|'sm'\|'md'\|'lg'`, `label?` ('Loading'), `decorative?` |
| `Skeleton` | `variant?: 'text'\|'rect'\|'circle'`, `width?`, `height?`, `lines?` |
| `ProgressBar` | `value?` (omit = indeterminate), `max?`, `label?`, `showValue?`, `tone?` |
| `Divider` | `orientation?`, `label?`, `spacing?`, `strong?` |
| `Tooltip` | `content`, `children` (one focusable element), `placement?`, `describeChild?` — CSS-positioned, shows on hover/keyboard focus after 400 ms, Esc dismisses. `keyTip(label, key)` → "Print · Alt+P" (the label alone for a keyless action) |
| `Popover` | `open`, `onClose`, `anchorRef`, `placement?`, `matchWidth?`, `role?: 'dialog'\|'none'`, `initialFocus?`, `width?`, `flush?` — portal, flips/shifts, Esc/outside click/Tab-out close, blocks app hotkeys |
| `Menu` | `items: MenuEntry[]` (`{key,label,icon?,shortcut?,description?,disabled?,danger?,checked?,radio?,keepOpen?,onSelect?}` / `{type:'separator'}` / `{type:'label'}`), `onAction?`, `onClose?`, `autoFocus?`. 2.1: rows 28 px (24 compact), no icons (`icon` accepted, ignored) — the ✓ column exists only when the menu has checkable items; keys plain right-aligned text, none for `''`; `checked` → `menuitemcheckbox` (`radio` → `menuitemradio`); `keepOpen` items leave the menu open (multi-select); section labels sentence case |
| `DropdownMenu` | `items`, `onAction?`, `label?`, `icon?`, `variant?`, `aria-label?`, `placement?`, `renderTrigger?(props)` |

```tsx
<Button variant="primary" shortcut="Ctrl+A" loading={saving} onClick={save}>Accept</Button>
<IconButton icon="print" aria-label="Print" shortcut="Alt+P" onClick={print} />
<DropdownMenu label="Export" icon="export" items={[
  { key: 'xlsx', label: 'Excel (.xlsx)', icon: 'file', onSelect: toExcel },
  { key: 'pdf', label: 'PDF', icon: 'file', shortcut: 'Alt+E' },
]} />
```

### Forms

Wrap controls in `Field`; kit controls read the Field context (id, `aria-describedby`,
`aria-invalid`, `required`, `disabled`) automatically.

| Component | Key props |
|---|---|
| `Field` | `label`, `hint?`, `error?` (replaces hint), `required?` (*), `optional?`, `layout?: 'stack'\|'inline'` ("Label : value"), `labelWidth?`, `hideLabel?`, `labelAction?`, `htmlFor?`. 2.1: the hint shows only while the field has focus (never unmounted, `aria-describedby` intact); errors, feedback carrying an icon (`OkHint`, "✓ Valid GSTIN · …") and hints passed with `hintApplies` (a condition true right now: "Books are locked up to …", "Future date — Ctrl+T") always show; inline layout puts the hint/error in a trailing column, so nothing jumps |
| `FieldGroup` | `legend?`, `description?`, `columns?: 1–4` |
| `TextInput` | all input attrs + `size?`, `invalid?`, `leadingIcon?`, `prefix?`, `suffix?`, `trailing?` (buttons; skipped by Enter-advance), `align?`, `mono?`, `uppercase?` (GSTIN/PAN), `selectOnFocus?`, `onValueChange?`, `quiet?` (2.1: no border/fill until hover or focus; with `readOnly` it reads as plain text) |
| `TextArea` | `autoGrow?`, `maxRows?`, `showCount?`, `onValueChange?` (Ctrl+Enter advances in forms) |
| `PasswordInput` | show/hide button (Alt+F8), Caps-Lock hint |
| `Checkbox` | `checked`, `onChange(checked)`, `label?`, `description?`, `indeterminate?` |
| `Switch` | `checked`, `onChange(checked)`, `label?`, `showState?` ("Yes/No" text, default on), Y/N keys |
| `RadioGroup<V>` | `label`, `options: {value,label,description?,disabled?}[]`, `value`, `onChange`, `orientation?`, `error?`, `hint?` |
| `Select<V>` | native; `options` (or groups) / children, `value`, `onChange(v)`, `placeholder?` — short fixed lists only |
| `SegmentedControl<V>` | `options`, `value`, `onChange`, **`aria-label`**, `size?`, `fullWidth?` — radiogroup, ←/→ select; 2.1: text tabs (selected 600 + 2 px brand underline, no pill or track) |
| `NumberInput` | `value: number\|null`, `onChange`, `decimals?` (0), `min?`, `max?`, `step?` (↑/↓, Shift ×10), `grouping?`, `expressions?` (true), `blankZero?`, `onCommit?`, `onValidationChange?` |
| `AmountInput` | `value: Paise\|null`, `onChange`, `drcr?` (chip + `d`/`c` keys; sign = side), `defaultSide?`, `onSideChange?`, `allowNegative?`, `blankZero?`, `symbol?` (₹), `min?`, `max?` |
| `PercentInput` | NumberInput with `%`, 2 decimals, min 0 |
| `QuantityInput` | NumberInput with `unit?` suffix, `decimals?` per unit, min 0 |
| `DateInput` | `value: ISO\|null`, `onChange`, `referenceDate?` (working date), `minDate?`, `maxDate?`, `format?` (DD-MMM-YYYY), `showWeekday?`, `weekStartsOn?`, `calendarButton?` (shown on hover/focus only), `quiet?` |
| `Calendar` | `value`, `onSelect`, `referenceDate?`, `minDate?`, `maxDate?`, `weekStartsOn?`, `autoFocus?`, `onCancel?` |
| `Combobox<T>` / `Picker` | see below |

**Numeric entry behaviour (Number/Amount/Percent/Quantity):** right-aligned tabular digits; focus
selects all; every keystroke that parses calls `onChange` live; blur/Enter normalises (round, clamp)
and re-formats with Indian grouping. Text that doesn't parse is **kept** and flagged (red border,
alert icon, SR description, `onValidationChange(message)`) — never silently discarded. Expressions
are evaluated by a safe parser (no eval): `1200*3`, `(450+50)/2`, `2x3`, `1,000+18%` (=1180),
`1000*18%` (=180).

**DateInput shorthand** (resolved on blur/Enter against `referenceDate`): `5` · `5-10` · `5/10/26`
· `05102026` · `5 oct` · `oct 5 2026` · `t` (today) · `y` (yesterday). `+`/`-` step a committed date
by a day. Alt+↓ opens the calendar (arrows, PgUp/PgDn months, Shift+PgUp/PgDn years, Home/End,
T = working date, Enter selects, Esc closes).

```tsx
<form ref={useEnterAdvance({ onComplete: askAccept })}>
  <Field label="Date" layout="inline" required>
    <DateInput value={date} onChange={setDate} referenceDate={workingDate} />
  </Field>
  <Field label="Amount" layout="inline" error={errors.amount}>
    <AmountInput value={amount} onChange={setAmount} drcr />
  </Field>
</form>
```

#### Combobox / Picker

```tsx
<Field label="Party A/c name" required>
  <Picker<Ledger>
    items={ledgers}                       // memoise; or loadItems={(q, signal) => api(...)}
    getKey={(l) => String(l.id)}
    getLabel={(l) => l.name}
    getAlias={(l) => l.alias}
    getKeywords={(l) => [l.gstin ?? '', l.groupName]}
    groupBy={(l) => l.groupName}
    rightMeta={(l) => formatDrCr(l.closingBalance)}
    value={party}
    onChange={setParty}
    onCreate={(name) => openLedgerCreate({ name })}   // "+ Create '…'" row and Alt+C
  />
</Field>
```

Props: `items | loadItems(query, signal)` (+`debounceMs` 150), `getKey`, `getLabel`, `getAlias?`,
`getKeywords?`, `renderItem?(item, {active, selected, query, highlightedLabel})`, `rightMeta?`,
`groupBy?`, `isItemDisabled?`, `filter?(items, q)`, `value: T|null`, `onChange`, `onCommit?`,
`onCreate?`, `createLabel?`, `placeholder?`, `disabled?`, `readOnly?`, `required?`, `invalid?`,
`clearable?` (true), `emptyText?`, `maxVisible?` (8), `openOnFocus?` (true), `showHints?` (false in
2.1: no key footer — the keys are in F1; the "+ Create …  Alt+C" row still prints its key),
`listMinWidth?`, `size?`. 2.1: the chevron shows on hover/focus only; group captions are sentence case.

Behaviour: opens on focus/typing; the best match is highlighted as you type (exact > prefix >
word-start > infix; alias, keywords and word initials like "sbi" also match; matches highlighted);
↑/↓/PgUp/PgDn/Home/End move; **Enter** selects — with `onCommit` the key is consumed (you move
focus), without it Enter continues to `useEnterAdvance` → next field; **Tab** selects the
highlighted item and moves on; **Esc** closes (a second Esc bubbles to the screen/dialog); Alt+↓
opens, Alt+↑ closes, **Alt+C** calls `onCreate(typedText)`. Leaving the field: empty text clears
(when `clearable`), an exact label/alias match is selected, otherwise the previous value is kept —
if there was none the typed text stays visible and the field is flagged (never loses input).
Lists > 200 rows are virtualised. ARIA combobox + listbox with `aria-activedescendant`; result count
is announced. Getter props are read when `items`/query change — pass a memoised `items` array.

### Overlays

| Component | Key props |
|---|---|
| `Modal` / `Dialog` | `open`, `onClose`, `title` (18/600), `description?` (only when it carries a rule), `size?: 'sm'\|'md'\|'lg'\|'xl'\|'full'`, `footer?` (right-aligned: Cancel, then the primary), `footerStart?`, `dismissible?` (Esc/×/backdrop; default true), `closeOnBackdrop?` (false), `initialFocusRef?`, `role?: 'dialog'\|'alertdialog'`, `flush?`, `hideClose?` — radius 8, padding 24, no footer band |
| `ConfirmDialog` | `open`, `title`, `message?`, `confirmLabel?`, `cancelLabel?`, `tone?: 'default'\|'danger'`, `confirmText?` (type-to-confirm), `onConfirm(): void\|Promise` (busy state, errors shown inline), `onCancel` — keys: Ctrl+A/Y confirm, N/Esc cancel; danger focuses Cancel. 2.1: no icon disc; a label starting with its key shows it underlined ("Y̲es", "N̲o", `bx-accel`; the accessible name is unchanged; no underline while a `confirmText` must be typed — Y/N are letters then); tooltips "Delete · Y or Ctrl+A" / "Cancel · N or Esc" (`lib/keyText.ts` `confirmTips`) |
| `Drawer` | `open`, `onClose`, `title`, `description?`, `size?: 'sm'\|'md'\|'lg'`, `footer?`, `modal?` (true), `dismissible?`, `initialFocusRef?` |
| `ToastProvider` + `useToast()` | `show({tone,title,message?,action?,duration?,id?})`, `success/error/info/warning(title, opts?)`, `dismiss(id)`, `clear()` — max 4, errors 8s others 5s, pause on hover/focus, `aria-live` (assertive for errors) |

Dialogs: focus trap with initial focus (first `[data-autofocus]`, else first field — the × button
is skipped) and focus restore, `aria-modal`, Esc closes unless `dismissible={false}`, and a
**blocking hotkey scope** (screen/app hotkeys don't fire underneath). Unmount when closed.

```tsx
<ConfirmDialog open={confirming} tone="danger" title="Delete voucher Sales/42?"
  message="This removes the voucher and its GST entries permanently. Cancelling keeps the number."
  confirmLabel="Delete" onConfirm={() => api('vouchers.delete', { id })} onCancel={() => setConfirming(false)} />
```

### Data display

| Component | Key props |
|---|---|
| `DataTable<T>` | see below |
| `KeyValueList` | `items: {label, value, kind?: 'text'\|'amount'\|'drcr'\|'date', strong?, hideEmpty?}[]`, `layout?: 'inline'\|'stacked'`, `columns?`, `labelWidth?`, `alignValues?` |
| `Card` | `title?` (14/600), `subtitle?`, `actions?`, `footer?`, `padding?: 'none'\|'sm'\|'md'`, `elevated?` (accepted; 2.1 cards are always flat), `headingLevel?`, `as?` — flat: no border, radius, fill or horizontal padding |
| `KpiCard` / `Stat` | A *figure* (2.1): `label` (12 muted), `value` (24/600; node, or paise with `amount` → compact ₹ with the exact value as title/SR), `delta?: {value: %, label?, goodWhen?}` (muted ▲/▼ + sign — never colour alone), `caption?` (one, short), `sparkline?: number[]`, `trend?`, `loading?`, `onClick?` (the whole figure becomes the drill button). `icon` is accepted and ignored — no icon tile, chevron, border or hover lift |
| `StatLine` | `items: {label, value: paise \| node, onClick?, tone?: 'warning'\|'danger', title?, link?}[]` — the report's answer in exact money ("To collect ₹99,953 · Overdue ₹4,65,953 · ₹3,66,000 not matched to bills ›"); ≤ 3 figures + ≤ 1 `link` item (`statProblems`); drop zero amounts with `dropZeros(items)` |
| `MiniColumns` | Home only: `title`, `months` (names, oldest first, ≤ 12), `values` (paise), `emphasis` (index or null), `label` (the emphasised column's direct label), `onActivate?` |
| `Sparkline` | `values`, `width?` 96, `height?` 28, `label?`, `emphasis?: 'muted'\|'brand'`, `area?` |
| `BarChart` / `LineChart` | 2.0 API kept as thin adapters that render `LazyChart` (`title`, `description?` = takeaway, `categories`, `series: {name, values: (number\|null)[], slot?}[]`, `valueFormat?`, `height?`, `labelMax?` / `endLabels?`, `onCategoryActivate?`, `empty?`). New code builds a `ChartSpec` instead |
| `Tabs` | `items: {id,label,icon?,badge?,disabled?,content?}[]`, `value?`/`defaultValue?`/`onChange?`, **`aria-label`**, `variant?: 'line'\|'pill'` (2.1: both are text tabs), `activation?`, `keepMounted?`, `end?` |
| `Breadcrumbs` | `items: {key,label,onClick?}[]` (last = current page), `maxItems?` |
| `EmptyState` | `title` (13/600), `body?` (muted), `action?` (≤ 2 Buttons, drawn as links), `size?`; `icon?` accepted — 2.1: no icon disc, left-aligned, 48 px below the header (none inside a table cell or with `size="sm"`) |
| `Banner` / `Callout` | `tone?: 'info'\|'success'\|'warning'\|'danger'`, `title?` (inline, 600, verbatim), `children`, `action?` (link-styled), `onDismiss?`; `icon?`/`inline?` accepted — 2.1: one line, tone fill, no border, no icon; a body that is a list wraps |
| `DisclosureLine` | `label?` ("More details"), `shortcut?` (printed plain, e.g. "Ctrl+I"; the screen registers it), `summary?` (muted, while closed), `open?`/`defaultOpen?`/`onToggle?`, `forceOpen?` (auto-reveal), `children?` (the region; `hidden` while closed, so Tab and Enter skip it) or `controls?` — a 13 px link-style row with `aria-expanded`/`aria-controls`. Pure rule: `lib/disclosure.ts` `shouldReveal(fields, values, errors?, { defaults?, forced? })` — a value or an error inside never stays hidden |
| `FiltersPopover` | `filters?: {value, defaultValue?}[]` or `count?`, `children` (the filter controls, names unchanged), `onClear?` — one quiet "Filters ▾" button whose label counts the active ones ("Filters (2)", accessible name "Filters, 2 active"; `lib/filters.ts` `activeCount`); Esc closes and returns focus; "Clear filters" closes it and focuses the button |
| `Pagination` | `page` (1-based), `pageSize`, `total`, `onPageChange`, `pageSizeOptions?`, `onPageSizeChange?`, `itemLabel?` |

#### Graphs (2.1)

One kit draws every graph: `ui/Chart.tsx` renders the five kinds of a `ChartSpec` (`ui/lib/chartSpec.ts`,
pure) — `column`, `bar` (horizontal, Top 6 + Other), `line`, `share` (one 100 % bar) and `meter` (a ratio
against a limit) — as hand-rolled SVG on `ui/lib/chart.ts` geometry. **It is never imported directly**:
screens import `reportGraph` (or `LazyChart`) **by path** from `ui/lazyChart.tsx`, which loads the kit
with `React.lazy` so it never reaches the start-up bundle; neither is exported from this barrel
(`app/lib/chartImports.test.ts`). While the chunk loads, the plot's place is an empty box of its final
height (no skeleton, no `aria-busy`).

```tsx
import { reportGraph } from '../../ui/lazyChart.tsx';
const spec = useMemo(() => (q.data ? registerChart(q.data) : null), [q.data]); // modules/<m>/lib/charts.ts
<ReportScreen title="Sales Register" graph={reportGraph(spec)} …>
```

- **Colour by meaning** (D29), resolved by `markColor`: slot 1 = the thing measured; `--chart-other`
  (grey) = context (a second series is always context); slot 2 = only the negative or problem pole
  (`'polarity'` negatives, `'problem'` categories); the indigo ramp `--chart-o1…o5` (styles/charts.css) =
  age/lateness; `--chart-partial` = a running period, always labelled "so far". Slots 3–5 are never
  drawn; status tokens are never a series. `ui/lib/chartPalette.test.ts` re-validates the shipped tokens
  (contrast, normal-vision and CVD ΔE, the ordinal ramp) in both themes.
- **Marks**: columns ≤ 24 px with a 4 px rounded data end, square at the baseline; horizontal bars 12 px
  on a 20 px pitch with the value outside the tip; 2 px lines with an area wash for the measured series
  only and an r 4 end dot ringed in the canvas colour; a share bar of 16 px with 2 px gaps and segments
  ≥ 4 px; one axis, hairline solid grid, Indian compact ticks (`0 · 50 K · 1 L · 1 Cr`); polarity columns
  show absolute ticks plus the spec's axis captions ("Profit ↑" / "Loss ↓"). Direct labels are sparing:
  the extreme (`max`), the endpoint (`last`), every bar tip (`tips`, ≤ 7 rows) or none. A legend appears
  only for two series (or a share bar whose names do not fit under it).
- **Interaction**: one hover effect per kind (band, row wash, crosshair, segment lift) and a tooltip
  (value first, then name; React text only). The plot is one Tab stop — `role="listbox"`,
  `aria-roledescription="graph"`, named by the title, described by the takeaway, one `option` per
  category through `aria-activedescendant`; ←/→ (↑/↓ for bars) and Home/End move, Enter calls
  `spec.activate(i)` (= Enter on the matching table row). On focus the highlight starts at the table's
  `active` row when one is passed, else nothing is highlighted until the first arrow (→ = first, ← =
  last). A meter is static (`role="img"`). A visually hidden data table follows every graph.
- **Never printed**: `@media print` hides `.bx-chart`, `.bx-mini` and `.bx-sparkline`; printed documents
  import no graph code (`chartImports.test.ts`). `forced-colors`: marks `CanvasText`, grid `GrayText`.


#### DataTable

```tsx
const columns = useMemo<Column<TbRow>[]>(() => [
  { key: 'name', header: 'Particulars', tree: true, sortable: true },
  { key: 'debit', header: 'Debit', kind: 'amount', width: 140, blankZero: true, total: true },
  { key: 'credit', header: 'Credit', kind: 'amount', width: 140, blankZero: true, total: true },
  { key: 'closing', header: 'Closing', kind: 'drcr', width: 160 },
], []);

<DataTable
  aria-label="Trial Balance"
  columns={columns}
  rows={rows}                                   // stable array (from state)
  getRowKey={(r) => r.key}
  getRowLevel={(r) => r.level}                  // tree reports: rows in display order + level
  isGroupRow={(r) => r.isGroup}
  expandable defaultExpanded={1}                // →/← or +/− expand/collapse
  onRowActivate={(r) => nav.push('reports.ledger', { id: r.ledgerId })}   // Enter / double-click
  selectedKey={cursor} onSelect={setCursor}
  loading={loading}
/>
```

Column: `key`, `header`, `headerLabel?`, `width?` (px or CSS), `minWidth?`, `align?`,
`kind?: 'text'|'amount'|'drcr'|'qty'|'date'|'number'`, `value?(row)`, `render?(row, {index, level,
value, formatted})`, `footer?` (node or fn(rows)), `total?: true | fn(rows)` (sums top-level rows in
tree mode, non-group rows otherwise), `sortable?`, `sortValue?`, `decimals?`, `unit?`, `blankZero?`,
`tree?`, `hidden?`, `keepEmpty?` (never hidden by `hideEmptyColumns`), `bar?: { value(row): number|null,
slot: 1 | 'polarity' }` (2.1 inline bar: a 4 px `aria-hidden` bar under the cell text, width ∝ |value| /
the largest |value| of the rendered rows — `lib/inlineBars.ts` `barWidths`; return null for total rows;
slot 2 for negatives under `'polarity'`; hidden under `[data-graphs="off"]` and in print — used instead
of a graph when the graph would only repeat a table of ≤ 7 rows), `className?`, `cellClassName?`, `title?`.

Table props: `columns`, `rows`, `getRowKey`, `aria-label`, `onRowActivate?`,
`selectedKey?`/`defaultSelectedKey?`/`onSelect?(key,row)`, `getRowLevel?`, `isGroupRow?`,
`expandable?`, `expandedKeys?`/`defaultExpanded?: 'all'|'none'|N`/`onExpandedChange?`,
`sort?`/`defaultSort?`/`onSortChange?`/`manualSort?`, `loading?` (skeleton rows),
`skeletonRows?`, `empty?`, `height?`, `virtualize?: 'auto'|true|false` (auto > 200 rows),
`rowHeight?`, `density?`, `zebra?` (accepted; 2.1 draws no zebra), `hideEmptyColumns?` (hide columns
blank on every row — `lib/emptyColumns.ts` `emptyColumnIds`; the label column, `keepEmpty` columns and
render-only columns (a `render` with no `value` whose key is not a field of the rows) stay; exports keep
every column), `hiddenColumns?: string[]` (the user's More › Columns… choice),
`footerRows?: {key, cells: {colKey: node|number}, tone?}[]`
(e.g. Opening / Current Total / Closing), `typeToJump?`, `getRowClassName?`,
`onRowKeyDown?(e, row)` (extra keys, runs first), `autoFocus?`, `gridRef?`.

Behaviour: one Tab stop (`role=grid`/`treegrid`, `aria-activedescendant`); focusing highlights the
first row; ↑/↓/PgUp/PgDn/Home/End move; Enter activates; letters jump to the next row starting
with them; sortable headers are buttons (the sort glyph shows on the sorted column and on hover/focus).
Header and footer are sticky; windowed rendering keeps 10k+ rows smooth (fixed row height = `--row-h`,
measured). 2.1 look: no outer border, radius or fill; the table is as tall as its rows and never taller
than its parent (`max-height: 100%`, the body scrolls); header 13/600 secondary over a
`--border-default` rule; row separators `--border-subtle`; the total row has a top rule and 600, no
fill; the active row keeps its `--row-selected` fill always and gets the 2 px inset bar only while the
grid has focus (no whole-table focus frame; a focused table with no cursor row — empty or loading —
shows the bar on its first header cell instead). Amount cells: `formatMoney`; `drcr` cells: amount +
fixed-width `Dr`/`Cr` suffix in `--text-muted`. Define `columns` with `useMemo`
(rows re-render when the columns array identity changes; `hiddenColumns` and `hideEmptyColumns` are
compared by their key lists, so a fresh array with the same keys re-renders nothing). For printing long reports render with
`virtualize={false}` or use the print module.

### Layout

| Component | Key props |
|---|---|
| `Stack` | `gap?: Space` (3), `align?`, `justify?`, `grow?`, `as?` |
| `Inline` / `Cluster` | `gap?` (2), `rowGap?`, `align?`, `justify?`, `wrap?` (true), `as?` |
| `Grid` | `columns?: number\|string`, `minItemWidth?` (auto-fill), `gap?`, `rowGap?`, `align?`, `as?` |
| `Spacer` | `size?` (fixed) or flex-grow |
| `Panel` | `title` (14/600), `description?`, `actions?`, `collapsible?`, `defaultCollapsed?`, `padded?`, `headingLevel?` — flat (2.1): no border, no header rule |
| `PageHeader` | `title` (h1), `subtitle?`, `breadcrumbs?`, `actions?`, `meta?`, `icon?` |
| `Toolbar` | **`aria-label`**, `roving?` (buttons one Tab stop), `variant?: 'plain'\|'bar'`, `dense?` |
| `SplitPane` | `orientation?`, `size?`/`defaultSize?`/`onSizeChange?`, `minSize?`, `maxSize?`, `first`, `second`, `separatorLabel?` — keyboard-resizable separator |
| `ScrollArea` | `maxHeight?`, `height?`, `horizontal?`, `aria-label?`, `shadows?` — focusable when it overflows |
| `ActionRail` | `items: {key:'F2', label, onClick, disabled?, hidden?, group?, icon?, hint?, primary?, id?}[]`, `registerHotkeys?` (true), `showGroupLabels?` |
| `ReportFrame` | The 2.1 report template (`app/ReportScreen.tsx` is its one user): `title`, `subtitle?`, `companyName?` (accepted, not shown on screen since 2.1 — the top bar names the company; print/export take it from `TableExportDef`), `period?: {from,to}\|node` (the context run's period token, "1-Apr-26 – 10-Oct-26"; a quiet button with `onPeriodClick?`), `context?` (replaces the token), `meta?` (one state word), `breadcrumbs?`, `filters?` (toolbar row, left), `actions?` + `stat?` (toolbar row, right), `graph?` (the graph strip, first in the body), `graphs?: 'on'\|'off'` (`data-graphs` on the body), `children` (body, content-sized), `footer?`, `rail?`, `refreshing?` (body at 0.6 opacity, no spinner). The heading is `PageHeader`'s; Export / Print are screen actions, never buttons in the frame |

```tsx
<ReportFrame
  title="Trial Balance" period={{ from, to }} onPeriodClick={openPeriod}
  filters={<SegmentedControl aria-label="View" value={view} onChange={setView}
             options={[{ value: 'condensed', label: 'Condensed' }, { value: 'detailed', label: 'Detailed' }]} />}
  stat={<StatLine items={[{ label: 'Agrees', value: '✓' }]} />}
  rail={<ActionRail items={[
    { key: 'F2', label: 'Date', onClick: changeDate },
    { key: 'Alt+F2', label: 'Period', onClick: openPeriod },
    { key: 'Alt+F1', label: view === 'detailed' ? 'Condensed' : 'Detailed', onClick: toggleView, group: 'view' },
    { key: 'Alt+E', label: 'Export', onClick: exportIt, group: 'output' },
    { key: 'Alt+P', label: 'Print', onClick: printIt, group: 'output' },
  ]} />}
>
  <DataTable … />
</ReportFrame>
```

---

## 5. Hooks (`ui/hooks`)

| Hook | Signature / notes |
|---|---|
| `useControllableState<T>({ value?, defaultValue, onChange? })` | → `[value, set]`; controlled when `value !== undefined` (use `null` for empty) |
| `useDebouncedValue<T>(value, ms = 200)` | |
| `useFocusTrap(ref, { active, initialFocus?: ref\|'first'\|'container'\|'none', restoreFocus? })` | Tab cycles; focus escaping to the page returns; newer overlays allowed |
| `useRovingFocus(ref, { orientation?, loop?, itemSelector?, typeahead?, manageTabIndex?, onNavigate? })` | → `{ onKeyDown, onFocus, getItems, focusItem }`; items `[data-roving-item]` |
| `useListNavigation({ count, activeIndex?, defaultActiveIndex?, onActiveIndexChange?, pageSize?, loop?, homeEnd?, isDisabled? })` | → `{ activeIndex, setActiveIndex, onKeyDown(e): boolean }` (aria-activedescendant lists) |
| `useOnClickOutside(refs[], handler, enabled?)` | pointerdown outside all refs (nested later overlays count as inside) |
| `useEnterAdvance<T>({ enabled?, onComplete?, selectOnFocus? })` | → ref for the form container (`data-enter-scope`) |
| `useHotkeys(map, deps?, { enabled?, scope?: 'auto'\|'global', allowInInputs?, allowRepeat? })` | see §6 |
| `useAnchoredPosition(anchorRef, floatingRef, { open, placement?, offset?, padding?, matchWidth? })` | → `{ style, placement, available, update }` |
| `useDraftField<V>({ value, format, parse, onChange, normalize?, validate?, onCommit?, equals? })` | build your own formatted input |
| `useMergedRefs(...refs)`, `useLatestRef(value)` | utilities |

### useEnterAdvance (keyboard-first form navigation)

- **Enter** → next field, **Shift+Enter** → previous; textareas use **Ctrl+Enter** (plain Enter =
  newline). Enter on the last field calls `onComplete` (e.g. "Accept?" / save).
- Fields = enabled, editable inputs/selects/textareas/comboboxes/switches in DOM order, skipping
  read-only, `tabindex=-1` and anything inside `[data-enter-skip]` (the kit marks input trailing
  buttons). Add `data-enter-target` to include e.g. the Save button; `data-enter-ignore` to opt a
  subtree out. The newly focused text field has its text selected (overwrite on entry).
- Controls that consume Enter (an open picker selecting with `onCommit`, a grid activating a row)
  call `preventDefault` and are respected. Only the innermost scope reacts.

---

## 6. Hotkeys

```tsx
useHotkeys({
  'Ctrl+A': () => save(),
  'Alt+P': () => print(),
  'Alt+C': canCreate ? () => create() : undefined,   // falsy = not registered
  'Escape': () => {
    if (!dirty) return false; // false → the key continues to the next layer (e.g. the shell pops)
    askDiscard();
  },
}, [canCreate, dirty]);
```

- Strings: `'Ctrl+A'`, `'Alt+F2'`, `'F8'`, `'Shift+Enter'`, `'Escape'`/`'Esc'`, `'Ctrl+Shift+Tab'`,
  `'Ctrl++'`, lists `'Ctrl+G, Alt+G, Ctrl+K'`. Letters match by physical key too (works on
  non-Latin layouts). `Mod` = Ctrl.
- **Layers:** the app root is layer 0 (`scope: 'global'`). Wrap each screen in
  `<HotkeyScope active={isTopOfStack}>`; `Modal`, `Drawer` (modal), `Popover` and `DropdownMenu`
  create **blocking** scopes automatically. Rules: a blocking scope fences everything outside it;
  deeper scopes beat shallower ones; newer beats older; a handler returning `false` passes the key
  down. So a dialog's `Ctrl+A` wins over the screen's, and `F8` doesn't open Sales under a dialog.
- Ignored while an IME is composing, when a component already handled the key
  (`preventDefault`), and — for plain typing keys (`d`, `Shift+Enter`) — while focus is in an
  editable field unless `allowInInputs`. F-keys, Esc and Ctrl/Alt combos work everywhere.
- `Kbd` renders chips for the same strings; `toAriaKeyShortcut()` converts for `aria-keyshortcuts`.

### Keyboard behaviour reference

| Where | Keys |
|---|---|
| Forms (`useEnterAdvance`) | Enter next · Shift+Enter previous · Ctrl+Enter in textarea · Esc bubbles to the screen |
| Combobox | type to filter · ↑ ↓ PgUp PgDn Home End · Enter select · Tab select+next · Esc close (2nd bubbles) · Alt+↓/↑ open/close · Alt+C create |
| NumberInput / AmountInput | type value or expression · ↑/↓ step (when `step`) · `d`/`c` Dr/Cr (drcr mode) · Enter commits |
| DateInput / Calendar | type shorthand · +/− ±1 day · Alt+↓ calendar · ←→↑↓ days/weeks · PgUp/PgDn months · Shift+PgUp/PgDn years · Home/End · T working date · Enter pick · Esc close |
| DataTable | ↑ ↓ PgUp PgDn Home End · Enter / double-click activate · → / + expand · ← / − collapse or go to parent · letters jump |
| Menu / ActionRail / Toolbar | ↑↓ (or ←→) move · Home/End · letters (menu) · Enter/Space activate · Esc closes menus |
| Tabs | ←/→ · Home/End · Ctrl+Tab / Ctrl+Shift+Tab from anywhere inside |
| SegmentedControl / RadioGroup | ←/→ move and select |
| Switch | Space toggle · Y / N set |
| Modal / Drawer / Popover | Tab cycles inside · Esc closes (unless not dismissible) |
| ConfirmDialog | Ctrl+A or Y confirm · N or Esc cancel |
| Graphs | Tab (or Shift+Tab from the table) to focus · ←/→ (↑/↓ on bars) category · Home/End · Enter = the row's drill-down |
| SplitPane divider | ←/→ (↑/↓) resize · Shift ×4 · Home/End min/max |

---

## 7. Do / Don't

**Density** — Do use `compact` for heavy data-entry and long reports (`data-density="compact"` on a
table or the whole app). Don't mix control heights within one form row.

**Numbers** — Do right-align every numeric column (`kind` does it) and keep tabular figures. Don't
format amounts by hand: use `formatMoney`, `formatDrCr`, `formatQty`, `formatCompactINR` from
`shared/format.ts` (the kit's `kind`s already do).

**Dr/Cr** — Do show balances as `12,500.00 Dr` / `3,200.00 Cr` (`kind: 'drcr'`); don't show a
bare minus in accounting reports, and don't colour Dr/Cr red/green (`--dr`/`--cr` are deliberately
subtle). Use `--positive`/`--negative` only for KPI deltas.

**Empty states** — Do say what's empty and what to do: *"No vouchers in this period — change the
period (Alt+F2) or create one (F8)."* Don't show an empty grid without explanation.

**Errors** — Say what happened + what to do, in an accountant's words, next to the field:
*"GSTIN should be 15 characters — check the last digit."* · *"This date is in a locked period
(up to 31-Mar-2026). Choose a later date or ask an administrator to unlock it."* Don't write
"Invalid input", "Error 500", or blame the user.

**Status** — Do pair colour with text/icon (Badge text, Banner icon). Don't use `--success-*`
colours for chart series or decoration.

**Overlays** — Do keep dialogs short; put the primary action last (right) with its shortcut. Don't
nest more than two dialogs; use a Drawer for secondary detail.

**Keyboard** — Do expose every screen action in the `ActionRail` with its key. Don't invent
conflicting global keys (see ARCHITECTURE §7 for the reserved list).

---

## 8. Shell integration checklist

1. `import '../styles/index.css'` once; set `data-theme` / `data-density` on `<html>` (`applyTheme`).
2. Wrap the app in `<ToastProvider>`.
3. Register global hotkeys (F2, F8 …, Ctrl+G) with `useHotkeys(map, deps, { scope: 'global' })`.
4. Render each stacked screen inside `<HotkeyScope active={isTop}>`; register screen `Escape` (pop,
   with dirty confirmation) at screen scope so dialogs/pickers get Esc first.
5. Offset toasts from the rail if needed: `--toast-inset-right: calc(var(--rail-width) + 16px)`.
6. Tests: `node --test src/renderer/ui/lib/*.test.ts` (parser, hotkeys, layering, matching,
   windowing, tree, calendar, charts, pagination, token contrast), `ui/theme.test.ts` (theme
   resolution) and `styles/*.test.ts` (dead CSS, CSS budget).
