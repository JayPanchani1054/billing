import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from '../api.ts';
import type { ApiInput, ApiOutput, RouteName } from '../api.ts';
import { ApiError } from '../lib/apiErrors.ts';
import { queryKey } from '../lib/queryCache.ts';
import type { QuerySnapshot } from '../lib/queryCache.ts';
import { queryCache } from '../queryClient.ts';

export interface UseApiQueryOptions {
  /** false = don't fetch (e.g. until an id is chosen). Default true. */
  enabled?: boolean;
  /** While the input changes (paging, search), keep showing the previous data instead of a skeleton. */
  keepPrevious?: boolean;
  /** Data younger than this is not refetched on mount (ms, default 30 s). Invalidation always refetches. */
  staleTime?: number;
}

export interface ApiQueryResult<T> {
  data: T | undefined;
  error: ApiError | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  /** First load: no data to show yet (render a skeleton). */
  loading: boolean;
  /** Refetching while showing data (dim/spinner; never a layout jump). */
  refreshing: boolean;
  /** Showing data of a previous input (keepPrevious). */
  isPrevious: boolean;
  /** Fetch again now (bypasses staleTime; shares an in-flight request). */
  refetch: () => Promise<T | undefined>;
}

const DEFAULT_STALE_MS = 30_000;
const noopSubscribe = () => () => undefined;

function asApiError(err: unknown, route: string): ApiError | null {
  if (err === null || err === undefined) return null;
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL', 'Something went wrong while loading. Please try again.', undefined, route);
}

/**
 * Cached, de-duplicated read of an API route (stale-while-revalidate).
 *
 *   const { data, loading, error, refetch } = useApiQuery('company.profile.get', {});
 *   const page = useApiQuery('accounts.ledger.list', { search, limit: 50, offset }, { keepPrevious: true });
 *
 * After a mutation call `invalidate('accounts')` (useApiMutation does it for its module
 * automatically); every mounted query on matching routes refetches in the background.
 */
export function useApiQuery<K extends RouteName>(route: K, input: ApiInput<K>, options: UseApiQueryOptions = {}): ApiQueryResult<ApiOutput<K>> {
  const { enabled = true, keepPrevious = false, staleTime = DEFAULT_STALE_MS } = options;
  const key = queryKey(route, input);
  // The latest input for the fetcher (the key already captures its value).
  const inputRef = useRef(input);
  inputRef.current = input;

  const subscribe = useCallback((cb: () => void) => (enabled ? queryCache.subscribe(key, cb) : noopSubscribe()), [key, enabled]);
  const getSnapshot = useCallback(() => queryCache.peek<ApiOutput<K>>(key), [key]);
  const snap: QuerySnapshot<ApiOutput<K>> | undefined = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const fetchNow = useCallback(
    (force: boolean): Promise<ApiOutput<K> | undefined> =>
      queryCache
        .fetch<ApiOutput<K>>(key, () => api(route, ...([inputRef.current] as never)) as Promise<ApiOutput<K>>, { force })
        .then(
          (d) => d,
          () => undefined,
        ),
    [key, route],
  );

  const stale = snap?.stale ?? true;
  const status = snap?.status ?? 'idle';
  useEffect(() => {
    if (!enabled) return;
    if (queryCache.needsFetch(key, staleTime)) void fetchNow(false);
  }, [enabled, key, staleTime, stale, status, fetchNow]);

  // keepPrevious: remember the last successful data across key changes.
  const prevRef = useRef<{ key: string; data: ApiOutput<K> } | null>(null);
  if (snap?.status === 'success' && snap.data !== undefined) prevRef.current = { key, data: snap.data };

  const refetch = useCallback(() => fetchNow(true), [fetchNow]);

  return useMemo<ApiQueryResult<ApiOutput<K>>>(() => {
    const own = snap?.data;
    const usePrev = own === undefined && keepPrevious && prevRef.current !== null && prevRef.current.key !== key;
    const data = own !== undefined ? own : usePrev ? prevRef.current?.data : undefined;
    const fetching = snap?.fetching ?? false;
    const st = !enabled && !snap ? 'idle' : (snap?.status ?? 'idle');
    return {
      data,
      error: st === 'error' ? asApiError(snap?.error, route) : null,
      status: st,
      loading: enabled && data === undefined && st !== 'error',
      refreshing: fetching && data !== undefined,
      isPrevious: usePrev,
      refetch,
    };
  }, [snap, keepPrevious, key, enabled, route, refetch]);
}
