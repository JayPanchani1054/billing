/**
 * The workspace for an open company: top bar, screen bar (breadcrumbs + command bar) over the screen
 * stack, the optional shortcut bar (the 1.0 right rail) and the status bar. Keyed by company + user so
 * everything resets when either changes.
 *
 * Keys are never registered here: screen actions register theirs in `useScreenActions` (nav.tsx) and
 * the globals in shell.tsx. The command bar and the shortcut bar only show the same actions, so a key
 * does the same thing whichever of them is visible.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { ModuleDef } from './registry.ts';
import { formatDate, financialYear } from '../../shared/dates.ts';
import { ActionRail, CommandBar, DropdownMenu, Icon, IconButton, Kbd, Modal, Spinner } from '../ui/index.ts';
import type { ActionRailItem, MenuEntry } from '../ui/index.ts';
import { cx } from '../ui/lib/cx.ts';
import { AppearancePanel } from './AppearancePanel.tsx';
import { apiActivity, onApiActivity } from './api.ts';
import { formatRelative } from './display.ts';
import { installBuiltinGotoProviders } from './gotoProviders.ts';
import { commandBarSlots, layoutCommandBar } from './lib/commandBar.ts';
import { createMenuGroups } from './lib/createMenu.ts';
import type { CreateTarget } from './lib/createMenu.ts';
import { NavBreadcrumbs, NavProvider, ScreenStack, useActionLookup, useAnyDirty, useEntryTitle, useNav, useNavStack, useTopScreenActions, useTopScreenHint } from './nav.tsx';
import { setPreferences, setUiPrefs, usePreferences, useUiPrefs } from './preferences.ts';
import { ShellProvider, useShell } from './shell.tsx';
import { useAppState, useCompany } from './state.tsx';
import { WELL_KNOWN_SCREENS } from './wellKnown.ts';
import { usePeriod, useWorkingDate, WorkingContextProvider } from './working.tsx';

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
  const barRef = useRef<HTMLDivElement | null>(null);
  const nav = useNav();
  const stack = useNavStack();
  const top = stack[stack.length - 1];
  const title = useEntryTitle(top);
  const company = useCompany();
  const ui = useUiPrefs();

  useEffect(() => {
    installBuiltinGotoProviders(() => (id) => nav.isRegistered(id));
  }, [nav]);

  useEffect(() => {
    document.title = `${title} · ${company.name} · Pevqori`;
    return () => {
      document.title = 'Pevqori';
    };
  }, [title, company.name]);

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
          <div className="bx-shell__crumbs" ref={barRef}>
            <NavBreadcrumbs />
            <ScreenCommandBar barRef={barRef} />
          </div>
          <div className="bx-shell__screens">
            <ScreenStack />
          </div>
        </main>
        {ui.shortcutBar ? <ShortcutBar /> : null}
      </div>
      <StatusBar />
    </div>
  );
}

// ───────────────────────────── Top bar ─────────────────────────────

function TopBar() {
  const app = useAppState();
  const company = useCompany();
  const shell = useShell();
  const nav = useNav();
  const date = useWorkingDate();
  const period = usePeriod();
  const prefs = usePreferences();
  const ui = useUiPrefs();
  const session = app.session;
  const fy = financialYear(date.date, company.fyStartMonth);
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const companyItems: MenuEntry[] = useMemo(() => {
    const items: MenuEntry[] = [{ type: 'label', key: 'gstin', label: company.gstin ? `GSTIN ${company.gstin}` : 'No GSTIN' }];
    items.push({ key: 'switch', label: 'Switch company', icon: 'building', shortcut: 'F3', onSelect: () => void shell.closeCompany() });
    if (nav.canOpen(WELL_KNOWN_SCREENS.companyProfile)) items.push({ key: 'details', label: 'Company details', icon: 'edit', onSelect: () => nav.push(WELL_KNOWN_SCREENS.companyProfile) });
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
      ...g.map((it): MenuEntry => ({ key: it.key, label: it.label, icon: it.icon, shortcut: it.shortcut, onSelect: () => open(it.target) })),
    ]);
    // app.company changes when features or permissions change; voucherAvailability reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, nav, app.can, app.company, company.features.inventory]);

  const userItems: MenuEntry[] = useMemo(() => {
    const secured = session && !session.implicit;
    const items: MenuEntry[] = [];
    if (secured) items.push({ type: 'label', key: 'who', label: `${session.displayName || session.username} · ${session.role}` });
    items.push({ type: 'label', key: 'theme-label', label: 'Theme' });
    items.push({ key: 'theme-system', label: 'Match Windows', icon: 'grid', checked: prefs.theme === 'system', onSelect: () => setPreferences({ theme: 'system' }) });
    items.push({ key: 'theme-light', label: 'Light', icon: 'sun', checked: prefs.theme === 'light', onSelect: () => setPreferences({ theme: 'light' }) });
    items.push({ key: 'theme-dark', label: 'Dark', icon: 'moon', checked: prefs.theme === 'dark', onSelect: () => setPreferences({ theme: 'dark' }) });
    items.push({ type: 'label', key: 'density-label', label: 'Density' });
    items.push({ key: 'density-comfortable', label: 'Comfortable', icon: 'list', checked: prefs.density === 'comfortable', onSelect: () => setPreferences({ density: 'comfortable' }) });
    items.push({ key: 'density-compact', label: 'Compact', icon: 'columns', checked: prefs.density === 'compact', onSelect: () => setPreferences({ density: 'compact' }) });
    items.push({ type: 'label', key: 'home-label', label: 'Home view (Ctrl+1 / Ctrl+2 on Home)' });
    items.push({ key: 'home-essentials', label: 'Essentials', icon: 'home', checked: ui.homeView === 'essentials', onSelect: () => setUiPrefs({ homeView: 'essentials' }) });
    items.push({ key: 'home-all', label: 'All menus', icon: 'menu', checked: ui.homeView === 'all', onSelect: () => setUiPrefs({ homeView: 'all' }) });
    items.push({ type: 'separator', key: 's1' });
    items.push({ key: 'shortcut-bar', label: 'Show shortcut bar', icon: 'panel-right', checked: ui.shortcutBar, onSelect: () => setUiPrefs({ shortcutBar: !ui.shortcutBar }) });
    items.push({ key: 'appearance', label: 'Appearance…', icon: 'sliders', onSelect: () => setAppearanceOpen(true) });
    items.push({ type: 'separator', key: 's2' });
    items.push({ key: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: 'F1', onSelect: () => shell.openShortcuts() });
    if (nav.isRegistered(WELL_KNOWN_SCREENS.companyAbout)) items.push({ key: 'about', label: 'About Pevqori', icon: 'info', onSelect: () => nav.push(WELL_KNOWN_SCREENS.companyAbout) });
    if (secured) {
      items.push({ type: 'separator', key: 's3' });
      items.push({ key: 'password', label: 'Change password', icon: 'key', onSelect: () => nav.push('company.changePassword') });
      items.push({ key: 'lock', label: 'Lock', icon: 'lock', onSelect: () => void shell.lock() });
      items.push({ key: 'logout', label: 'Log out', icon: 'logout', onSelect: () => void shell.logout() });
    }
    return items;
  }, [session, prefs, ui, nav, shell]);

  const initials = (session && !session.implicit ? session.displayName || session.username : company.name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  const settingsOpenable = nav.isRegistered(WELL_KNOWN_SCREENS.settings) && nav.canOpen(WELL_KNOWN_SCREENS.settings);

  return (
    <header className="bx-topbar" role="banner">
      <div className="bx-topbar__brand" aria-label="Pevqori">
        <span className="bx-topbar__mark" aria-hidden="true">
          <Icon name="book" size="md" />
        </span>
        <span className="bx-topbar__wordmark">Pevqori</span>
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

      <div className="bx-topbar__context" role="group" aria-label="Working date and period">
        <button type="button" className="bx-chip" onClick={date.openDialog} aria-keyshortcuts="F2" title="Change working date (F2)">
          <Icon name="calendar" size="sm" />
          <span className="bx-chip__label bx-num">{formatDate(date.date, 'D-MMM-YY')}</span>
          {!date.isToday ? <span className="bx-chip__flag">not today</span> : null}
          <Kbd keys="F2" size="sm" tone="subtle" />
        </button>
        <button type="button" className="bx-chip bx-chip--period" onClick={period.openDialog} aria-keyshortcuts="Alt+F2" title="Change period (Alt+F2)">
          <Icon name="clock" size="sm" />
          <span className="bx-chip__label bx-num">{period.label}</span>
          <Kbd keys="Alt+F2" size="sm" tone="subtle" className="bx-hide-narrow" />
        </button>
      </div>

      <button type="button" className="bx-topbar__search" onClick={() => shell.openGoto()} aria-keyshortcuts="Control+G" aria-label="Search or jump to (Ctrl+G)">
        <Icon name="search" size="sm" />
        <span className="bx-topbar__search-text">Search or jump to…</span>
        <Kbd keys="Ctrl+G" size="sm" tone="subtle" />
      </button>

      <div className="bx-topbar__end">
        {createItems.length > 0 ? <DropdownMenu items={createItems} label="Create" icon="plus" variant="primary" size="sm" placement="bottom-end" aria-label="Create" /> : null}
        {settingsOpenable ? <IconButton icon="settings" aria-label="Settings" variant="ghost" size="sm" onClick={() => nav.push(WELL_KNOWN_SCREENS.settings)} /> : null}
        <IconButton icon="help" aria-label="Keyboard shortcuts and help" variant="ghost" size="sm" shortcut="F1" onClick={() => shell.openShortcuts()} />
        <DropdownMenu
          items={userItems}
          aria-label="User menu"
          placement="bottom-end"
          renderTrigger={(p) => (
            <button type="button" className="bx-topbar__user" {...p} aria-label="User menu">
              <span className="bx-avatar" aria-hidden="true">
                {initials || <Icon name="user" size="sm" />}
              </span>
              <Icon name="chevron-down" size="xs" />
            </button>
          )}
        />
      </div>
      {appearanceOpen ? (
        <Modal open onClose={() => setAppearanceOpen(false)} title="Appearance" description="How Pevqori looks on this computer, for you." size="sm">
          <AppearancePanel />
        </Modal>
      ) : null}
    </header>
  );
}

// ───────────────────────────── Screen bar: command bar ─────────────────────────────

/** The top screen's actions, with clicks calling the latest handler (the store keeps fresh closures). */
function useTopActionsLive(): ActionRailItem[] {
  const lookup = useActionLookup();
  const { key: screenKey, items } = useTopScreenActions();
  return useMemo(
    () =>
      items.map((it) => ({
        ...it,
        onClick: () => lookup(screenKey).find((x) => x.key === it.key && (x.id ?? '') === (it.id ?? ''))?.onClick(),
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
 * How many secondary command-bar buttons fit the screen bar (commandBarSlots of its width), followed
 * live with a ResizeObserver. Only a change of the count re-renders — not every pixel of a resize.
 */
function useCommandBarSlots(ref: RefObject<HTMLElement | null>): number {
  const [slots, setSlots] = useState(() => commandBarSlots(1024));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = (w: number) => {
      if (w > 0) setSlots(commandBarSlots(w));
    };
    update(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') update(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return slots;
}

function ScreenCommandBar({ barRef }: { barRef: RefObject<HTMLDivElement | null> }) {
  const screen = useTopActionsLive();
  const globals = useGlobalActions();
  const slots = useCommandBarSlots(barRef);
  const layout = useMemo(() => layoutCommandBar(screen, globals, slots), [screen, globals, slots]);
  return <CommandBar primary={layout.primary} buttons={layout.buttons} more={layout.more} aria-label="Actions" className="bx-shell__cmdbar" />;
}

// ───────────────────────────── Shortcut bar (the 1.0 rail, optional) ─────────────────────────────

function ShortcutBar() {
  const screen = useTopActionsLive();
  const globals = useGlobalActions();
  const all = useMemo<ActionRailItem[]>(() => {
    // F2, Alt+F2 and Ctrl+G live in the top bar; the rest of the globals close the list.
    const taken = new Set(screen.filter((s) => !s.hidden).map((s) => s.key));
    return [...screen, ...globals.filter((g) => !taken.has(g.key))];
  }, [screen, globals]);
  return <ActionRail items={all} registerHotkeys={false} aria-label="Shortcut bar" className="bx-shell__rail" />;
}

// ───────────────────────────── Status bar ─────────────────────────────

function useApiActivity(): { inFlight: number; lastMutationAt: number } {
  const snap = useSyncExternalStore(onApiActivity, () => {
    const a = apiActivity();
    return `${a.inFlight}:${a.lastMutationAt}`;
  });
  const [inFlight, last] = snap.split(':').map(Number);
  return { inFlight, lastMutationAt: last };
}

/** Hint · save state (the data folder in its tooltip) · version. */
function StatusBar() {
  const app = useAppState();
  const dirty = useAnyDirty();
  const hint = useTopScreenHint();
  const stack = useNavStack();
  const { inFlight, lastMutationAt } = useApiActivity();
  const state = app.state;
  const defaultHint = stack.length > 1 ? 'Esc Back · Ctrl+G Go To · F1 Help' : '↑↓ Move · Enter Open · Ctrl+G Go To · F1 Help';
  const savedText = lastMutationAt ? `Saved ${formatRelative(new Date(lastMutationAt).toISOString())}` : 'All changes saved';

  return (
    <footer className="bx-statusbar" role="contentinfo">
      <span className="bx-statusbar__hint">{hint ?? defaultHint}</span>
      <span className="bx-statusbar__spacer" />
      <span className="bx-statusbar__item bx-statusbar__state" role="status" aria-live="polite" title={state ? `Data folder: ${state.dataDir}` : undefined}>
        {inFlight > 0 ? (
          <>
            <Spinner size="xs" decorative /> Working…
          </>
        ) : dirty ? (
          <>
            <Icon name="edit" size="xs" /> Unsaved changes
          </>
        ) : (
          <>
            <Icon name="check" size="xs" /> {savedText}
          </>
        )}
      </span>
      {state ? <span className="bx-statusbar__item bx-statusbar__version">v{state.appVersion}</span> : null}
    </footer>
  );
}
