/**
 * The workspace for an open company: top bar, breadcrumbs + screen stack, the action rail and
 * the status bar. Keyed by company + user so everything resets when either changes.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ModuleDef } from './registry.ts';
import { formatDate, financialYear } from '../../shared/dates.ts';
import { ActionRail, Badge, Button, DropdownMenu, Icon, Kbd, Spinner, Tooltip } from '../ui/index.ts';
import type { ActionRailItem, MenuEntry } from '../ui/index.ts';
import { apiActivity, onApiActivity } from './api.ts';
import { formatRelative } from './display.ts';
import { installBuiltinGotoProviders } from './gotoProviders.ts';
import { NavBreadcrumbs, NavProvider, ScreenStack, useActionLookup, useAnyDirty, useEntryTitle, useNav, useNavStack, useTopScreenActions, useTopScreenHint } from './nav.tsx';
import { setPreferences, usePreferences } from './preferences.ts';
import { ShellProvider, useShell } from './shell.tsx';
import { useAppState, useCompany } from './state.tsx';
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
  const nav = useNav();
  const stack = useNavStack();
  const top = stack[stack.length - 1];
  const title = useEntryTitle(top);
  const company = useCompany();

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
    <div className="bx-shell">
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
          <div className="bx-shell__crumbs">
            <NavBreadcrumbs />
          </div>
          <div className="bx-shell__screens">
            <ScreenStack />
          </div>
        </main>
        <ShellRail />
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
  const session = app.session;
  const fy = financialYear(date.date, company.fyStartMonth);

  const userItems: MenuEntry[] = useMemo(() => {
    const secured = session && !session.implicit;
    const items: MenuEntry[] = [];
    if (secured) {
      items.push({ type: 'label', key: 'who', label: `${session.displayName || session.username} · ${session.role}` });
      items.push({ key: 'password', label: 'Change password', icon: 'key', onSelect: () => nav.push('company.changePassword') });
      items.push({ key: 'logout', label: 'Log out', icon: 'logout', onSelect: () => void shell.logout() });
      items.push({ type: 'separator', key: 's1' });
    }
    items.push({ type: 'label', key: 'theme-label', label: 'Theme' });
    items.push({ key: 'theme-system', label: 'Match Windows', icon: 'grid', checked: prefs.theme === 'system', onSelect: () => setPreferences({ theme: 'system' }) });
    items.push({ key: 'theme-light', label: 'Light', icon: 'sun', checked: prefs.theme === 'light', onSelect: () => setPreferences({ theme: 'light' }) });
    items.push({ key: 'theme-dark', label: 'Dark', icon: 'moon', checked: prefs.theme === 'dark', onSelect: () => setPreferences({ theme: 'dark' }) });
    items.push({ type: 'separator', key: 's2' });
    items.push({ type: 'label', key: 'density-label', label: 'Density' });
    items.push({ key: 'density-comfortable', label: 'Comfortable', icon: 'list', checked: prefs.density === 'comfortable', onSelect: () => setPreferences({ density: 'comfortable' }) });
    items.push({ key: 'density-compact', label: 'Compact', icon: 'columns', checked: prefs.density === 'compact', onSelect: () => setPreferences({ density: 'compact' }) });
    items.push({ type: 'separator', key: 's3' });
    items.push({ key: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: 'F1', onSelect: () => shell.openShortcuts() });
    items.push({ key: 'about', label: 'About Pevqori', icon: 'info', onSelect: () => nav.push('company.about') });
    return items;
  }, [session, prefs, nav, shell]);

  const initials = (session && !session.implicit ? session.displayName || session.username : company.name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <header className="bx-topbar" role="banner">
      <div className="bx-topbar__brand" aria-label="Pevqori">
        <span className="bx-topbar__mark" aria-hidden="true">
          <Icon name="book" size="md" />
        </span>
        <span className="bx-topbar__wordmark">Pevqori</span>
      </div>

      <div className="bx-topbar__company">
        <span className="bx-topbar__company-name" title={company.mailingName ?? company.name}>
          {company.name}
        </span>
        <span className="bx-topbar__company-meta">
          <span className="bx-topbar__fy">FY {fy.label}</span>
          {company.gstin ? (
            <Badge tone="neutral" variant="outline" size="sm" className="bx-topbar__gstin">
              GSTIN {company.gstin}
            </Badge>
          ) : (
            <Badge tone="neutral" variant="outline" size="sm">
              No GSTIN
            </Badge>
          )}
        </span>
      </div>

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

      <button type="button" className="bx-topbar__goto" onClick={() => shell.openGoto()} aria-keyshortcuts="Control+G" aria-label="Go To (Ctrl+G)">
        <Icon name="search" size="sm" />
        <span className="bx-topbar__goto-text">Go to…</span>
        <Kbd keys="Ctrl+G" size="sm" tone="subtle" />
      </button>

      <div className="bx-topbar__end">
        <Tooltip content="Switch company (F3)">
          <Button variant="ghost" size="sm" icon="building" onClick={() => void shell.closeCompany()} aria-keyshortcuts="F3">
            <span className="bx-hide-narrow">Switch</span>
          </Button>
        </Tooltip>
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
    </header>
  );
}

// ───────────────────────────── Rail ─────────────────────────────

function ShellRail() {
  const date = useWorkingDate();
  const period = usePeriod();
  const shell = useShell();
  const nav = useNav();
  const lookup = useActionLookup();
  const { key: screenKey, items } = useTopScreenActions();

  const all = useMemo<ActionRailItem[]>(() => {
    // Screen items call the latest handler at click time (the store keeps fresh closures).
    const screen = items.map((it) => ({
      ...it,
      onClick: () => lookup(screenKey).find((x) => x.key === it.key && (x.id ?? '') === (it.id ?? ''))?.onClick(),
    }));
    const taken = new Set(screen.filter((s) => !s.hidden).map((s) => s.key));
    const globals: ActionRailItem[] = [
      { key: 'F2', label: 'Date', icon: 'calendar', onClick: date.openDialog, group: 'global' },
      { key: 'Alt+F2', label: 'Period', icon: 'clock', onClick: period.openDialog, group: 'global' },
      { key: 'Ctrl+G', label: 'Go To', icon: 'search', onClick: () => shell.openGoto(), group: 'global' },
      { key: 'F11', label: 'Features', icon: 'sliders', onClick: () => nav.push('company.features'), group: 'global' },
      { key: 'F12', label: 'Configure', icon: 'settings', onClick: () => nav.push('company.config'), group: 'global' },
      { key: 'F1', label: 'Help', icon: 'help', onClick: () => shell.openShortcuts(), group: 'global' },
    ];
    return [...screen, ...globals.filter((g) => !taken.has(g.key))];
  }, [items, screenKey, lookup, date.openDialog, period.openDialog, shell, nav]);

  return <ActionRail items={all} registerHotkeys={false} aria-label="Actions" className="bx-shell__rail" />;
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
      <span className="bx-statusbar__item bx-statusbar__state" role="status" aria-live="polite">
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
      {state ? (
        <span className="bx-statusbar__item bx-statusbar__folder" title={`Data folder: ${state.dataDir}`}>
          <Icon name="folder" size="xs" /> <span className="bx-truncate">{state.dataDir}</span>
        </span>
      ) : null}
      {app.session && !app.session.implicit ? (
        <span className="bx-statusbar__item">
          <Icon name="user" size="xs" /> {app.session.username}
        </span>
      ) : null}
      {state ? <span className="bx-statusbar__item bx-statusbar__version">v{state.appVersion}</span> : null}
    </footer>
  );
}
