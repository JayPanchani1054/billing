/**
 * Navigation stack — pure state + result delivery (unit-tested in navStack.test.ts).
 *
 * The stack always starts with the Gateway (`ROOT_SCREEN`), which can never be popped. Screens are
 * pushed on top; Esc pops. Lower screens stay mounted (Tally keeps your place) up to MAX_MOUNTED.
 *
 * Results ("Alt+C create a master from a picker and come back"): `pushForResult` registers a waiter
 * for the new entry's key in a ResultBroker. When that exact entry is popped with a value the waiter
 * resolves with it; when it leaves the stack any other way (Esc, popTo, reset, replace) it resolves
 * with `undefined`.
 */

export const ROOT_SCREEN = 'app.gateway';
/** Deeper screens than this are unmounted (their state is lost; they remount when you pop back). */
export const MAX_MOUNTED = 8;

export type NavParams = Readonly<Record<string, unknown>>;

export interface NavEntry {
  /** Unique per push — React key, focus/dirty/title bookkeeping, result routing. */
  readonly key: string;
  readonly screenId: string;
  readonly params: NavParams;
  /** Opened with pushForResult: the screen should `pop(result)` when done ("Save & return"). */
  readonly forResult: boolean;
}

export type NavAction =
  | { type: 'push'; entry: NavEntry }
  | { type: 'replace'; entry: NavEntry }
  | { type: 'pop'; count?: number }
  | { type: 'popTo'; index: number }
  | { type: 'popEntry'; key: string }
  | { type: 'reset' };

let keySeq = 0;
/** Fresh entry key ('s1', 's2', …). */
export function newEntryKey(): string {
  keySeq += 1;
  return `s${keySeq}`;
}

export function makeEntry(screenId: string, params: NavParams = {}, forResult = false, key: string = newEntryKey()): NavEntry {
  return Object.freeze({ key, screenId, params: Object.freeze({ ...params }), forResult });
}

export function createRootStack(rootKey = 'root'): readonly NavEntry[] {
  return [makeEntry(ROOT_SCREEN, {}, false, rootKey)];
}

/**
 * Pure reducer. Invariants: the stack is never empty and index 0 (the Gateway) is never removed or
 * replaced. Returns the same array when nothing changes.
 */
export function navReducer(stack: readonly NavEntry[], action: NavAction): readonly NavEntry[] {
  switch (action.type) {
    case 'push':
      return [...stack, action.entry];
    case 'replace':
      // Replacing the Gateway would lose the home screen: treat it as a push.
      if (stack.length <= 1) return [...stack, action.entry];
      return [...stack.slice(0, -1), action.entry];
    case 'pop': {
      const count = Math.max(0, Math.floor(action.count ?? 1));
      if (count === 0 || stack.length <= 1) return stack;
      return stack.slice(0, Math.max(1, stack.length - count));
    }
    case 'popTo': {
      const index = Math.max(0, Math.min(Math.floor(action.index), stack.length - 1));
      if (index === stack.length - 1) return stack;
      return stack.slice(0, index + 1);
    }
    case 'popEntry': {
      const i = stack.findIndex((e) => e.key === action.key);
      if (i <= 0) return stack; // unknown, or the Gateway
      return stack.slice(0, i);
    }
    case 'reset':
      return stack.length <= 1 ? stack : stack.slice(0, 1);
    default:
      return stack;
  }
}

/** Keys present in `prev` but not in `next` (entries that left the stack), top-most first. */
export function removedEntries(prev: readonly NavEntry[], next: readonly NavEntry[]): NavEntry[] {
  const keep = new Set(next.map((e) => e.key));
  return prev.filter((e) => !keep.has(e.key)).reverse();
}

/** Which entries stay mounted: the top `limit` entries (the Gateway remounts cheaply). */
export function mountedKeys(stack: readonly NavEntry[], limit: number = MAX_MOUNTED): Set<string> {
  const n = Math.max(1, limit);
  return new Set(stack.slice(Math.max(0, stack.length - n)).map((e) => e.key));
}

/**
 * Index of the screen that fills the workspace: the top-most entry whose presentation is 'full'.
 * Entries above it are dialogs drawn over it.
 */
export function topFullIndex(stack: readonly NavEntry[], isDialog: (screenId: string) => boolean): number {
  for (let i = stack.length - 1; i >= 0; i--) if (!isDialog(stack[i].screenId)) return i;
  return 0;
}

export interface Crumb {
  key: string;
  index: number;
  label: string;
}

export function breadcrumbTrail(stack: readonly NavEntry[], labelOf: (entry: NavEntry) => string): Crumb[] {
  return stack.map((e, index) => ({ key: e.key, index, label: labelOf(e) }));
}

type Settle = (value: unknown) => void;

/**
 * Routes results to `pushForResult` waiters. A waiter is keyed by the stack entry it opened and is
 * settled exactly once: with the value given to `deliver(key, value)`, or with `undefined` from
 * `settle(keys)` when the entry left the stack without a result.
 */
export class ResultBroker {
  private readonly waiters = new Map<string, Settle>();

  wait<R>(key: string): Promise<R | undefined> {
    return new Promise<R | undefined>((resolve) => {
      // A second wait on the same key replaces the first, which resolves undefined.
      this.waiters.get(key)?.(undefined);
      this.waiters.set(key, (v) => resolve(v as R | undefined));
    });
  }

  has(key: string): boolean {
    return this.waiters.has(key);
  }

  /** Resolve the waiter of `key` with `value`. Returns false when nobody waits for that entry. */
  deliver(key: string, value: unknown): boolean {
    const w = this.waiters.get(key);
    if (!w) return false;
    this.waiters.delete(key);
    w(value);
    return true;
  }

  /** Resolve the waiters of entries that left the stack with `undefined`. */
  settle(keys: Iterable<string>): void {
    for (const k of keys) this.deliver(k, undefined);
  }

  /** Resolve every waiter with `undefined` (company closed, app reset). */
  settleAll(): void {
    this.settle([...this.waiters.keys()]);
  }

  get size(): number {
    return this.waiters.size;
  }
}

/**
 * Apply an action and settle results in one step. `result` (when given) goes to the waiter of the
 * entry that was on top before the action — only if that entry actually left the stack.
 */
export function transition(
  stack: readonly NavEntry[],
  action: NavAction,
  broker: ResultBroker,
  result?: { value: unknown },
): { next: readonly NavEntry[]; removed: NavEntry[] } {
  const next = navReducer(stack, action);
  const removed = removedEntries(stack, next);
  if (removed.length === 0) return { next, removed };
  const target = action.type === 'popEntry' ? action.key : stack[stack.length - 1]?.key;
  for (const e of removed) {
    if (result && e.key === target) broker.deliver(e.key, result.value);
    else broker.deliver(e.key, undefined);
  }
  return { next, removed };
}
