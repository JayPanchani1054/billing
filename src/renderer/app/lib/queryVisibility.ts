/**
 * When may a mounted query fetch by itself? — pure (tested in queryVisibility.test.ts).
 *
 * Lower screens of the navigation stack stay mounted but hidden. Their queries still go stale on
 * invalidation (a voucher save invalidates reports, dashboard, pickers…), but they must not hit
 * the core while nobody can see them: a hidden screen waits and fetches when it is shown again
 * (the stale flag is kept). Explicit refetch() calls are not affected.
 */
export function shouldAutoFetch(opts: { enabled: boolean; visible: boolean; needsFetch: boolean }): boolean {
  return opts.enabled && opts.visible && opts.needsFetch;
}

/**
 * refetch(): start a new request unless one is already running whose answer is current (it started
 * after the latest invalidation — e.g. the request a revealed screen started by itself; the heavy
 * dashboard must not be computed twice). A request that started BEFORE the latest invalidation
 * (a mutation saved meanwhile) is never shared: it may carry pre-save data
 * (QueryCache.hasCurrentRequest).
 */
export function forceOnRefetch(currentRequestInFlight: boolean): boolean {
  return !currentRequestInFlight;
}
