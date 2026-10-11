/**
 * The workspace for an open company (2.1, SPEC-21 §1.1–§1.2): ONE bar of chrome — the top bar — over the
 * screen stack, plus the optional shortcut bar (the 1.0 right rail). Each screen draws its own title row
 * (ui/PageHeader.tsx); the shell renders the top full screen's command bar into that row's
 * `[data-actions-slot]` (a portal), so exactly one `toolbar "Actions"` exists, none on Home, and a dialog
 * screen on top adds none (the page under it keeps its own). There is no breadcrumb row and no status bar: the path is the `‹` button's tooltip, the
 * hint is F1's first line, "Not saved" is a word in the title row and a `•` in the window title, and
 * "Working…" is a hairline under the top bar (with a hidden live status). Keyed by company + user so
 * everything resets when either changes.
 *
 * Keys are never registered here: screen actions register theirs in `useScreenActions` (nav.tsx) and
 * the globals in shell.tsx. The command bar and the shortcut bar only show the same actions, so a key
 * does the same thing whichever of them is visible. Two pointer/keyboard helpers live here: hold Ctrl to
 * peek at the keys (`<html data-keys>`, lib/keyPeek.ts) and the mouse Back button (= Esc).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ModuleDef } from './registry.ts';
import { financialYear } from '../../shared/dates.ts';
import { ActionRail, CommandBar, DropdownMenu, Icon, IconButton } from '../ui/index.ts';
import type { ActionRailItem, MenuEntry } from '../ui/index.ts';
import { cx } from '../ui/lib/cx.ts';
import { apiActivity, onApiActivity } from './api.ts';
import { installBuiltinGotoProviders } from './gotoProviders.ts';
import { commandBarSlots, layoutCommandBar } from './lib/commandBar.ts';
import { createMenuGroups } from './lib/createMenu.ts';
import type { CreateTarget } from './lib/createMenu.ts';
import { PEEK_DELAY_MS, PEEK_IDLE, peekArmed, peekAttribute, peekReduce } from './lib/keyPeek.ts';
import type { PeekEvent, PeekState } from './lib/keyPeek.ts';
import { capTitleRow, NOT_SAVED, windowTitle, WORKING_DELAY_MS, workingDateLabel, workingDateName } from './lib/screenHead.ts';
import { NavProvider, ScreenStack, useActionLookup, useAnyDirty, useEntryTitle, useNav, useNavStack, useScreenActionItems, useTopActionsSlot, useTopScreenActions } from './nav.tsx';
import { useUiPrefs } from './preferences.ts';
import { ShellProvider, useShell } from './shell.tsx';
import { useAppState, useCompany } from './state.tsx';
import { UserMenu } from './UserMenu.tsx';
import { WELL_KNOWN_SCREENS } from './wellKnown.ts';
import { useWorkingDate, WorkingContextProvider } from './working.tsx';

export function Workspace({ modules }: { modules: readonly ModuleDef[] }) {
  const company = useCompany();
  return (
    <WorkingContextProvider companyId={company.id} booksFrom={company.booksFrom} fyStartMonth={company.fyStartMonth}>
      <NavProvider modules={modules}>
        <ShellProvider>
          <WorkspaceLayout />
        </ShellProvider>
      </NavProvider>
    </WorkingContextProvider>
  );
}

function WorkspaceLayout() {
  const mainRef = useRef<HTMLElement | null>(null);
  const nav = useNav();
  const stack = useNavStack();
  const top = stack[stack.length - 1];
  const title = useEntryTitle(top);
  const company = useCompany();
  const dirty = useAnyDirty();
  const ui = useUiPrefs();

  useEffect(() => {
    installBuiltinGotoProviders(() => (id) => nav.isRegistered(id));
  }, [nav]);

  useEffect(() => {
    document.title = windowTitle(title, company.name, dirty);
  }, [title, company.name, dirty]);
  useEffect(
    () => () => {
      document.title = 'Pevqori';
    },
    [],
  );

  useKeyPeek();
  useMouseBack();

  return (
    <div className={cx('bx-shell', ui.shortcutBar && 'bx-shell--shortcut-bar')}>
      <a
        href="#bx-main"
        className="bx-skip-link"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <TopBar />
      <div className="bx-shell__body">
        <main id="bx-main" ref={mainRef} className="bx-shell__main" tabIndex={-1} aria-label={title}>
          <div className="bx-shell__screens">
            <ScreenStack />
          </div>
        </main>
        {ui.shortcutBar ? <ShortcutBar /> : null}
      </div>
      <TitleRowCommandBar />
    </div>
  );
}

// ───────────────────────────── Top bar ─────────────────────────────

function useApiActivity(): number {
  return useSyncExternalStore(onApiActivity, () => apiActivity().inFlight);
}

/** True once a request has been in flight for WORKING_DELAY_MS (and until none is). */
function useWorking(): boolean {
  const inFlight = useApiActivity();
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (inFlight === 0) {
      setWorking(false);
      return undefined;
    }
    const t = setTimeout(() => setWorking(true), WORKING_DELAY_MS);
    return () => clearTimeout(t);
  }, [inFlight > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return working && inFlight > 0;
}

/**
 * A top-bar button's key, shown only while Ctrl is held (`html[data-keys]`, the same `.bx-btn__kbd` rule
 * as every Button's key) — plain text, never a chip; the button's `aria-keyshortcuts` carries it for
 * assistive technology, so this copy is aria-hidden.
 */
function PeekKey({ keys }: { keys: string }) {
  return (
    <span className="bx-btn__kbd" aria-hidden="true">
      {keys}
    </span>
  );
}

/**
 * The 40 px top bar (SPEC-21 §1.1): Home mark · company ▾ · working date (F2) · ⌕ Go To · Create ▾ · ⚙ ·
 * user ▾ — seven controls, no key chips, no filled button. The period lives in each report's title row
 * (Alt+F2 stays global); Help is F1, the user menu and More ▾.
 */
function TopBar() {
  const app = useAppState();
  const company = useCompany();
  const shell = useShell();
  const nav = useNav();
  const date = useWorkingDate();
  const dirty = useAnyDirty();
  const working = useWorking();
  const fy = financialYear(date.date, company.fyStartMonth);
  const day = workingDateLabel(date.date);

  const companyItems: MenuEntry[] = useMemo(() => {
    const items: MenuEntry[] = [{ type: 'label', key: 'gstin', label: company.gstin ? `GSTIN ${company.gstin}` : 'No GSTIN' }];
    items.push({ key: 'switch', label: 'Switch company', shortcut: 'F3', onSelect: () => void shell.closeCompany() });
    if (nav.canOpen(WELL_KNOWN_SCREENS.companyProfile)) items.push({ key: 'details', label: 'Company details', onSelect: () => nav.push(WELL_KNOWN_SCREENS.companyProfile) });
    return items;
  }, [company.gstin, nav, shell]);

  const createItems: MenuEntry[] = useMemo(() => {
    const groups = createMenuGroups({
      voucherAvailable: (b) => shell.voucherAvailability(b).ok,
      canCreateVouchers: app.can('vouchers.create'),
      canCreateMasters: app.can('masters.create'),
      ledgerFormOpenable: nav.canOpen(WELL_KNOWN_SCREENS.ledgerForm),
      itemFormOpenable: nav.canOpen(WELL_KNOWN_SCREENS.itemForm),
      inventory: company.features.inventory,
    });
    const open = (t: CreateTarget) => {
      if (t.kind === 'voucher') shell.openVoucher(t.baseType);
      else if (t.kind === 'ledger') nav.push(WELL_KNOWN_SCREENS.ledgerForm, { groupCode: t.groupCode });
      else if (t.kind === 'item') nav.push(WELL_KNOWN_SCREENS.itemForm);
      else shell.openVoucherPicker();
    };
    return groups.flatMap((g, i): MenuEntry[] => [
      ...(i > 0 ? [{ type: 'separator' as const, key: `s-${i}` }] : []),
      ...g.map((it): MenuEntry => ({ key: it.key, label: it.label, shortcut: it.shortcut, onSelect: () => open(it.target) })),
    ]);
    // app.company changes when features or permissions change; voucherAvailability reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, nav, app.can, app.company, company.features.inventory]);

  const settingsOpenable = nav.isRegistered(WELL_KNOWN_SCREENS.settings) && nav.canOpen(WELL_KNOWN_SCREENS.settings);

  return (
    <header className="bx-topbar" role="banner">
      <div className="bx-topbar__brand" aria-label="Pevqori">
        <button type="button" className="bx-topbar__home" aria-label="Home" title="Home" onClick={() => void nav.reset()}>
          <Icon name="book" size="md" />
        </button>
      </div>

      <DropdownMenu
        items={companyItems}
        aria-label="Company"
        renderTrigger={(p) => (
          <button type="button" className="bx-topbar__company" {...p} title={company.mailingName ?? company.name}>
            <span className="bx-topbar__company-name">{company.name}</span>
            <span className="bx-topbar__fy">FY {fy.label}</span>
            <Icon name="chevron-down" size="xs" />
          </button>
        )}
      />

      <button type="button" className="bx-topbar__date" onClick={date.openDialog} aria-keyshortcuts="F2" aria-label={workingDateName(day, date.isToday)} title="Working date · F2">
        <span className="bx-topbar__weekday">{day.weekday} </span>
        <span className="bx-num">{day.date}</span>
        {!date.isToday ? <span className="bx-topbar__not-today"> not today</span> : null}
        <PeekKey keys="F2" />
      </button>

      <span className="bx-topbar__spacer" />

      <button type="button" className="bx-topbar__goto" onClick={() => shell.openGoto()} aria-keyshortcuts="Control+G" aria-label="Go To · search or jump to (Ctrl+G)" title="Go To · Ctrl+G">
        <Icon name="search" size="sm" />
        Go To
        <PeekKey keys="Ctrl+G" />
      </button>

      <div className="bx-topbar__end">
        {createItems.length > 0 ? <DropdownMenu items={createItems} label="Create" variant="ghost" size="sm" placement="bottom-end" aria-label="Create" /> : null}
        {settingsOpenable ? <IconButton icon="settings" aria-label="Settings" title="Settings" variant="ghost" size="sm" onClick={() => nav.push(WELL_KNOWN_SCREENS.settings)} /> : null}
        <UserMenu />
      </div>

      {working ? <span className="bx-topbar__progress" aria-hidden="true" /> : null}
      <span className="bx-sr-only" role="status" aria-live="polite">
        {working ? 'Working…' : dirty ? NOT_SAVED : ''}
      </span>
    </header>
  );
}

// ───────────────────────────── Title row: command bar ─────────────────────────────

/** A screen's actions, with clicks calling the latest handler (the store keeps fresh closures). */
function useLiveActions(screenKey: string, items: readonly ActionRailItem[]): ActionRailItem[] {
  const lookup = useActionLookup();
  return useMemo(
    () =>
      items.map((it) => ({
        ...it,
        onClick: () => lookup(screenKey).find((x) => x.key === it.key && (x.id ?? '') === (it.id ?? '') && x.label === it.label)?.onClick(),
      })),
    [items, screenKey, lookup],
  );
}

/** Shell globals offered under More / in the shortcut bar (their keys are registered in shell.tsx). */
function useGlobalActions(): ActionRailItem[] {
  const shell = useShell();
  const nav = useNav();
  return useMemo(
    () => [
      // Shown only to users who may open them (the keys themselves are unchanged, shell.tsx).
      { key: 'F11', label: 'Features', icon: 'sliders', onClick: () => nav.push(WELL_KNOWN_SCREENS.companyFeatures), group: 'global', hidden: !nav.canOpen(WELL_KNOWN_SCREENS.companyFeatures) },
      { key: 'F12', label: 'Configure', icon: 'settings', onClick: () => nav.push(WELL_KNOWN_SCREENS.companyConfig), group: 'global', hidden: !nav.canOpen(WELL_KNOWN_SCREENS.companyConfig) },
      { key: 'F1', label: 'Help', icon: 'help', onClick: () => shell.openShortcuts(), group: 'global' },
    ],
    [shell, nav],
  );
}

/**
 * How many secondary buttons fit (commandBarSlots of the title row's width), followed live with a
 * ResizeObserver. Only a change of the count re-renders — not every pixel of a resize.
 */
function useCommandBarSlots(row: HTMLElement | null): number {
  const [slots, setSlots] = useState(() => commandBarSlots(1024));
  useLayoutEffect(() => {
    if (!row) return undefined;
    const update = (w: number) => {
      if (w > 0) setSlots(commandBarSlots(w));
    };
    update(row.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') update(w);
    });
    ro.observe(row);
    return () => ro.disconnect();
  }, [row]);
  return slots;
}

/**
 * The command bar, portaled into the title-row slot (or fallback row) of the top full screen; none on Home.
 * A dialog screen on top leaves the page's bar in place (see useTopActionsSlot).
 */
function TitleRowCommandBar() {
  const target = useTopActionsSlot();
  if (!target) return null;
  return createPortal(<ScreenCommandBar slot={target.el} screenKey={target.screenKey} />, target.el);
}

function ScreenCommandBar({ slot, screenKey }: { slot: HTMLElement; screenKey: string }) {
  const screen = useLiveActions(screenKey, useScreenActionItems(screenKey));
  const globals = useGlobalActions();
  const row = slot.closest<HTMLElement>('.bx-titlebar, .bx-actions-row') ?? slot;
  const slots = useCommandBarSlots(row);
  const layout = useMemo(() => capTitleRow(layoutCommandBar(screen, globals, slots)), [screen, globals, slots]);
  return <CommandBar primary={layout.primary} buttons={layout.buttons} more={layout.more} aria-label="Actions" className="bx-shell__cmdbar" />;
}

// ───────────────────────────── Shortcut bar (the 1.0 rail, optional) ─────────────────────────────

function ShortcutBar() {
  const top = useTopScreenActions();
  const screen = useLiveActions(top.key, top.items);
  const globals = useGlobalActions();
  const all = useMemo<ActionRailItem[]>(() => {
    // F2, Alt+F2 and Ctrl+G are globals of their own; the rest of the globals close the list.
    const taken = new Set(screen.filter((s) => !s.hidden && s.key.trim() !== '').map((s) => s.key));
    return [...screen, ...globals.filter((g) => !taken.has(g.key))];
  }, [screen, globals]);
  return <ActionRail items={all} registerHotkeys={false} aria-label="Shortcut bar" className="bx-shell__rail" />;
}

// ───────────────────────────── Hold Ctrl to peek · mouse Back ─────────────────────────────

/** Feeds window events to the key-peek machine (lib/keyPeek.ts) and writes `<html data-keys>`. */
function useKeyPeek(): void {
  useEffect(() => {
    const root = document.documentElement;
    let state: PeekState = PEEK_IDLE;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const now = (): number => performance.now();
    const feed = (ev: PeekEvent) => {
      const prev = state;
      state = peekReduce(state, ev);
      if (state === prev) return;
      if (peekArmed(prev, state)) {
        clearTimeout(timer);
        // A few ms of slack: the machine checks the elapsed time itself.
        timer = setTimeout(() => feed({ type: 'tick', at: now() }), PEEK_DELAY_MS + 10);
      } else if (state.phase !== 'armed') clearTimeout(timer);
      const attr = peekAttribute(state, reduced());
      if (attr) root.setAttribute('data-keys', attr);
      else root.removeAttribute('data-keys');
    };
    const onKeyDown = (e: KeyboardEvent) => feed({ type: 'keydown', key: e.key, code: e.code, repeat: e.repeat, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, at: now() });
    const onKeyUp = (e: KeyboardEvent) => feed({ type: 'keyup', key: e.key, at: now() });
    const cancel = () => feed({ type: 'cancel' });
    const reset = () => feed({ type: 'reset' });
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('keydown', onKeyDown, opts);
    window.addEventListener('keyup', onKeyUp, opts);
    window.addEventListener('pointerdown', cancel, opts);
    window.addEventListener('wheel', cancel, opts);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown, opts);
      window.removeEventListener('keyup', onKeyUp, opts);
      window.removeEventListener('pointerdown', cancel, opts);
      window.removeEventListener('wheel', cancel, opts);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
      root.removeAttribute('data-keys');
    };
  }, []);
}

/**
 * The mouse's Back button (button 3) does what Esc does where the pointer's focus is: back one screen
 * (asking first when the form is dirty), or close the open dialog or menu. Chromium's own history
 * navigation for it is suppressed.
 */
function useMouseBack(): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button === 3) e.preventDefault();
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 3) return;
      e.preventDefault();
      const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mouseup', onUp, true);
    };
  }, []);
}
