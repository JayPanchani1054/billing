import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import { Portal } from './Portal.tsx';
import { Spinner } from './Spinner.tsx';
import { FieldContext, useFieldControl } from './fieldContext.ts';
import { useAnchoredPosition } from './hooks/useAnchoredPosition.ts';
import { useDebouncedValue } from './hooks/useDebouncedValue.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { cx } from './lib/cx.ts';
import { readPxVar } from './lib/dom.ts';
import { nextListIndex } from './lib/listNav.ts';
import type { ListNavKey } from './lib/listNav.ts';
import { filterAndRank, highlightRanges, splitHighlight } from './lib/match.ts';
import type { Range } from './lib/match.ts';
import { computeVirtualWindow, pageSize, scrollTopToReveal } from './lib/virtual.ts';
import type { ControlSize } from './types.ts';

export interface ComboboxRenderState {
  /** Keyboard/mouse highlight. */
  active: boolean;
  /** Equals the current value. */
  selected: boolean;
  query: string;
  /** The label with matches wrapped in <mark>. */
  highlightedLabel: ReactNode;
}

export interface ComboboxProps<T> {
  /** Static items (filtered client-side). Ignored when `loadItems` is given. */
  items?: readonly T[];
  /** Async source: called (debounced) with the query; previous results stay visible while loading. */
  loadItems?: (query: string, signal: AbortSignal) => Promise<readonly T[]>;
  /** Debounce for loadItems (ms, default 150). */
  debounceMs?: number;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  /** Alias/short name — matched and shown subdued after the label. */
  getAlias?: (item: T) => string | null | undefined;
  /** Extra search words (GSTIN, HSN, group name…). Matched, not shown. */
  getKeywords?: (item: T) => readonly string[] | null | undefined;
  /** Custom row content (the right meta column is still rendered). */
  renderItem?: (item: T, state: ComboboxRenderState) => ReactNode;
  /** Right-aligned secondary value — closing balance, stock in hand. */
  rightMeta?: (item: T) => ReactNode;
  /** Section headers (e.g. ledger group). Groups are ordered by their best match. */
  groupBy?: (item: T) => string;
  isItemDisabled?: (item: T) => boolean;
  /** Replace the default ranking filter (label/alias/keywords token match). */
  filter?: (items: readonly T[], query: string) => readonly T[];
  value: T | null;
  onChange: (item: T | null) => void;
  /**
   * Called after Enter selects an item. When provided the Enter key is consumed (move focus
   * yourself); otherwise Enter continues to an enclosing useEnterAdvance scope.
   */
  onCommit?: (item: T | null) => void;
  /** Enables the "+ Create '…'" row and Alt+C. Receives the typed text. */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** Clearing the text and leaving the field sets the value to null (default true). */
  clearable?: boolean;
  /** Shown when nothing matches (default "No matches"). */
  emptyText?: ReactNode;
  /** Rows visible before the list scrolls (default 8). */
  maxVisible?: number;
  /** Open the list on focus (default true). */
  openOnFocus?: boolean;
  /** Keyboard hints in the list footer (default true). */
  showHints?: boolean;
  /** Minimum list width in px (default: the input width). */
  listMinWidth?: number;
  size?: ControlSize;
  id?: string;
  name?: string;
  autoFocus?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

type OptionEntry<T> = { kind: 'item'; item: T; key: string; ranges: Range[]; disabled: boolean } | { kind: 'create'; key: string };
type RowEntry = { kind: 'header'; label: string; key: string } | { kind: 'option'; optionIndex: number; key: string };

const VIRTUAL_THRESHOLD = 200;

function Highlighted({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  const segs = splitHighlight(text, ranges);
  return (
    <>
      {segs.map((s, i) =>
        s.match ? (
          <mark key={i} className="bx-match">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

interface OptionRowProps {
  id: string;
  active: boolean;
  selected: boolean;
  disabled: boolean;
  posinset: number;
  setsize: number;
  index: number;
  onPick: (index: number) => void;
  onHover: (index: number, x: number, y: number) => void;
  children: ReactNode;
  meta?: ReactNode;
  create?: boolean;
}

const OptionRow = memo(function OptionRow({ id, active, selected, disabled, posinset, setsize, index, onPick, onHover, children, meta, create }: OptionRowProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      aria-posinset={posinset}
      aria-setsize={setsize}
      className={cx('bx-option', active && 'is-active', selected && 'is-selected', disabled && 'is-disabled', create && 'bx-option--create')}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={(e) => {
        if (!active) onHover(index, e.clientX, e.clientY);
      }}
      onClick={() => {
        if (!disabled) onPick(index);
      }}
    >
      <span className="bx-option__check" aria-hidden="true">
        {selected ? <Icon name="check" size="sm" /> : create ? <Icon name="plus" size="sm" /> : null}
      </span>
      <span className="bx-option__content">{children}</span>
      {meta !== undefined && meta !== null && meta !== '' ? <span className="bx-option__meta bx-num">{meta}</span> : null}
    </div>
  );
});

/**
 * Type-ahead picker for masters (ledgers, items, groups…). See README → Combobox for behaviour.
 * Keyboard: type to filter · ↑/↓/PgUp/PgDn/Home/End move · Enter select (+onCommit) · Tab select
 * and move on · Esc close (a second Esc bubbles) · Alt+↓ open · Alt+C create.
 */
export function Combobox<T>(props: ComboboxProps<T>) {
  const {
    items,
    loadItems,
    debounceMs = 150,
    getKey,
    getLabel,
    getAlias,
    getKeywords,
    renderItem,
    rightMeta,
    groupBy,
    isItemDisabled,
    filter,
    value,
    onChange,
    onCommit,
    onCreate,
    createLabel = (q: string) => `Create “${q}”`,
    placeholder,
    disabled,
    readOnly,
    required,
    invalid,
    clearable = true,
    emptyText = 'No matches',
    maxVisible = 8,
    openOnFocus = true,
    showHints = true,
    listMinWidth,
    size = 'md',
    name,
    autoFocus,
    className,
    ref,
  } = props;

  const field = useFieldControl({ id: props.id, 'aria-describedby': props['aria-describedby'], invalid, required, disabled });
  const fieldCtx = useContext(FieldContext);
  const autoId = useId();
  const inputId = field.id ?? `${autoId}-input`;
  const listId = `${autoId}-listbox`;
  const optionId = (i: number) => `${autoId}-opt-${i}`;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const mergedInputRef = useMergedRefs(inputRef, ref);

  const [open, setOpen] = useState(false);
  /** Typed text; null = not editing (input shows the selected label). */
  const [query, setQueryState] = useState<string | null>(null);
  const queryRef = useRef<string | null>(null);
  const setQuery = useCallback((next: string | null) => {
    queryRef.current = next;
    setQueryState(next);
  }, []);
  /** The user moved the highlight (or typed) since the list opened — Tab then selects it. */
  const navigatedRef = useRef(false);
  const lastPointer = useRef({ x: -1, y: -1 });
  const prevQueryRef = useRef<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [scrollTop, setScrollTop] = useState(0);
  const [rowHeight, setRowHeight] = useState(32);
  const [loaded, setLoaded] = useState<readonly T[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const revealRef = useRef(false);

  const q = query ?? '';
  const valueKey = value === null ? null : getKey(value);
  const inputText = query ?? (value === null ? '' : getLabel(value));

  // ── Async loading ──
  const debouncedQuery = useDebouncedValue(q, loadItems ? debounceMs : 0);
  useEffect(() => {
    if (!loadItems || !open) return undefined;
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    loadItems(debouncedQuery, ctrl.signal).then(
      (res) => {
        if (ctrl.signal.aborted) return;
        setLoaded(res);
        setLoading(false);
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoading(false);
        setLoadError(err instanceof Error && err.message ? err.message : 'Could not load the list. Try again.');
      },
    );
    return () => ctrl.abort();
  }, [loadItems, debouncedQuery, open]);

  // ── Options (filtered, ranked, grouped) ──
  const source = loadItems ? loaded : items ?? [];
  const options = useMemo((): OptionEntry<T>[] => {
    let ranked: { item: T; ranges: Range[] }[];
    if (loadItems || filter) {
      const list = filter && !loadItems ? filter(source, q) : source;
      ranked = list.map((item) => ({ item, ranges: q ? highlightRanges(getLabel(item), q) : [] }));
    } else {
      ranked = filterAndRank(source, q, (item) => ({ label: getLabel(item), alias: getAlias?.(item), keywords: getKeywords?.(item) })).map((r) => ({
        item: r.item,
        ranges: r.match.ranges,
      }));
    }
    let ordered = ranked;
    if (groupBy) {
      const groups = new Map<string, { item: T; ranges: Range[] }[]>();
      for (const r of ranked) {
        const g = groupBy(r.item);
        const list = groups.get(g);
        if (list) list.push(r);
        else groups.set(g, [r]);
      }
      ordered = [...groups.values()].flat();
    }
    const out: OptionEntry<T>[] = ordered.map((r) => ({
      kind: 'item',
      item: r.item,
      key: getKey(r.item),
      ranges: r.ranges,
      disabled: isItemDisabled?.(r.item) ?? false,
    }));
    const trimmed = q.trim();
    if (onCreate && trimmed !== '') {
      const lower = trimmed.toLowerCase();
      const exact = out.some((o) => o.kind === 'item' && getLabel(o.item).trim().toLowerCase() === lower);
      if (!exact) out.push({ kind: 'create', key: '__create__' });
    }
    return out;
    // Getter props are read at computation time; pass a new `items` array to refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, q, filter, !!onCreate, !!groupBy, !!loadItems]);

  const rows = useMemo((): RowEntry[] => {
    if (!groupBy) return options.map((o, i) => ({ kind: 'option', optionIndex: i, key: o.key }));
    const out: RowEntry[] = [];
    let current: string | null = null;
    options.forEach((o, i) => {
      if (o.kind === 'item') {
        const g = groupBy(o.item);
        if (g !== current) {
          current = g;
          out.push({ kind: 'header', label: g, key: `__group__${g}` });
        }
      } else if (current !== null) {
        current = null;
      }
      out.push({ kind: 'option', optionIndex: i, key: o.key });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const rowIndexOfOption = useMemo(() => {
    const map = new Map<number, number>();
    rows.forEach((r, i) => {
      if (r.kind === 'option') map.set(r.optionIndex, i);
    });
    return map;
  }, [rows]);

  const optionDisabled = useCallback((i: number) => {
    const o = options[i];
    return !o || (o.kind === 'item' && o.disabled);
  }, [options]);

  const selectedOptionIndex = valueKey === null ? -1 : options.findIndex((o) => o.kind === 'item' && o.key === valueKey);

  // Keep the active index valid: a new query highlights the best match; otherwise keep the
  // current highlight (new `items` identity must not reset keyboard position).
  useLayoutEffect(() => {
    if (!open) {
      prevQueryRef.current = null;
      return;
    }
    const queryChanged = prevQueryRef.current !== query;
    prevQueryRef.current = query;
    setActiveIndex((cur) => {
      const first = nextListIndex(-1, 'ArrowDown', { count: options.length, isDisabled: optionDisabled });
      if (queryChanged && query !== null) return first;
      if (!queryChanged && cur >= 0 && cur < options.length && !optionDisabled(cur)) return cur;
      return selectedOptionIndex >= 0 ? selectedOptionIndex : first;
    });
    revealRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, open]);

  // ── Positioning & virtualisation ──
  const pos = useAnchoredPosition(wrapRef, popupRef, { open, placement: 'bottom-start', offset: 4, matchWidth: true });
  const virtual = rows.length > VIRTUAL_THRESHOLD;

  useLayoutEffect(() => {
    if (!open || !listRef.current) return;
    const fromVar = readPxVar(listRef.current, '--option-h');
    const firstRow = listRef.current.querySelector<HTMLElement>('.bx-option, .bx-listbox__group');
    const measured = firstRow ? firstRow.getBoundingClientRect().height : Number.NaN;
    const h = measured > 0 ? measured : fromVar;
    if (h > 0 && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
  }, [open, rows.length, rowHeight]);

  const visibleRows = Math.max(1, Math.min(maxVisible, rows.length));
  const listMaxHeight = Math.max(rowHeight * 3, Math.min(rowHeight * visibleRows, pos.available ? pos.available - 40 : rowHeight * visibleRows));
  const win = virtual
    ? computeVirtualWindow({ count: rows.length, rowHeight, scrollTop, viewportHeight: listMaxHeight, overscan: 6 })
    : { start: 0, end: rows.length, padTop: 0, padBottom: 0 };

  // Scroll the active option into view after keyboard moves / filtering.
  useLayoutEffect(() => {
    if (!open || !revealRef.current) return;
    revealRef.current = false;
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    const rowIndex = rowIndexOfOption.get(activeIndex) ?? -1;
    // Reveal the group header too when the first option of a group becomes active.
    const target = rowIndex > 0 && rows[rowIndex - 1]?.kind === 'header' ? rowIndex - 1 : rowIndex;
    const next = scrollTopToReveal({ index: target, rowHeight, scrollTop: list.scrollTop, viewportHeight: list.clientHeight });
    const nextBottom = scrollTopToReveal({ index: rowIndex, rowHeight, scrollTop: next ?? list.scrollTop, viewportHeight: list.clientHeight });
    const final = nextBottom ?? next;
    if (final !== null) {
      list.scrollTop = final;
      setScrollTop(final);
    }
  });

  // Reset scroll when the list opens fresh.
  useEffect(() => {
    if (!open) setScrollTop(0);
  }, [open]);

  // ── Actions ──
  const openList = useCallback(() => {
    if (disabled || readOnly) return;
    setOpen((was) => {
      if (!was) navigatedRef.current = false;
      return true;
    });
    revealRef.current = true;
  }, [disabled, readOnly]);

  const closeList = useCallback(() => setOpen(false), []);

  const pick = useCallback(
    (index: number): 'item' | 'create' | null => {
      const o = options[index];
      if (!o) return null;
      if (o.kind === 'create') {
        onCreate?.(q.trim());
        setOpen(false);
        return 'create';
      }
      if (o.disabled) return null;
      if (o.key !== valueKey) onChange(o.item);
      setQuery(null);
      setOpen(false);
      return 'item';
    },
    [options, onCreate, q, valueKey, onChange, setQuery],
  );

  const onPick = useCallback(
    (index: number) => {
      const kind = pick(index);
      if (kind === 'item') {
        const o = options[index];
        if (o && o.kind === 'item') onCommit?.(o.item);
        inputRef.current?.focus({ preventScroll: true });
      }
    },
    [pick, options, onCommit],
  );

  const onHover = useCallback((index: number, x: number, y: number) => {
    // Chromium fires synthetic mousemove when content scrolls under a still pointer — ignore those.
    if (lastPointer.current.x === x && lastPointer.current.y === y) return;
    lastPointer.current = { x, y };
    navigatedRef.current = true;
    setActiveIndex(index);
  }, []);

  /** Resolve typed text when leaving the field without an explicit pick. */
  const settleDraft = () => {
    const typed = queryRef.current;
    if (typed === null) return;
    const trimmed = typed.trim();
    if (trimmed === '') {
      if (clearable && value !== null) onChange(null);
      setQuery(null);
      return;
    }
    const lower = trimmed.toLowerCase();
    const exact = options.find(
      (o) => o.kind === 'item' && !o.disabled && (getLabel(o.item).trim().toLowerCase() === lower || (getAlias?.(o.item) ?? '').trim().toLowerCase() === lower),
    );
    if (exact && exact.kind === 'item') {
      if (exact.key !== valueKey) onChange(exact.item);
      setQuery(null);
    } else if (value !== null) {
      setQuery(null); // revert to the current selection
    }
    // value === null and no match: keep the typed text visible (never lose input).
  };

  const pageRows = Math.max(1, pageSize(listMaxHeight, rowHeight));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (disabled || readOnly) return;

    if (e.altKey && (e.key === 'c' || e.key === 'C') && onCreate) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      onCreate(q.trim());
      return;
    }
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      openList();
      return;
    }
    if (e.altKey && e.key === 'ArrowUp') {
      if (open) {
        e.preventDefault();
        closeList();
      }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const navKeys: readonly string[] = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];
    if (navKeys.includes(e.key)) {
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          openList();
        }
        return;
      }
      e.preventDefault();
      revealRef.current = true;
      navigatedRef.current = true;
      setActiveIndex((cur) => nextListIndex(cur, e.key as ListNavKey, { count: options.length, pageSize: pageRows, isDisabled: optionDisabled }));
      return;
    }

    switch (e.key) {
      case 'Enter': {
        if (open && activeIndex >= 0) {
          const kind = pick(activeIndex);
          const o = options[activeIndex];
          if (kind === 'create') {
            e.preventDefault();
          } else if (kind === 'item' && o && o.kind === 'item' && onCommit) {
            e.preventDefault();
            onCommit(o.item);
          }
          // Without onCommit the key bubbles on to useEnterAdvance → next field.
          return;
        }
        if (open && q.trim() !== '' && onCreate && options.length === 0) {
          e.preventDefault();
          setOpen(false);
          onCreate(q.trim());
          return;
        }
        if (queryRef.current !== null) settleDraft();
        setOpen(false);
        return;
      }
      case 'Tab': {
        if (open && activeIndex >= 0 && (queryRef.current !== null || navigatedRef.current)) {
          const o = options[activeIndex];
          if (o && o.kind === 'item') pick(activeIndex);
        }
        setOpen(false);
        return;
      }
      case 'Escape': {
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return; // closed: let Esc bubble (screen back / dialog close)
      }
      default:
        return;
    }
  };

  const activeOption = open && activeIndex >= 0 && activeIndex < options.length ? optionId(activeIndex) : undefined;
  const hasValue = value !== null;
  const unmatched = query !== null && query.trim() !== '' && !open && value === null;
  const resultCount = options.filter((o) => o.kind === 'item').length;
  const labelledBy = props['aria-labelledby'] ?? (props['aria-label'] ? undefined : fieldCtx?.labelId);

  const renderOption = (o: OptionEntry<T>, i: number): ReactNode => {
    if (o.kind === 'create') {
      return (
        <span className="bx-option__label">
          {createLabel(q.trim())}
          <span className="bx-option__hint">Alt+C</span>
        </span>
      );
    }
    const label = getLabel(o.item);
    const highlighted = <Highlighted text={label} ranges={o.ranges} />;
    if (renderItem) return renderItem(o.item, { active: i === activeIndex, selected: o.key === valueKey, query: q, highlightedLabel: highlighted });
    const alias = getAlias?.(o.item);
    return (
      <>
        <span className="bx-option__label">{highlighted}</span>
        {alias ? <span className="bx-option__alias">{alias}</span> : null}
      </>
    );
  };

  const popupStyle: CSSProperties = { ...pos.style, minWidth: Math.max(listMinWidth ?? 0, Number(pos.style.minWidth ?? 0)) || undefined };

  return (
    <div ref={wrapRef} className={cx('bx-combobox', open && 'is-open', className)}>
      <div className={cx('bx-input', `bx-input--${size}`, field.invalid && 'is-invalid', field.disabled && 'is-disabled', readOnly && 'is-readonly', unmatched && 'is-unmatched')}>
        <input
          ref={mergedInputRef}
          id={inputId}
          name={name}
          type="text"
          role="combobox"
          className="bx-input__field"
          value={inputText}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={field.disabled}
          readOnly={readOnly}
          required={field.required}
          aria-required={field.required}
          aria-invalid={field['aria-invalid'] ?? (unmatched ? true : undefined)}
          aria-describedby={field['aria-describedby']}
          aria-label={props['aria-label']}
          aria-labelledby={labelledBy}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeOption}
          onChange={(e) => {
            setQuery(e.target.value);
            navigatedRef.current = true;
            if (!open) openList();
          }}
          onFocus={(e) => {
            e.currentTarget.select();
            if (openOnFocus) openList();
          }}
          onMouseDown={() => {
            if (document.activeElement === inputRef.current && !open) openList();
          }}
          onBlur={() => {
            setOpen(false);
            settleDraft();
          }}
          onKeyDown={onKeyDown}
        />
        {loading && open ? <Spinner size="xs" decorative className="bx-combobox__spinner" /> : null}
        <span className="bx-combobox__chevron" aria-hidden="true" onMouseDown={(e) => {
          e.preventDefault();
          if (open) closeList();
          else {
            inputRef.current?.focus();
            openList();
          }
        }}>
          <Icon name="chevrons-up-down" size="sm" />
        </span>
      </div>
      <span className="bx-sr-only" aria-live="polite">
        {open && query !== null ? (resultCount === 0 ? 'No matches' : `${resultCount} ${resultCount === 1 ? 'match' : 'matches'}`) : ''}
      </span>
      {open ? (
        <Portal>
          <div ref={popupRef} className="bx-combobox__popup" data-bx-overlay="" style={popupStyle}>
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-labelledby={labelledBy}
              aria-label={labelledBy ? undefined : props['aria-label']}
              className="bx-listbox"
              style={{ maxHeight: listMaxHeight }}
              onMouseDown={(e) => e.preventDefault()}
              onScroll={(e) => {
                if (virtual) setScrollTop(e.currentTarget.scrollTop);
              }}
            >
              {win.padTop > 0 ? <div role="presentation" style={{ height: win.padTop }} /> : null}
              {rows.slice(win.start, win.end).map((r) => {
                if (r.kind === 'header') {
                  return (
                    <div key={r.key} role="presentation" className="bx-listbox__group">
                      {r.label}
                    </div>
                  );
                }
                const o = options[r.optionIndex];
                const i = r.optionIndex;
                return (
                  <OptionRow
                    key={r.key}
                    id={optionId(i)}
                    index={i}
                    active={i === activeIndex}
                    selected={o.kind === 'item' && o.key === valueKey}
                    disabled={o.kind === 'item' && o.disabled}
                    posinset={i + 1}
                    setsize={options.length}
                    onPick={onPick}
                    onHover={onHover}
                    create={o.kind === 'create'}
                    meta={o.kind === 'item' && rightMeta ? rightMeta(o.item) : undefined}
                  >
                    {renderOption(o, i)}
                  </OptionRow>
                );
              })}
              {win.padBottom > 0 ? <div role="presentation" style={{ height: win.padBottom }} /> : null}
            </div>
            {options.length === 0 ? (
              <div className="bx-listbox__empty">{loadError ? <span className="bx-listbox__error">{loadError}</span> : loading ? 'Loading…' : emptyText}</div>
            ) : null}
            {showHints ? (
              <div className="bx-listbox__footer" aria-hidden="true">
                <span>
                  <kbd className="bx-kbd bx-kbd--sm">↑</kbd>
                  <kbd className="bx-kbd bx-kbd--sm">↓</kbd> move
                </span>
                <span>
                  <kbd className="bx-kbd bx-kbd--sm">Enter</kbd> select
                </span>
                {onCreate ? (
                  <span>
                    <kbd className="bx-kbd bx-kbd--sm">Alt</kbd>+<kbd className="bx-kbd bx-kbd--sm">C</kbd> create
                  </span>
                ) : null}
                {hasValue && clearable ? <span className="bx-listbox__footer-end">Clear text to remove</span> : null}
              </div>
            ) : null}
          </div>
        </Portal>
      ) : null}
    </div>
  );
}

/** Alias: the kit calls master pickers "Picker" in docs. */
export const Picker = Combobox;
