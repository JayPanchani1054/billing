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
 * refetch(): start a new request only when none is running; otherwise share the one in flight
 * (a screen revealed after an invalidation fetches by itself and may also refetch on reveal — the
 * heavy dashboard must not be computed twice).
 */
export function forceOnRefetch(fetching: boolean): boolean {
  return !fetching;
}
