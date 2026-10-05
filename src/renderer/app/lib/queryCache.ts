/**
 * A small query cache for API reads (pure; unit-tested in queryCache.test.ts).
 *
 * - Entries are keyed by route + stable JSON of the input (`queryKey`).
 * - `fetch` de-duplicates concurrent requests for the same key.
 * - Stale-while-revalidate: an entry keeps its data while it refetches; `invalidate(prefix)` marks
 *   entries stale and notifies subscribers (mounted queries refetch, unmounted ones refetch on mount).
 * - A response that started before the latest invalidation is stored but stays stale, so the
 *   subscriber fetches again and never shows pre-mutation data as fresh.
 * - Snapshots are immutable: a new object per change (works with useSyncExternalStore).
 */

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

export interface QuerySnapshot<T = unknown> {
  readonly key: string;
  readonly route: string;
  readonly status: QueryStatus;
  readonly data: T | undefined;
  readonly error: unknown;
  /** Clock ms of the last successful response (0 = never). */
  readonly updatedAt: number;
  readonly stale: boolean;
  readonly fetching: boolean;
}

interface Entry {
  snapshot: QuerySnapshot;
  promise: Promise<unknown> | null;
  /** Sequence number of the request in flight. */
  startedSeq: number;
  /** Sequence number at the last invalidation. */
  invalidatedSeq: number;
  listeners: Set<() => void>;
  lastUsed: number;
}

/** JSON with object keys sorted (so {a,b} and {b,a} share a cache key). undefined members are dropped. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? 'null';
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value instanceof Uint8Array) return Array.from(value);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = normalize(v);
  }
  return out;
}

const SEP = '\u0000';

export function queryKey(route: string, input: unknown): string {
  return `${route}${SEP}${stableStringify(input ?? {})}`;
}

export function routeOfKey(key: string): string {
  const i = key.indexOf(SEP);
  return i < 0 ? key : key.slice(0, i);
}

/**
 * Does `route` fall under `prefix`? 'accounts' matches 'accounts.ledger.list'; 'accounts.ledger'
 * matches 'accounts.ledger.get'; an exact route matches itself; '' matches everything.
 */
export function routeMatches(route: string, prefix: string): boolean {
  if (prefix === '' || prefix === '*') return true;
  if (route === prefix) return true;
  const p = prefix.endsWith('.') ? prefix : `${prefix}.`;
  return route.startsWith(p);
}

export interface QueryCacheOptions {
  now?: () => number;
}

export class QueryCache {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  private readonly now: () => number;
  private readonly globalListeners = new Set<() => void>();
  private inFlight = 0;

  constructor(options: QueryCacheOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private ensure(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = {
        snapshot: Object.freeze({
          key,
          route: routeOfKey(key),
          status: 'idle',
          data: undefined,
          error: null,
          updatedAt: 0,
          stale: true,
          fetching: false,
        }) as QuerySnapshot,
        promise: null,
        startedSeq: 0,
        invalidatedSeq: 0,
        listeners: new Set(),
        lastUsed: this.now(),
      };
      this.entries.set(key, e);
    }
    return e;
  }

  private update(e: Entry, patch: Partial<QuerySnapshot>): void {
    e.snapshot = Object.freeze({ ...e.snapshot, ...patch });
    for (const l of [...e.listeners]) l();
  }

  /** Current snapshot (undefined when the key was never used). */
  peek<T>(key: string): QuerySnapshot<T> | undefined {
    return this.entries.get(key)?.snapshot as QuerySnapshot<T> | undefined;
  }

  subscribe(key: string, listener: () => void): () => void {
    const e = this.ensure(key);
    e.listeners.add(listener);
    e.lastUsed = this.now();
    return () => {
      e.listeners.delete(listener);
      e.lastUsed = this.now();
    };
  }

  subscriberCount(key: string): number {
    return this.entries.get(key)?.listeners.size ?? 0;
  }

  /** Should a mounted query (re)fetch now? */
  needsFetch(key: string, staleTimeMs: number): boolean {
    const e = this.entries.get(key);
    if (!e) return true;
    if (e.promise) return false;
    const s = e.snapshot;
    if (s.status === 'idle') return true;
    if (s.status === 'error') return false; // errors refetch only on demand (refetch / invalidate)
    if (s.stale) return true;
    return this.now() - s.updatedAt > staleTimeMs;
  }

  /**
   * Run `fetcher` for `key` unless a request is already in flight (then that promise is returned).
   * `force` starts a new request even when one is running (the newest response wins).
   */
  fetch<T>(key: string, fetcher: () => Promise<T>, options: { force?: boolean } = {}): Promise<T> {
    const e = this.ensure(key);
    e.lastUsed = this.now();
    if (e.promise && !options.force) return e.promise as Promise<T>;
    const mySeq = ++this.seq;
    e.startedSeq = mySeq;
    const loading = e.snapshot.status === 'idle' || (e.snapshot.status === 'error' && e.snapshot.data === undefined);
    this.update(e, { fetching: true, status: loading ? 'loading' : e.snapshot.status });
    this.bumpInFlight(1);
    let p: Promise<T>;
    try {
      p = fetcher();
    } catch (err) {
      p = Promise.reject(err);
    }
    const tracked = p.then(
      (data) => {
        this.bumpInFlight(-1);
        if (e.startedSeq === mySeq) {
          e.promise = null;
          const stillFresh = e.invalidatedSeq < mySeq;
          this.update(e, { status: 'success', data, error: null, updatedAt: this.now(), stale: !stillFresh, fetching: false });
        }
        return data;
      },
      (err: unknown) => {
        this.bumpInFlight(-1);
        if (e.startedSeq === mySeq) {
          e.promise = null;
          this.update(e, { status: 'error', error: err, fetching: false, stale: true });
        }
        throw err;
      },
    );
    e.promise = tracked;
    // The cache itself never surfaces unhandled rejections; callers that await get the error.
    tracked.catch(() => undefined);
    return tracked;
  }

  /** Replace the data of a key (e.g. after a mutation returned the fresh object). */
  setData<T>(key: string, data: T): void {
    const e = this.ensure(key);
    this.update(e, { status: 'success', data, error: null, updatedAt: this.now(), stale: false });
  }

  /**
   * Mark entries whose route matches `prefix` (see routeMatches) stale and notify their subscribers.
   * Returns the keys that were invalidated.
   */
  invalidate(prefix = ''): string[] {
    const mark = ++this.seq;
    const keys: string[] = [];
    for (const [key, e] of this.entries) {
      if (!routeMatches(e.snapshot.route, prefix)) continue;
      e.invalidatedSeq = mark;
      keys.push(key);
      if (e.snapshot.status === 'error') this.update(e, { status: e.snapshot.data === undefined ? 'idle' : 'success', stale: true });
      else this.update(e, { stale: true });
    }
    return keys;
  }

  /** Drop everything (company closed / switched): no data may leak across companies. */
  clear(): void {
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const e of all) {
      e.startedSeq = -1; // ignore responses still in flight
      for (const l of [...e.listeners]) l();
    }
  }

  /** Remove unsubscribed entries unused for longer than `maxIdleMs`. */
  gc(maxIdleMs: number): number {
    const now = this.now();
    let removed = 0;
    for (const [key, e] of this.entries) {
      if (e.listeners.size === 0 && !e.promise && now - e.lastUsed > maxIdleMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Number of requests in flight across all keys. */
  get pending(): number {
    return this.inFlight;
  }

  onActivity(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  private bumpInFlight(d: number): void {
    this.inFlight = Math.max(0, this.inFlight + d);
    for (const l of [...this.globalListeners]) l();
  }
}
