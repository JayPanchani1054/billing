/**
 * Home (screen 'app.gateway'). The left column lists what the user may open, in one of two views:
 *
 *   - Essentials (Ctrl+1) — about 23 everyday tasks in five groups, each with its one-line description
 *     (lib/essentials.ts);
 *   - All menus (Ctrl+2) — every module's menu in sections, exactly the 1.0 Gateway (lib/menu.ts).
 *
 * Arrow keys, Enter or the highlighted letter open an item (keyboard-first). The choice is remembered
 * per user (lib/uiPrefs.ts). The right panel shows the modules' notices, a one-time "Try the simpler
 * Home" card for profiles upgraded from 1.0, and the dashboard — or, for users who may not open the
 * dashboard, a one-line greeting. The nav landmark keeps its name "Gateway menu".
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Banner, Button, Kbd, SegmentedControl, Tooltip, toAriaKeyShortcut, useHotkeys, useRovingFocus } from '../ui/index.ts';
import { buildEssentials } from './lib/essentials.ts';
import { buildGateway, splitAccelerator } from './lib/menu.ts';
import type { BuiltMenuItem } from './lib/menu.ts';
import { showTryHome } from './lib/uiPrefs.ts';
import type { HomeView } from './lib/uiPrefs.ts';
import { ScreenErrorBoundary, useModules, useNav, useScreenTitle, useStatusHint } from './nav.tsx';
import { setUiPrefs, useUiPrefs } from './preferences.ts';
import { useInactiveBaseTypes } from './hooks/useVoucherChoices.ts';
import { useAppState } from './state.tsx';
import { WELL_KNOWN_SCREENS } from './wellKnown.ts';

export { WELL_KNOWN_SCREENS };

/** The view switch; each segment shows its key (the chip is hidden from the radio's name). */
const VIEWS: ReadonlyArray<{ value: HomeView; label: ReactNode }> = [
  {
    value: 'essentials',
    label: (
      <>
        Essentials <Kbd keys="Ctrl+1" size="sm" tone="subtle" aria-hidden="true" />
      </>
    ),
  },
  {
    value: 'all',
    label: (
      <>
        All menus <Kbd keys="Ctrl+2" size="sm" tone="subtle" aria-hidden="true" />
      </>
    ),
  },
];

interface ListSection {
  id: string;
  label: string;
  items: BuiltMenuItem[];
}

export function GatewayScreen() {
  const nav = useNav();
  const app = useAppState();
  const modules = useModules();
  const ui = useUiPrefs();
  const view = ui.homeView;
  useScreenTitle('Home');
  useStatusHint('↑↓ Move · Enter Open · Highlighted letter opens · Ctrl+1 Essentials · Ctrl+2 All menus · Ctrl+G Go To');

  const inactiveBaseTypes = useInactiveBaseTypes();
  const sections = useMemo(
    () => buildGateway(modules, { can: app.can, gstEnabled: app.company?.gstEnabled ?? false, features: app.company?.features ?? null, gstRegistration: app.company?.gstRegistration ?? null, inactiveBaseTypes }),
    [modules, app.can, app.company, inactiveBaseTypes],
  );
  const essentials = useMemo(() => buildEssentials(sections), [sections]);
  const shown: readonly ListSection[] = view === 'essentials' ? essentials : sections;
  const items = useMemo(() => shown.flatMap((s) => s.items), [shown]);

  const open = (item: BuiltMenuItem) => nav.push(item.screen, item.params ?? {});
  const setView = (v: HomeView) => setUiPrefs({ homeView: v });

  const map: Record<string, () => void> = {
    'Ctrl+1': () => setView('essentials'),
    'Ctrl+2': () => setView('all'),
  };
  for (const it of items) if (it.accelerator) map[it.accelerator] = () => open(it);
  useHotkeys(map, [items]);

  const navRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: true });

  // After a view switch the focused item may be gone: focus the first item of the new list, unless the
  // user is somewhere else (the panel, a dialog).
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const active = document.activeElement;
    const inMenu = !active || active === document.body || (navRef.current?.contains(active) ?? false);
    if (!inMenu) return;
    if (active && navRef.current?.contains(active) && active.closest('[role="radiogroup"]')) return; // switching with ←/→ on the control
    listRef.current?.querySelector<HTMLElement>('[data-roving-item]')?.focus();
  }, [view]);

  const dashboard = nav.isRegistered(WELL_KNOWN_SCREENS.dashboard) && nav.canOpen(WELL_KNOWN_SCREENS.dashboard) ? nav.screenDef(WELL_KNOWN_SCREENS.dashboard) : undefined;
  const Dashboard = dashboard?.component;
  // Modules' notices for the open company (ModuleDef.gatewayNotices), e.g. recurring vouchers due.
  const notices = useMemo(() => modules.flatMap((m) => (m.gatewayNotices ?? []).map((C, i) => ({ key: `${m.id}:${i}`, C }))), [modules]);

  return (
    <div className="bx-gateway">
      <nav ref={navRef} className="bx-gateway__menu" aria-label="Gateway menu">
        <h1 className="bx-gateway__title">Home</h1>
        <SegmentedControl aria-label="Home view" options={VIEWS} value={view} onChange={setView} size="sm" fullWidth className="bx-gateway__views" />
        {sections.length === 0 ? (
          <p className="bx-gateway__empty">No menus are available for your user. Ask the company owner for access.</p>
        ) : shown.length === 0 ? (
          <p className="bx-gateway__empty">None of the everyday entries is open to your user. All menus (Ctrl+2) lists what you can use.</p>
        ) : (
          <div ref={listRef} className={view === 'essentials' ? 'bx-gateway__list bx-gateway__list--essentials' : 'bx-gateway__list'} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
            {shown.map((section) => (
              <section key={section.id} className="bx-gateway__section" aria-labelledby={`gw-${view}-${section.id}`}>
                <h2 id={`gw-${view}-${section.id}`} className="bx-gateway__section-title">
                  {section.label}
                </h2>
                <ul className="bx-gateway__items">
                  {section.items.map((item) => (
                    <li key={item.id}>
                      <GatewayItem item={item} first={item.id === items[0]?.id} detailed={view === 'essentials'} onOpen={() => open(item)} />
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
        {showTryHome(ui) ? <TryHomeCard /> : null}
        {Dashboard ? (
          <ScreenErrorBoundary title="Dashboard">
            <Dashboard params={{ embedded: true }} />
          </ScreenErrorBoundary>
        ) : (
          <Greeting />
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

function GatewayItem({ item, first, detailed, onOpen }: { item: BuiltMenuItem; first: boolean; detailed: boolean; onOpen: () => void }) {
  const [before, key, after] = splitAccelerator(item.label, item.accelIndex);
  const descId = `gw-desc-${item.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const showDescription = detailed && !!item.description;
  const button = (
    <button
      type="button"
      className={showDescription ? 'bx-gateway__item bx-gateway__item--detailed' : 'bx-gateway__item'}
      data-roving-item=""
      data-autofocus={first ? '' : undefined}
      data-text-value={item.label}
      onClick={onOpen}
      aria-label={showDescription ? item.label : undefined}
      aria-describedby={showDescription ? descId : undefined}
      aria-keyshortcuts={[item.accelerator?.toUpperCase(), ariaKeys(item.hotkey)].filter(Boolean).join(' ') || undefined}
    >
      <span className="bx-gateway__text">
        <span className="bx-gateway__label">
          {before}
          {key ? <span className="bx-gateway__accel">{key}</span> : null}
          {after}
        </span>
        {showDescription ? (
          <span id={descId} className="bx-gateway__desc">
            {item.description}
          </span>
        ) : null}
      </span>
      {item.hotkey ? <Kbd keys={item.hotkey} size="sm" tone="subtle" className="bx-gateway__hotkey" /> : null}
    </button>
  );
  // All menus keeps the 1.0 tooltip; Essentials shows the description under the label instead.
  return item.description && !showDescription ? (
    <Tooltip content={item.description} placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/** Once, for profiles upgraded from 1.0 that still show All menus (dismissal remembered). */
function TryHomeCard() {
  return (
    <Banner
      tone="info"
      icon="home"
      className="bx-gateway__try"
      title="Try the simpler Home"
      onDismiss={() => setUiPrefs({ tryHomeDismissed: true })}
      action={
        <>
          <Button size="sm" variant="primary" onClick={() => setUiPrefs({ homeView: 'essentials', tryHomeDismissed: true })}>
            Show Essentials
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setUiPrefs({ tryHomeDismissed: true })}>
            Not now
          </Button>
        </>
      }
    >
      Fewer menus, everything still one key away. Switch any time with Ctrl+1 / Ctrl+2.
    </Banner>
  );
}

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * Users who may not open the dashboard (no Reports › View) see a greeting instead. The getting-started
 * steps live in ONE place, the dashboard's "Get started" card: setting up the company is the owner's
 * job, and the owner always sees the dashboard.
 */
function Greeting() {
  const app = useAppState();
  const name = app.session && !app.session.implicit ? app.session.displayName || app.session.username : '';
  return (
    <div className="bx-gateway__greeting">
      <h2 className="bx-gateway__greeting-title">
        {greeting(new Date())}
        {name ? `, ${name}` : ''}. You are working in {app.company?.name}.
      </h2>
      <p className="bx-gateway__greeting-text">
        Press <Kbd keys="Ctrl+G" size="sm" /> to find anything.
      </p>
    </div>
  );
}
