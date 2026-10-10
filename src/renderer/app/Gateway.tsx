/**
 * Gateway (home screen 'app.gateway'): every module's menu in sections on the left — arrow keys,
 * Enter, or the highlighted letter opens an item (keyboard-first) — and the dashboard (with its
 * "Get started" card) on the right; users who may not open the dashboard get a welcome panel with
 * quick actions instead.
 */
import { useMemo, useRef } from 'react';
import { Icon, Kbd, Tooltip, toAriaKeyShortcut, useHotkeys, useRovingFocus } from '../ui/index.ts';
import type { IconName } from '../ui/index.ts';
import { buildGateway, splitAccelerator } from './lib/menu.ts';
import type { BuiltMenuItem } from './lib/menu.ts';
import { ScreenErrorBoundary, useModules, useNav, useScreenTitle, useStatusHint } from './nav.tsx';
import { useShell } from './shell.tsx';
import { useInactiveBaseTypes } from './hooks/useVoucherChoices.ts';
import { useAppState } from './state.tsx';
import { formatDate } from '../../shared/dates.ts';
import { useWorkingDate } from './working.tsx';
import { WELL_KNOWN_SCREENS } from './wellKnown.ts';

export { WELL_KNOWN_SCREENS };


export function GatewayScreen() {
  const nav = useNav();
  const app = useAppState();
  const modules = useModules();
  useScreenTitle('Gateway');
  useStatusHint('↑↓ Move · Enter Open · Highlighted letter opens · Ctrl+G Go To');

  const inactiveBaseTypes = useInactiveBaseTypes();
  const sections = useMemo(
    () => buildGateway(modules, { can: app.can, gstEnabled: app.company?.gstEnabled ?? false, features: app.company?.features ?? null, gstRegistration: app.company?.gstRegistration ?? null, inactiveBaseTypes }),
    [modules, app.can, app.company, inactiveBaseTypes],
  );
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const open = (item: BuiltMenuItem) => nav.push(item.screen, item.params ?? {});

  const map: Record<string, () => void> = {};
  for (const it of items) if (it.accelerator) map[it.accelerator] = () => open(it);
  useHotkeys(map, [items]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: true });

  const dashboard = nav.isRegistered(WELL_KNOWN_SCREENS.dashboard) && nav.canOpen(WELL_KNOWN_SCREENS.dashboard) ? nav.screenDef(WELL_KNOWN_SCREENS.dashboard) : undefined;
  const Dashboard = dashboard?.component;
  // Modules' notices for the open company (ModuleDef.gatewayNotices), e.g. recurring vouchers due.
  const notices = useMemo(() => modules.flatMap((m) => (m.gatewayNotices ?? []).map((C, i) => ({ key: `${m.id}:${i}`, C }))), [modules]);

  return (
    <div className="bx-gateway">
      <nav className="bx-gateway__menu" aria-label="Gateway menu">
        <h1 className="bx-gateway__title">Gateway</h1>
        {sections.length === 0 ? (
          <p className="bx-gateway__empty">No menus are available for your user. Ask the company owner for access.</p>
        ) : (
          <div ref={listRef} className="bx-gateway__list" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
            {sections.map((section) => (
              <section key={section.id} className="bx-gateway__section" aria-labelledby={`gw-${section.id}`}>
                <h2 id={`gw-${section.id}`} className="bx-gateway__section-title">
                  {section.label}
                </h2>
                <ul className="bx-gateway__items">
                  {section.items.map((item) => (
                    <li key={item.id}>
                      <GatewayItem item={item} first={item.id === items[0]?.id} onOpen={() => open(item)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </nav>
      <div className="bx-gateway__panel">
        {notices.map(({ key, C }) => (
          <ScreenErrorBoundary key={key} title="Notice">
            <C />
          </ScreenErrorBoundary>
        ))}
        {Dashboard ? (
          <ScreenErrorBoundary title="Dashboard">
            <Dashboard params={{ embedded: true }} />
          </ScreenErrorBoundary>
        ) : (
          <WelcomePanel />
        )}
      </div>
    </div>
  );
}

function ariaKeys(hotkey: string | undefined): string | undefined {
  if (!hotkey) return undefined;
  try {
    return toAriaKeyShortcut(hotkey);
  } catch {
    return undefined;
  }
}

function GatewayItem({ item, first, onOpen }: { item: BuiltMenuItem; first: boolean; onOpen: () => void }) {
  const [before, key, after] = splitAccelerator(item.label, item.accelIndex);
  const button = (
    <button
      type="button"
      className="bx-gateway__item"
      data-roving-item=""
      data-autofocus={first ? '' : undefined}
      data-text-value={item.label}
      onClick={onOpen}
      aria-keyshortcuts={[item.accelerator?.toUpperCase(), ariaKeys(item.hotkey)].filter(Boolean).join(' ') || undefined}
    >
      <span className="bx-gateway__label">
        {before}
        {key ? <span className="bx-gateway__accel">{key}</span> : null}
        {after}
      </span>
      {item.hotkey ? <Kbd keys={item.hotkey} size="sm" tone="subtle" className="bx-gateway__hotkey" /> : null}
    </button>
  );
  return item.description ? (
    <Tooltip content={item.description} placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

// ───────────────────────────── Welcome panel ─────────────────────────────
//
// Shown instead of the dashboard only to users who may not open it (no Reports › View). It has quick
// actions only: the getting-started steps live in ONE place, the dashboard's "Get started" card
// (modules/dashboard/lib/model.ts startSteps — company details, features, invoice printing, ledgers,
// items, first sale, backups; done from the books, not from clicks). Setting up the company is the
// owner's job, and the owner always sees the dashboard.

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function WelcomePanel() {
  const nav = useNav();
  const shell = useShell();
  const app = useAppState();
  const workingDate = useWorkingDate();
  const company = app.company;

  const quick: Array<{ id: string; label: string; icon: IconName; hotkey?: string; run: () => void; hidden?: boolean }> = [
    { id: 'ledger', label: 'Create Ledger', icon: 'ledger', run: () => nav.push(WELL_KNOWN_SCREENS.ledgerForm), hidden: !app.can('masters.create') },
    { id: 'item', label: 'Create Stock Item', icon: 'box', run: () => nav.push(WELL_KNOWN_SCREENS.itemForm), hidden: !app.can('masters.create') || !company?.features.inventory },
    { id: 'sales', label: 'Sales Invoice', icon: 'invoice', hotkey: 'F8', run: () => shell.openVoucher('sales'), hidden: !app.can('vouchers.create') },
    { id: 'daybook', label: 'Day Book', icon: 'book', run: () => nav.push(WELL_KNOWN_SCREENS.dayBook), hidden: !app.can('vouchers.view') },
    { id: 'bs', label: 'Balance Sheet', icon: 'scale', run: () => nav.push(WELL_KNOWN_SCREENS.balanceSheet), hidden: !app.can('reports.financial') },
  ];
  const visibleQuick = quick.filter((q) => !q.hidden);
  const name = app.session && !app.session.implicit ? app.session.displayName || app.session.username : '';

  return (
    <div className="bx-welcome">
      <header className="bx-welcome__header">
        <p className="bx-welcome__eyebrow">{formatDate(workingDate.date)}</p>
        <h2 className="bx-welcome__title">
          {greeting(new Date())}
          {name ? `, ${name}` : ''}
        </h2>
        <p className="bx-welcome__subtitle">
          You are working in <strong>{company?.name}</strong>. Press <Kbd keys="Ctrl+G" size="sm" /> to find anything.
        </p>
      </header>

      {visibleQuick.length > 0 ? (
        <section aria-labelledby="welcome-quick" className="bx-welcome__quick">
          <h3 id="welcome-quick" className="bx-welcome__section-title">
            Quick actions
          </h3>
          <div className="bx-welcome__quick-grid">
            {visibleQuick.map((q) => (
              <button key={q.id} type="button" className="bx-quick" onClick={q.run}>
                <Icon name={q.icon} size="lg" className="bx-quick__icon" />
                <span className="bx-quick__label">{q.label}</span>
                {q.hotkey ? <Kbd keys={q.hotkey} size="sm" tone="subtle" /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
