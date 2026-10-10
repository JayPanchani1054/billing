/**
 * Screen navigation (Tally-style stack) for the open company.
 *
 *   const nav = useNav();
 *   nav.push('accounts.ledger.form', { id });                 // open a screen
 *   const ledger = await nav.pushForResult<{ id: number; name: string }>('accounts.ledger.form', { initialName: 'HDFC' });
 *   nav.pop(result);                                           // close the top screen (programmatic, no prompt)
 *   await nav.back();                                          // what Esc does (asks when the form is dirty)
 *
 * Inside a screen:
 *   useScreenTitle('Ledger Alteration'); useDirty(isDirty); useScreenActions([...]);
 *   const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
 */
import { Component, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { CompanyFeatures } from '../../shared/settings.ts';
import { Breadcrumbs, Button, HotkeyScope, Icon, Modal, useHotkeys, useToast } from '../ui/index.ts';
import type { ActionRailItem, ModalSize } from '../ui/index.ts';
import { getTabbables } from '../ui/lib/dom.ts';
import { setNativeDirty } from './bridge.ts';
import { confirmDialog } from './confirm.tsx';
import { errorDetailsText, userMessage } from './lib/apiErrors.ts';
import { featureLabel } from './lib/featureCatalog.ts';
import { KeyedStore } from './lib/keyedStore.ts';
import { FOCUS_RANK, INITIAL_FOCUS_WATCH_MS, markShellFocus, needsFocusWatch, shouldUpgradeFocus } from './lib/initialFocus.ts';
import { isAllowed, screenIndex } from './lib/menu.ts';
import { createRootStack, makeEntry, mountedKeys, MAX_MOUNTED, ResultBroker, ROOT_SCREEN, topFullIndex, transition } from './lib/navStack.ts';
import type { NavAction, NavEntry, NavParams } from './lib/navStack.ts';
import type { ModuleDef, ScreenDef } from './registry.ts';
import { ScreenVisibilityContext } from './screenVisibility.ts';
import { useAppState } from './state.tsx';

export type { NavEntry, NavParams };

export interface NavApi {
  /** Open a screen on top of the stack. Returns false (and explains in a toast) when refused. */
  push: (screenId: string, params?: NavParams) => boolean;
  /**
   * Open a screen and wait for it to close. Resolves with the value the screen passes to
   * `pop(result)` / `returnResult(result)`, or undefined when it was closed any other way.
   * The screen receives `params.forResult === true`.
   */
  pushForResult: <R = unknown>(screenId: string, params?: NavParams) => Promise<R | undefined>;
  /** Replace the top screen (e.g. after saving a voucher, open a fresh one). No prompt. */
  replace: (screenId: string, params?: NavParams) => boolean;
  /** Close the top screen, delivering `result` to its pushForResult caller. No dirty prompt. */
  pop: (result?: unknown) => void;
  /** User intent "go back" (Esc): asks before discarding unsaved changes. Resolves true when popped. */
  back: () => Promise<boolean>;
  /** Go back to a stack index (breadcrumbs). Asks if any screen being closed is dirty. */
  popTo: (index: number) => Promise<boolean>;
  /** Back to the Gateway. Asks if any open screen is dirty. */
  reset: () => Promise<boolean>;
  /** Ask once if anything in the stack is unsaved (before closing the company, logging out, quitting). */
  confirmDiscardAll: () => Promise<boolean>;
  /** Any open screen marked dirty (useDirty). */
  hasUnsavedChanges: () => boolean;
  /** Registered and allowed for this user/company. */
  canOpen: (screenId: string) => boolean;
  isRegistered: (screenId: string) => boolean;
  screenDef: (screenId: string) => ScreenDef | undefined;
  getStack: () => readonly NavEntry[];
}

interface NavInternal {
  api: NavApi;
  modules: readonly ModuleDef[];
  registry: ReadonlyMap<string, ScreenDef & { moduleId: string }>;
  titles: KeyedStore<string>;
  dirty: KeyedStore<boolean>;
  actions: KeyedStore<readonly ScreenActionItem[]>;
  hints: KeyedStore<string>;
  takeFocusRestore: () => HTMLElement | null;
  popEntry: (key: string, result?: { value: unknown }) => void;
}

/** A rail action contributed by a screen (ActionRailItem; `key` is the hotkey). */
export type ScreenActionItem = ActionRailItem;

/** Separates a screen's entry key from a contributing hook's slot id in the per-screen stores. */
const SLOT_SEP = '\u0000';

const NavApiContext = createContext<NavApi | null>(null);
const NavInternalContext = createContext<NavInternal | null>(null);
const NavStackContext = createContext<readonly NavEntry[]>([]);

export interface ScreenContextValue {
  entry: NavEntry;
  index: number;
  /** Receives keyboard input (top of the stack). */
  isTop: boolean;
  /** Drawn (the top full screen and dialogs above it). */
  visible: boolean;
  def: ScreenDef;
}

const ScreenContext = createContext<ScreenContextValue | null>(null);

function screenLabel(def: ScreenDef | undefined, screenId: string): string {
  return def?.title ?? screenId;
}

export function NavProvider({ modules, children }: { modules: readonly ModuleDef[]; children?: ReactNode }) {
  const toast = useToast();
  const app = useAppState();
  const registry = useMemo(() => screenIndex(modules), [modules]);
  const [stack, setStack] = useState<readonly NavEntry[]>(() => createRootStack());
  const stackRef = useRef(stack);
  const broker = useMemo(() => new ResultBroker(), []);
  const stores = useMemo(
    () => ({
      titles: new KeyedStore<string>(),
      dirty: new KeyedStore<boolean>(),
      actions: new KeyedStore<readonly ScreenActionItem[]>(),
      hints: new KeyedStore<string>(),
    }),
    [],
  );
  const openers = useRef(new Map<string, HTMLElement | null>());
  const focusRestore = useRef<HTMLElement | null>(null);

  // Latest permission/feature context for guards (read at call time).
  const guardCtx = useRef({ can: app.can, company: app.company });
  guardCtx.current = { can: app.can, company: app.company };

  const apply = useCallback(
    (action: NavAction, result?: { value: unknown }): readonly NavEntry[] => {
      const prev = stackRef.current;
      const { next, removed } = transition(prev, action, broker, result);
      if (next === prev) return prev;
      if (removed.length > 0) {
        // Restore focus to whatever opened the top-most removed screen.
        const opener = openers.current.get(removed[removed.length - 1].key) ?? null;
        focusRestore.current = opener;
        for (const e of removed) openers.current.delete(e.key);
      }
      stackRef.current = next;
      setStack(next);
      return next;
    },
    [broker],
  );

  const refuse = useCallback(
    (screenId: string): boolean => {
      const def = registry.get(screenId);
      if (!def) {
        toast.info("This screen isn't available yet", { message: 'It is still being built. Try again after the next update.', id: 'nav-unavailable' });
        return true;
      }
      const { can, company } = guardCtx.current;
      const features: Partial<CompanyFeatures> | null = company?.features ?? null;
      if (def.access && !can(def.access)) {
        toast.warning(`You don't have permission to open ${def.title}`, { message: 'Ask the company owner or an administrator for access.', id: 'nav-denied' });
        return true;
      }
      if (!isAllowed({ gstOnly: def.gstOnly, feature: def.feature, anyFeature: def.anyFeature }, { can, gstEnabled: company?.gstEnabled ?? false, features })) {
        const why = def.gstOnly && !company?.gstEnabled
          ? 'Turn on GST in Features (F11) to use it.'
          : def.feature
            ? `Turn on ${featureLabel(def.feature)} in Features (F11) to use it.`
            : def.anyFeature
              ? `Turn on ${def.anyFeature.map((f) => featureLabel(f)).join(' or ')} in Features (F11) to use it.`
              : '';
        toast.info(`${def.title} is turned off for this company`, { message: why, id: 'nav-feature' });
        return true;
      }
      return false;
    },
    [registry, toast],
  );

  const recordOpener = (key: string) => {
    const el = document.activeElement;
    openers.current.set(key, el instanceof HTMLElement && el !== document.body ? el : null);
  };

  const dirtyAmong = useCallback(
    (entries: readonly NavEntry[]): NavEntry[] => {
      const dirtyScreens = new Set(
        stores.dirty
          .entries()
          .filter(([, v]) => v)
          .map(([k]) => k.split(SLOT_SEP)[0]),
      );
      return entries.filter((e) => dirtyScreens.has(e.key));
    },
    [stores],
  );

  const confirmDiscard = useCallback(
    async (entries: readonly NavEntry[]): Promise<boolean> => {
      const dirty = dirtyAmong(entries);
      if (dirty.length === 0) return true;
      const names = dirty.map((e) => stores.titles.get(e.key) ?? screenLabel(registry.get(e.screenId), e.screenId));
      return confirmDialog({
        title: 'Discard unsaved changes?',
        message:
          names.length === 1
            ? `“${names[0]}” has changes that are not saved. If you leave now, they will be lost.`
            : `These screens have changes that are not saved: ${names.join(', ')}. If you leave now, they will be lost.`,
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
    },
    [dirtyAmong, registry, stores],
  );

  const api = useMemo<NavApi>(() => {
    const push = (screenId: string, params: NavParams = {}): boolean => {
      if (refuse(screenId)) return false;
      const entry = makeEntry(screenId, params);
      recordOpener(entry.key);
      apply({ type: 'push', entry });
      return true;
    };
    return {
      push,
      pushForResult: <R,>(screenId: string, params: NavParams = {}): Promise<R | undefined> => {
        if (refuse(screenId)) return Promise.resolve(undefined);
        const entry = makeEntry(screenId, { ...params, forResult: true }, true);
        const waiting = broker.wait<R>(entry.key);
        recordOpener(entry.key);
        apply({ type: 'push', entry });
        return waiting;
      },
      replace: (screenId, params = {}) => {
        if (refuse(screenId)) return false;
        const entry = makeEntry(screenId, params);
        const prevTop = stackRef.current[stackRef.current.length - 1];
        openers.current.set(entry.key, openers.current.get(prevTop.key) ?? null);
        apply({ type: 'replace', entry });
        return true;
      },
      pop: (result?: unknown) => {
        apply({ type: 'pop' }, result === undefined ? undefined : { value: result });
      },
      back: async () => {
        const s = stackRef.current;
        if (s.length <= 1) return false;
        const top = s[s.length - 1];
        if (!(await confirmDiscard([top]))) return false;
        // The stack may have changed while the dialog was open.
        if (stackRef.current[stackRef.current.length - 1]?.key !== top.key) return false;
        apply({ type: 'popEntry', key: top.key });
        return true;
      },
      popTo: async (index: number) => {
        const s = stackRef.current;
        if (index >= s.length - 1) return false;
        if (!(await confirmDiscard(s.slice(index + 1)))) return false;
        apply({ type: 'popTo', index });
        return true;
      },
      reset: async () => {
        const s = stackRef.current;
        if (s.length <= 1) return true;
        if (!(await confirmDiscard(s.slice(1)))) return false;
        apply({ type: 'reset' });
        return true;
      },
      confirmDiscardAll: () => confirmDiscard(stackRef.current),
      hasUnsavedChanges: () => dirtyAmong(stackRef.current).length > 0,
      canOpen: (screenId) => {
        const def = registry.get(screenId);
        if (!def) return false;
        const { can, company } = guardCtx.current;
        return isAllowed(def, { can, gstEnabled: company?.gstEnabled ?? false, features: company?.features ?? null });
      },
      isRegistered: (screenId) => registry.has(screenId),
      screenDef: (screenId) => registry.get(screenId),
      getStack: () => stackRef.current,
    };
  }, [apply, broker, confirmDiscard, dirtyAmong, refuse, registry]);

  // Unsaved work anywhere → main's close guard asks before closing the window.
  useEffect(() => {
    const sync = () => setNativeDirty(stores.dirty.values().some(Boolean));
    sync();
    return stores.dirty.subscribe(sync);
  }, [stores]);

  // Company closed / workspace unmounted: settle pending pushForResult waiters, clear the flag.
  useEffect(
    () => () => {
      broker.settleAll();
      setNativeDirty(false);
    },
    [broker],
  );

  const internal = useMemo<NavInternal>(
    () => ({
      api,
      modules,
      registry,
      ...stores,
      takeFocusRestore: () => {
        const el = focusRestore.current;
        focusRestore.current = null;
        return el;
      },
      popEntry: (key, result) => apply({ type: 'popEntry', key }, result),
    }),
    [api, modules, registry, stores, apply],
  );

  return (
    <NavApiContext.Provider value={api}>
      <NavInternalContext.Provider value={internal}>
        <NavStackContext.Provider value={stack}>{children}</NavStackContext.Provider>
      </NavInternalContext.Provider>
    </NavApiContext.Provider>
  );
}

function useNavInternal(): NavInternal {
  const ctx = useContext(NavInternalContext);
  if (!ctx) throw new Error('Navigation hooks must be used inside the workspace (<NavProvider>)');
  return ctx;
}

/** The stable navigation API (never changes identity — safe in deps). */
export function useNav(): NavApi {
  const ctx = useContext(NavApiContext);
  if (!ctx) throw new Error('useNav must be used inside the workspace (<NavProvider>)');
  return ctx;
}

/** All registered modules (shell + features) — for menus and Go To. */
export function useModules(): readonly ModuleDef[] {
  return useNavInternal().modules;
}

/** The current stack (re-renders on every push/pop — use sparingly). */
export function useNavStack(): readonly NavEntry[] {
  return useContext(NavStackContext);
}

/** The screen this component belongs to. */
export function useScreen(): ScreenContextValue {
  const ctx = useContext(ScreenContext);
  if (!ctx) throw new Error('useScreen must be used inside a screen');
  return ctx;
}

/** Like useScreen but null outside a screen (for components used in both places). */
export function useOptionalScreen(): ScreenContextValue | null {
  return useContext(ScreenContext);
}

/** Override the screen's title (breadcrumbs, window title). */
export function useScreenTitle(title: string | null | undefined): void {
  const { titles } = useNavInternal();
  const screen = useOptionalScreen();
  const key = screen?.entry.key;
  useLayoutEffect(() => {
    if (!key || !title) return undefined;
    titles.set(key, title);
    return () => titles.delete(key);
  }, [key, title, titles]);
}

/** One line of keyboard help in the status bar while this screen is on top. */
export function useStatusHint(hint: string | null | undefined): void {
  const { hints } = useNavInternal();
  const key = useOptionalScreen()?.entry.key;
  useEffect(() => {
    if (!key || !hint) return undefined;
    hints.set(key, hint);
    return () => hints.delete(key);
  }, [key, hint, hints]);
}

/**
 * Mark this screen as having unsaved work: Esc / breadcrumbs / switching company ask before
 * discarding it, and closing the window asks too (pevqori.setDirty).
 */
export function useDirty(isDirty: boolean): void {
  const { dirty } = useNavInternal();
  const screenKey = useOptionalScreen()?.entry.key;
  const slot = useId();
  const key = screenKey ? `${screenKey}${SLOT_SEP}${slot}` : undefined;
  useEffect(() => {
    if (!key) return undefined;
    dirty.set(key, isDirty);
    return undefined;
  }, [key, isDirty, dirty]);
  useEffect(() => {
    if (!key) return undefined;
    return () => dirty.delete(key);
  }, [key, dirty]);
}

function actionsSignature(items: readonly ScreenActionItem[]): string {
  return items.map((i) => [i.id ?? '', i.key, i.label, i.disabled ? 1 : 0, i.hidden ? 1 : 0, i.group ?? '', i.icon ?? '', i.hint ?? '', i.primary ? 1 : 0].join('\u0001')).join('\u0002');
}

/**
 * Contribute actions to the right-hand rail while this screen is on top, and register their keys
 * as screen hotkeys. Hidden/disabled items don't fire. Handlers always see the latest props.
 */
export function useScreenActions(items: readonly ScreenActionItem[]): void {
  const { actions } = useNavInternal();
  const screenKey = useOptionalScreen()?.entry.key;
  // Several components of one screen may contribute; each gets its own slot.
  const slot = useId();
  const key = screenKey ? `${screenKey}${SLOT_SEP}${slot}` : undefined;
  const sig = actionsSignature(items);
  useLayoutEffect(() => {
    if (!key) return;
    actions.set(key, items, (a, b) => actionsSignature(a) === actionsSignature(b));
  });
  useEffect(() => {
    if (!key) return undefined;
    return () => actions.delete(key);
  }, [key, actions]);
  const map: Record<string, (() => void) | undefined> = {};
  for (const it of items) if (!it.hidden && !it.disabled) map[it.key] = () => it.onClick();
  useHotkeys(map, [sig]);
}

/** For screens opened with pushForResult ("Save & return"). */
export function useScreenResult<R = unknown>(): { forResult: boolean; returnResult: (value: R) => void; cancel: () => void } {
  const screen = useScreen();
  const { popEntry } = useNavInternal();
  const key = screen.entry.key;
  const forResult = screen.entry.forResult;
  return useMemo(
    () => ({
      forResult,
      returnResult: (value: R) => popEntry(key, { value }),
      cancel: () => popEntry(key),
    }),
    [forResult, key, popEntry],
  );
}

/** Title of a nav entry (runtime override, else ScreenDef title). */
export function useEntryTitle(entry: NavEntry | undefined): string {
  const { titles, registry } = useNavInternal();
  const key = entry?.key ?? '';
  const override = useSyncExternalStore(titles.subscribe, () => titles.get(key));
  if (!entry) return '';
  return override ?? screenLabel(registry.get(entry.screenId), entry.screenId);
}

/** Rail items of the top screen. */
function actionsOf(store: KeyedStore<readonly ScreenActionItem[]>, screenKey: string): readonly ScreenActionItem[] {
  if (!screenKey) return EMPTY;
  const prefix = `${screenKey}${SLOT_SEP}`;
  const out: ScreenActionItem[] = [];
  for (const [k, items] of store.entries()) if (k.startsWith(prefix)) out.push(...items);
  return out.length ? out : EMPTY;
}

/** Rail items of the top screen (all contributors, in registration order). */
export function useTopScreenActions(): { key: string; items: readonly ScreenActionItem[] } {
  const { actions } = useNavInternal();
  const stack = useNavStack();
  const key = stack[stack.length - 1]?.key ?? '';
  const version = useSyncExternalStore(actions.subscribe, actions.getVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => actionsOf(actions, key), [actions, key, version]);
  return { key, items };
}

/** Latest action items of a screen (call-time lookup for rail clicks: always the newest handlers). */
export function useActionLookup(): (screenKey: string) => readonly ScreenActionItem[] {
  const { actions } = useNavInternal();
  return useCallback((k: string) => actionsOf(actions, k), [actions]);
}

export function useTopScreenHint(): string | undefined {
  const { hints } = useNavInternal();
  const stack = useNavStack();
  const key = stack[stack.length - 1]?.key ?? '';
  return useSyncExternalStore(hints.subscribe, () => hints.get(key));
}

/** True when any open screen has unsaved changes. */
export function useAnyDirty(): boolean {
  const { dirty } = useNavInternal();
  return useSyncExternalStore(dirty.subscribe, () => dirty.values().some(Boolean));
}

const EMPTY: readonly ScreenActionItem[] = Object.freeze([]);

// ───────────────────────────── Rendering ─────────────────────────────

/** Breadcrumb trail of the stack ("Gateway › Ledgers › HDFC Bank"); clicking pops back. */
export function NavBreadcrumbs() {
  const stack = useNavStack();
  const nav = useNav();
  const { titles, registry } = useNavInternal();
  useSyncExternalStore(titles.subscribe, titles.getVersion);
  const items = stack.map((e, i) => ({
    key: e.key,
    label: titles.get(e.key) ?? screenLabel(registry.get(e.screenId), e.screenId),
    onClick: i < stack.length - 1 ? () => void nav.popTo(i) : undefined,
  }));
  return <Breadcrumbs items={items} maxItems={6} className="bx-shell__breadcrumbs" />;
}

/** Renders the stack: the top full screen visible, lower ones kept mounted (hidden), dialogs on top. */
export function ScreenStack() {
  const stack = useNavStack();
  const { registry } = useNavInternal();
  const mounted = mountedKeys(stack, MAX_MOUNTED);
  const isDialog = (id: string) => registry.get(id)?.presentation === 'dialog';
  const fullIndex = topFullIndex(stack, isDialog);
  return (
    <>
      {stack.map((entry, index) => {
        if (!mounted.has(entry.key)) return null;
        const def = registry.get(entry.screenId);
        if (!def) return null;
        const visible = index === fullIndex || (index > fullIndex && def.presentation === 'dialog');
        return <ScreenHost key={entry.key} entry={entry} index={index} isTop={index === stack.length - 1} visible={visible} def={def} />;
      })}
    </>
  );
}

const FIELD_SELECTOR = 'input:not([type=hidden]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), select:not([disabled]), [role=combobox]:not([aria-disabled=true])';

interface FocusPick {
  el: HTMLElement;
  rank: number;
}

/**
 * Best initial-focus candidate of a screen: [data-autofocus] → first editable field → first grid
 * (reports/lists: arrow keys work at once) → first tabbable → the heading (lib/initialFocus.ts).
 */
function bestFocusCandidate(container: HTMLElement, includeFallbacks: boolean): FocusPick | null {
  const auto = container.querySelector<HTMLElement>('[data-autofocus]');
  if (auto && !auto.closest('[hidden]')) return { el: auto, rank: FOCUS_RANK.autofocus };
  const tabbables = getTabbables(container);
  const field = tabbables.find((el) => el.matches(FIELD_SELECTOR));
  if (field) return { el: field, rank: FOCUS_RANK.field };
  const grid = tabbables.find((el) => el.matches('[role=grid], [role=treegrid]'));
  if (grid) return { el: grid, rank: FOCUS_RANK.grid };
  if (!includeFallbacks) return null;
  if (tabbables[0]) return { el: tabbables[0], rank: FOCUS_RANK.tabbable };
  const target = container.querySelector<HTMLElement>('h1, h2') ?? container;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  return { el: target, rank: FOCUS_RANK.heading };
}

/** Focus the best candidate now; returns what was focused. */
function focusFirst(container: HTMLElement): FocusPick | null {
  const pick = bestFocusCandidate(container, true);
  if (pick) {
    markShellFocus(pick.el);
    pick.el.focus();
  }
  return pick;
}

/**
 * The first pick was only provisional (the screen was still loading): watch the screen and move
 * focus to [data-autofocus] / the first field / the first grid as soon as it renders — unless the
 * user (keyboard or mouse) or the screen itself moved focus meanwhile. Returns a stop function.
 */
function watchInitialFocus(container: HTMLElement, first: FocusPick): () => void {
  if (!needsFocusWatch(first.rank) || typeof MutationObserver === 'undefined') return () => undefined;
  let current = first;
  let done = false;
  let frame = 0;
  const check = () => {
    frame = 0;
    if (done) return;
    const active = document.activeElement;
    const stillFocused = active === current.el || active === null || active === document.body;
    if (!stillFocused || !container.isConnected || container.hidden) {
      stop();
      return;
    }
    const next = bestFocusCandidate(container, false);
    if (next && shouldUpgradeFocus({ rank: current.rank, stillFocused }, next.rank)) {
      markShellFocus(next.el);
      next.el.focus();
      current = next;
      if (!needsFocusWatch(next.rank)) stop();
    }
  };
  const schedule = () => {
    if (!done && frame === 0) frame = requestAnimationFrame(check);
  };
  const observer = new MutationObserver(schedule);
  const onUser = () => stop();
  const timer = setTimeout(() => stop(), INITIAL_FOCUS_WATCH_MS);
  function stop() {
    if (done) return;
    done = true;
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(timer);
    window.removeEventListener('keydown', onUser, true);
    window.removeEventListener('pointerdown', onUser, true);
  }
  observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-autofocus', 'disabled', 'readonly', 'hidden', 'aria-busy'] });
  window.addEventListener('keydown', onUser, true);
  window.addEventListener('pointerdown', onUser, true);
  schedule(); // the content may already have changed since the first pick
  return stop;
}

function ScreenHost({ entry, index, isTop, visible, def }: { entry: NavEntry; index: number; isTop: boolean; visible: boolean; def: ScreenDef }) {
  const internal = useNavInternal();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wasTop = useRef(false);
  const mountedOnce = useRef(false);
  const ctx = useMemo<ScreenContextValue>(() => ({ entry, index, isTop, visible, def }), [entry, index, isTop, visible, def]);
  const isDialog = def.presentation === 'dialog';

  useEffect(() => {
    if (isTop && !wasTop.current) {
      const firstTime = !mountedOnce.current;
      mountedOnce.current = true;
      const restore = firstTime ? null : internal.takeFocusRestore();
      if (!isDialog) {
        let stopWatch: () => void = () => undefined;
        const raf = requestAnimationFrame(() => {
          const c = containerRef.current;
          if (!c) return;
          if (restore && restore.isConnected && c.contains(restore)) {
            restore.focus();
            return;
          }
          if (c.contains(document.activeElement)) return; // the screen focused something itself
          const pick = focusFirst(c);
          // Still loading (skeleton → only the heading or a toolbar button): follow the content in.
          if (pick) stopWatch = watchInitialFocus(c, pick);
        });
        wasTop.current = isTop;
        return () => {
          cancelAnimationFrame(raf);
          stopWatch();
        };
      }
    }
    wasTop.current = isTop;
    return undefined;
  }, [isTop, isDialog, internal]);

  const Comp = def.component;
  const content = useMemo(() => <Comp params={entry.params} />, [Comp, entry.params]);

  return (
    <ScreenContext.Provider value={ctx}>
      <ScreenVisibilityContext.Provider value={visible}>
        <HotkeyScope active={isTop}>
          {index > 0 && !isDialog ? <EscapeToBack /> : null}
          <HotkeyScope>
            {isDialog ? (
              <ScreenErrorBoundary title={def.title}>{content}</ScreenErrorBoundary>
            ) : (
              <div
                ref={containerRef}
                className="bx-screen"
                hidden={!visible}
                data-screen={entry.screenId}
                role="region"
                aria-label={def.title}
              >
                <ScreenErrorBoundary title={def.title}>{content}</ScreenErrorBoundary>
              </div>
            )}
          </HotkeyScope>
        </HotkeyScope>
      </ScreenVisibilityContext.Provider>
    </ScreenContext.Provider>
  );
}

/** Esc → back (screen-level bindings registered by the screen run first and may return false). */
function EscapeToBack() {
  const nav = useNav();
  useHotkeys({
    Escape: () => {
      void nav.back();
    },
  });
  return null;
}

// ───────────────────────────── Dialog screens ─────────────────────────────

export interface DialogScreenProps {
  title: string;
  description?: ReactNode;
  size?: ModalSize;
  footer?: ReactNode;
  footerStart?: ReactNode;
  /** Esc/× close the dialog (via nav.back, which asks when dirty). Default true. */
  dismissible?: boolean;
  children?: ReactNode;
}

/**
 * Body of a screen registered with `presentation: 'dialog'`: a Modal wired to the nav stack
 * (Esc/× → nav.back()). Close it after success with `nav.pop(result)`.
 */
export function DialogScreen({ title, description, size = 'md', footer, footerStart, dismissible = true, children }: DialogScreenProps) {
  const screen = useScreen();
  const nav = useNav();
  useScreenTitle(title);
  return (
    <Modal
      open={screen.visible}
      onClose={() => void nav.back()}
      title={title}
      description={description}
      size={size}
      footer={footer}
      footerStart={footerStart}
      dismissible={dismissible}
    >
      {children}
    </Modal>
  );
}

// ───────────────────────────── Error boundary ─────────────────────────────

interface BoundaryState {
  error: unknown;
}

/** Per-screen error boundary: a crash in one screen never takes down the shell. */
export class ScreenErrorBoundary extends Component<{ title: string; children?: ReactNode }, BoundaryState> {
  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  constructor(props: { title: string; children?: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[pevqori] screen "${this.props.title}" crashed`, error, info.componentStack ?? '');
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return <ScreenCrash title={this.props.title} error={this.state.error} onRetry={() => this.setState({ error: null })} />;
  }
}

function ScreenCrash({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const nav = useContext(NavApiContext);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(errorDetailsText(error, { Screen: title, Time: new Date().toISOString() }));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="bx-crash" role="alert">
      <Icon name="alert" size="xl" className="bx-crash__icon" />
      <h2 className="bx-crash__title">“{title}” ran into a problem</h2>
      <p className="bx-crash__body">
        Your saved data is safe. {userMessage(error)} You can go back, or try opening the screen again.
      </p>
      <div className="bx-crash__actions">
        {nav ? (
          <Button variant="primary" icon="arrow-left" onClick={() => nav.pop()}>
            Go back
          </Button>
        ) : null}
        <Button icon="refresh" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="ghost" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy details'}
        </Button>
      </div>
    </div>
  );
}

export { ROOT_SCREEN };
