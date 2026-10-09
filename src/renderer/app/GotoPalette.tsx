/**
 * Go To palette (Ctrl+G / Alt+G / Ctrl+K): fuzzy search over menu items, screens, vouchers types,
 * shell commands and async providers (ledgers, items, vouchers…). Keyboard only: type, ↑/↓, Enter.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { VoucherBaseType } from '../../shared/constants.ts';
import { Icon, Kbd, Modal, Spinner, splitHighlight, useDebouncedValue, useListNavigation } from '../ui/index.ts';
import { cx } from '../ui/lib/cx.ts';
import { useVoucherChoices } from './hooks/useVoucherChoices.ts';
import { getGotoProviders, onGotoProvidersChange, pushRecent, rankGoto, resolveGotoTarget, searchProviders, usableProviders } from './lib/goto.ts';
import type { GotoItem, GotoProvider, RankedGoto } from './lib/goto.ts';
import { buildStaticGotoItems, parseRecent, usableRecents } from './lib/gotoItems.ts';
import { customVoucherGotoItems, parseVoucherCommand } from './lib/voucherTypes.ts';
import { useModules, useNav } from './nav.tsx';
import { useShell, VOUCHER_ENTRY_SCREEN } from './shell.tsx';
import { useAppState } from './state.tsx';
import { usePeriod, useWorkingDate } from './working.tsx';

const RECENT_MAX = 8;

function recentKey(companyId: string): string {
  return `bahi.goto.${companyId}`;
}

function loadRecent(companyId: string): GotoItem[] {
  try {
    const raw = window.localStorage.getItem(recentKey(companyId));
    return raw ? parseRecent(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveRecent(companyId: string, list: readonly GotoItem[]): void {
  try {
    window.localStorage.setItem(recentKey(companyId), JSON.stringify(list));
  } catch {
    // not remembered
  }
}

function useProviders(): GotoProvider[] {
  const [list, setList] = useState(getGotoProviders);
  useEffect(() => onGotoProvidersChange(() => setList(getGotoProviders())), []);
  return list;
}

interface Row {
  kind: 'header' | 'item';
  key: string;
  label?: string;
  ranked?: RankedGoto;
  index?: number;
}

export function GotoPalette({ initialQuery = '', onClose }: { initialQuery?: string; onClose: () => void }) {
  const nav = useNav();
  const shell = useShell();
  const app = useAppState();
  const modules = useModules();
  const date = useWorkingDate();
  const period = usePeriod();
  const providers = useProviders();
  const companyId = app.company?.id ?? '';
  const [query, setQuery] = useState(initialQuery);
  const debounced = useDebouncedValue(query, 150);
  const [asyncItems, setAsyncItems] = useState<GotoItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [recent, setRecent] = useState<GotoItem[]>(() => loadRecent(companyId));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const voucherTypes = useVoucherChoices();
  const staticItems = useMemo(() => {
    const available = (b: VoucherBaseType) => shell.voucherAvailability(b).ok;
    return buildStaticGotoItems(
      modules,
      { can: app.can, gstEnabled: app.company?.gstEnabled ?? false, features: app.company?.features ?? null },
      {
        // The vouchers module's Transactions menu already lists every voucher type (filtered by
        // permission and features) — the shell's own commands would show each one twice.
        includeVouchers: !nav.isRegistered(VOUCHER_ENTRY_SCREEN),
        voucherAvailable: available,
        extra: customVoucherGotoItems(voucherTypes.filter((t) => available(t.baseType))),
      },
    );
  }, [modules, app.can, app.company, nav, shell, voucherTypes]);

  // Recents are kept per company (not per user): show only those THIS user can open now.
  const shownRecent = useMemo(
    () =>
      usableRecents(recent, {
        canOpen: nav.canOpen,
        voucherAvailable: (b) => shell.voucherAvailability(b).ok,
        voucherTypeIds: new Set(voucherTypes.flatMap((t) => (t.voucherTypeId === undefined ? [] : [t.voucherTypeId]))),
      }),
    [recent, nav, shell, voucherTypes, app.can, app.company],
  );

  // Only providers whose results this user may open (no forbidden or pointless API calls).
  const usable = useMemo(() => usableProviders(providers, nav.canOpen), [providers, nav, app.can, app.company]);

  useEffect(() => {
    const q = debounced.trim();
    if (q.length < 2 || usable.length === 0) {
      setAsyncItems([]);
      setSearching(false);
      return undefined;
    }
    const ctrl = new AbortController();
    setSearching(true);
    searchProviders(q, ctrl.signal, usable)
      .then((items) => {
        // A result opens its screen, else its fallback; results the user cannot open are dropped.
        if (!ctrl.signal.aborted) setAsyncItems(items.map((i) => resolveGotoTarget(i, nav.canOpen)).filter((i): i is GotoItem => i !== null));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setSearching(false);
      });
    return () => ctrl.abort();
  }, [debounced, usable, nav]);

  const ranked = useMemo<RankedGoto[]>(() => {
    const q = query.trim();
    if (!q) {
      const recentIds = new Set(shownRecent.map((r) => r.id));
      const recents = shownRecent.map((item) => ({ item: { ...item, group: 'Recent' }, score: 0, ranges: [] }));
      return [...recents, ...rankGoto(staticItems.filter((i) => !recentIds.has(i.id)), '', [], 60)];
    }
    const all = [...staticItems, ...asyncItems.filter((a) => !staticItems.some((s) => s.id === a.id))];
    return rankGoto(all, q, shownRecent.map((r) => r.id), 40);
  }, [query, staticItems, asyncItems, shownRecent]);

  // Group in rank order: a group's position is that of its best item.
  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, RankedGoto[]>();
    for (const r of ranked) {
      const g = groups.get(r.item.group);
      if (g) g.push(r);
      else groups.set(r.item.group, [r]);
    }
    const out: Row[] = [];
    let index = 0;
    for (const [label, list] of groups) {
      out.push({ kind: 'header', key: `h:${label}`, label });
      for (const r of list) out.push({ kind: 'item', key: r.item.id, ranked: r, index: index++ });
    }
    return out;
  }, [ranked]);

  const items = useMemo(() => rows.filter((r) => r.kind === 'item').map((r) => r.ranked as RankedGoto), [rows]);
  const listNav = useListNavigation({ count: items.length, defaultActiveIndex: 0, pageSize: 8, homeEnd: false });
  const { activeIndex, setActiveIndex } = listNav;

  useEffect(() => {
    setActiveIndex(items.length > 0 ? 0 : -1);
  }, [query, items.length, setActiveIndex]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listId]);

  const open = (item: GotoItem) => {
    const next = pushRecent(recent, item, RECENT_MAX);
    setRecent(next);
    saveRecent(companyId, next);
    onClose();
    if (item.command) {
      runCommand(item.command);
      return;
    }
    nav.push(item.screen, item.params ?? {});
  };

  const runCommand = (command: string) => {
    if (command === 'date') date.openDialog();
    else if (command === 'period') period.openDialog();
    else if (command === 'switch-company') void shell.closeCompany();
    else if (command === 'shortcuts') shell.openShortcuts();
    else if (command === 'vouchers') shell.openVoucherPicker();
    else {
      const v = parseVoucherCommand(command);
      if (v) shell.openVoucher(v.baseType, v.voucherTypeId !== undefined ? { voucherTypeId: v.voucherTypeId } : {});
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (listNav.onKeyDown(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = items[activeIndex];
      if (r) open(r.item);
    }
  };

  const activeId = activeIndex >= 0 && activeIndex < items.length ? `${listId}-opt-${activeIndex}` : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title="Go To"
      size="md"
      flush
      hideClose
      initialFocusRef={inputRef}
      className="bx-goto"
      footerStart={
        <span className="bx-goto__hints">
          <Kbd keys="ArrowUp" size="sm" tone="subtle" />
          <Kbd keys="ArrowDown" size="sm" tone="subtle" /> Move
          <Kbd keys="Enter" size="sm" tone="subtle" /> Open
          <Kbd keys="Escape" size="sm" tone="subtle" /> Close
        </span>
      }
    >
      <div className="bx-goto__search">
        <Icon name="search" size="md" className="bx-goto__search-icon" />
        <input
          ref={inputRef}
          className="bx-goto__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="Search screens, reports, masters and vouchers"
          placeholder="Type a screen, report, ledger or voucher…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {searching ? <Spinner size="sm" label="Searching" /> : null}
      </div>
      <div className="bx-goto__results" id={listId} role="listbox" aria-label="Results">
        {items.length === 0 ? (
          <p className="bx-goto__empty">{query.trim() ? `Nothing matches “${query.trim()}”. Try fewer letters.` : 'Start typing to search.'}</p>
        ) : (
          rows.map((row) =>
            row.kind === 'header' ? (
              <div key={row.key} className="bx-goto__group" role="presentation">
                {row.label}
              </div>
            ) : (
              <GotoOption
                key={row.key}
                id={`${listId}-opt-${row.index}`}
                ranked={row.ranked as RankedGoto}
                active={row.index === activeIndex}
                onPick={() => open((row.ranked as RankedGoto).item)}
                onHover={() => setActiveIndex(row.index ?? 0)}
              />
            ),
          )
        )}
      </div>
    </Modal>
  );
}

function GotoOption({ id, ranked, active, onPick, onHover }: { id: string; ranked: RankedGoto; active: boolean; onPick: () => void; onHover: () => void }) {
  const { item, ranges } = ranked;
  const segs = splitHighlight(item.label, ranges);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={cx('bx-goto__option', active && 'is-active')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      onMouseMove={onHover}
    >
      <span className="bx-goto__label">
        {segs.map((s, i) =>
          s.match ? (
            <mark key={i} className="bx-match">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
        {item.description ? <span className="bx-goto__desc">{item.description}</span> : null}
      </span>
      {item.hotkey ? <Kbd keys={item.hotkey} size="sm" tone="subtle" /> : null}
    </div>
  );
}
