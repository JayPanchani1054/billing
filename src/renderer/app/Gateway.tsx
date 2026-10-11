/**
 * Home (screen 'app.gateway'). The left column lists what the user may open, in one of two views:
 *
 *   - Essentials (Ctrl+1) — at most 20 everyday tasks in five groups (lib/essentials.ts);
 *   - All menus (Ctrl+2) — every module's menu in sections, exactly the 1.0 Gateway (lib/menu.ts).
 *
 * 2.1 ("calm", SPEC-21 §1.3): one plain line per item — the label with its highlighted letter and, for
 * voucher items, the function key as plain text. What an item is for is not printed under it: it shows
 * in ONE tooltip to the right of the column while the item is hovered or reached with the keyboard, and
 * it is the item's accessible description (aria-describedby) all the time. The view switch is two text
 * radios "Essentials · All". Home has no title row and no command bar; its keys stay registered.
 *
 * Arrow keys, Enter or the highlighted letter open an item (keyboard-first). The choice of view is
 * remembered per user (lib/uiPrefs.ts). The right panel shows the modules' notices, a one-line "Try the
 * simpler Home" offer for profiles upgraded from 1.0, and the dashboard — or, for users who may not open
 * the dashboard, a one-line greeting. The nav landmark keeps its name "Gateway menu".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Banner, Button, Tooltip, toAriaKeyShortcut, useHotkeys, useRovingFocus } from '../ui/index.ts';
import { buildEssentials } from './lib/essentials.ts';
import { tipOnFocus, tipTop } from './lib/homeTip.ts';
import type { LastInput } from './lib/homeTip.ts';
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

/**
 * The view switch: two text radios. The second reads "All" on screen; its accessible name stays
 * "All menus" (e2e and the Appearance panel use that name). Keys live in the tooltip, not on screen.
 */
const VIEWS: ReadonlyArray<{ value: HomeView; text: string; name: string; key: string }> = [
  { value: 'essentials', text: 'Essentials', name: 'Essentials', key: 'Ctrl+1' },
  { value: 'all', text: 'All', name: 'All menus', key: 'Ctrl+2' },
];

interface ListSection {
  id: string;
  label: string;
  items: BuiltMenuItem[];
}

/** The one description tooltip of the menu: the item's text, its vertical centre inside `.bx-gateway`, shown. */
interface Tip {
  text: string;
  top: number;
  open: boolean;
}

/** id of the hidden element holding an item's description (aria-describedby). */
function descIdOf(item: BuiltMenuItem): string {
  return `gw-desc-${item.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
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

  const rootRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const viewsRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: true });
  const viewsRoving = useRovingFocus(viewsRef, {
    orientation: 'horizontal',
    loop: true,
    manageTabIndex: false,
    onNavigate: (el) => {
      const v = VIEWS.find((x) => x.value === el.getAttribute('data-value'));
      if (v) setView(v.value);
    },
  });

  // The description tooltip: shown while an item is hovered, or reached with the keyboard from another
  // element (lib/homeTip.ts) — not when Home focuses its first item by itself, nor after a click. It
  // keeps its last text while it fades out, follows its item when the column scrolls (↑/↓ through All
  // menus) and hides when the item scrolls out of sight.
  const [tip, setTip] = useState<Tip>({ text: '', top: 0, open: false });
  const tipEl = useRef<HTMLElement | null>(null);
  const lastInput = useRef<LastInput>(null);
  useEffect(() => {
    const onKey = () => {
      lastInput.current = 'key';
    };
    const onPointer = () => {
      lastInput.current = 'pointer';
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);
  // Leaving one item for the next (mouse, Tab) hides on the next tick unless the next item shows it, so
  // the tip moves without fading out and back in.
  const hideTimer = useRef<number | undefined>(undefined);
  const cancelHide = () => {
    if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  };
  useEffect(() => cancelHide, []);
  const hideTip = () => {
    cancelHide();
    tipEl.current = null;
    setTip((t) => (t.open ? { ...t, open: false } : t));
  };
  const hideTipSoon = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(hideTip, 0);
  };
  const placeTip = (el: HTMLElement, text: string) => {
    cancelHide();
    const root = rootRef.current;
    const menu = navRef.current;
    const top = root && menu ? tipTop(el.getBoundingClientRect(), root.getBoundingClientRect(), menu.getBoundingClientRect()) : null;
    if (top === null) {
      hideTip();
      return;
    }
    tipEl.current = el;
    setTip({ text, top, open: true });
  };
  const showTip = (el: HTMLElement, text: string | undefined) => {
    if (text) placeTip(el, text);
    else hideTip();
  };
  const onMenuScroll = () => {
    const el = tipEl.current;
    if (el && el.isConnected) placeTip(el, tip.text);
    else hideTip();
  };
  const tipHandlers = (item: BuiltMenuItem) => ({
    onMouseEnter: (e: { currentTarget: HTMLElement }) => showTip(e.currentTarget, item.description),
    onMouseLeave: hideTipSoon,
    onFocus: (e: ReactFocusEvent<HTMLElement>) => {
      const from = e.relatedTarget;
      if (tipOnFocus(lastInput.current, from instanceof Element && from !== document.body)) showTip(e.currentTarget, item.description);
    },
    onBlur: hideTipSoon,
  });

  // After a view switch the focused item may be gone: focus the first item of the new list, unless the
  // user is somewhere else (the panel, a dialog).
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    hideTip();
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

  // Esc hides the tooltip (WCAG 1.4.13) and goes on to whatever else Esc does.
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') hideTip();
  };

  return (
    <div ref={rootRef} className="bx-gateway">
      <nav ref={navRef} className="bx-gateway__menu" aria-label="Gateway menu" onKeyDown={onMenuKeyDown} onScroll={onMenuScroll}>
        <div className="bx-gateway__head">
          <h1 className="bx-gateway__title">Home</h1>
          <div ref={viewsRef} role="radiogroup" aria-label="Home view" className="bx-gateway__views" onKeyDown={viewsRoving.onKeyDown}>
            {VIEWS.map((v) => {
              const selected = v.value === view;
              return (
                <Tooltip key={v.value} content={`${v.name} · ${v.key}`} placement="bottom" describeChild={false}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={v.text === v.name ? undefined : v.name}
                    aria-keyshortcuts={toAriaKeyShortcut(v.key)}
                    data-value={v.value}
                    data-roving-item=""
                    tabIndex={selected ? 0 : -1}
                    className="bx-gateway__view"
                    onClick={() => setView(v.value)}
                  >
                    {v.text}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>
        {sections.length === 0 ? (
          <p className="bx-gateway__empty">No menus are available for your user. Ask the company owner for access.</p>
        ) : shown.length === 0 ? (
          <p className="bx-gateway__empty">None of the everyday entries is open to your user. All menus (Ctrl+2) lists what you can use.</p>
        ) : (
          <div ref={listRef} className="bx-gateway__list" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
            {shown.map((section) => (
              <section key={section.id} className="bx-gateway__section" aria-labelledby={`gw-${view}-${section.id}`}>
                <h2 id={`gw-${view}-${section.id}`} className="bx-gateway__section-title">
                  {section.label}
                </h2>
                <ul className="bx-gateway__items">
                  {section.items.map((item) => (
                    <li key={item.id}>
                      <GatewayItem item={item} first={item.id === items[0]?.id} onOpen={() => open(item)} {...tipHandlers(item)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </nav>
      {/* One tooltip for the whole menu, outside the scrolling column so it is never clipped. */}
      <div className="bx-tooltip bx-gateway__tip" data-open={tip.open ? '' : undefined} style={{ top: `${tip.top}px` }} aria-hidden="true">
        {tip.text}
      </div>
      <div className="bx-gateway__panel">
        {notices.map(({ key, C }) => (
          <ScreenErrorBoundary key={key} title="Notice">
            <C />
          </ScreenErrorBoundary>
        ))}
        {showTryHome(ui) ? <TryHomeLine /> : null}
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

interface GatewayItemProps {
  item: BuiltMenuItem;
  first: boolean;
  onOpen: () => void;
  onMouseEnter: (e: { currentTarget: HTMLElement }) => void;
  onMouseLeave: () => void;
  onFocus: (e: ReactFocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

/** One line: the label (accelerator letter highlighted) and, for voucher items, the function key as text. */
function GatewayItem({ item, first, onOpen, ...tipEvents }: GatewayItemProps) {
  const [before, key, after] = splitAccelerator(item.label, item.accelIndex);
  const descId = descIdOf(item);
  return (
    <>
      <button
        type="button"
        className="bx-gateway__item"
        data-roving-item=""
        data-autofocus={first ? '' : undefined}
        data-text-value={item.label}
        onClick={onOpen}
        aria-describedby={item.description ? descId : undefined}
        aria-keyshortcuts={[item.accelerator?.toUpperCase(), ariaKeys(item.hotkey)].filter(Boolean).join(' ') || undefined}
        {...tipEvents}
      >
        <span className="bx-gateway__label">
          {before}
          {key ? <span className="bx-gateway__accel">{key}</span> : null}
          {after}
        </span>
        {item.hotkey ? <span className="bx-gateway__hotkey">{item.hotkey}</span> : null}
      </button>
      {item.description ? (
        <span id={descId} hidden>
          {item.description}
        </span>
      ) : null}
    </>
  );
}

/** Once, for profiles upgraded from 1.0 that still show All menus (dismissal remembered). One line. */
function TryHomeLine() {
  return (
    <Banner
      tone="info"
      icon={false}
      className="bx-gateway__try"
      title="Try the simpler Home"
      onDismiss={() => setUiPrefs({ tryHomeDismissed: true })}
      action={
        <Button size="sm" variant="link" onClick={() => setUiPrefs({ homeView: 'essentials', tryHomeDismissed: true })}>
          Show Essentials
        </Button>
      }
    >
      Fewer menus, every key the same.
    </Banner>
  );
}

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * Users who may not open the dashboard (no Reports › View) see a greeting instead. The getting-started
 * steps live in ONE place, the dashboard: setting up the company is the owner's job, and the owner
 * always sees the dashboard.
 */
function Greeting() {
  const app = useAppState();
  const name = app.session && !app.session.implicit ? app.session.displayName || app.session.username : '';
  return (
    <p className="bx-gateway__greeting">
      {greeting(new Date())}
      {name ? `, ${name}` : ''}. You are working in {app.company?.name}. Go To (Ctrl+G) finds anything.
    </p>
  );
}
