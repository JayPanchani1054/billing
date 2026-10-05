/**
 * The app-wide query cache instance and invalidation helper.
 *
 *   invalidate('accounts')              // every 'accounts.*' query refetches
 *   invalidate('accounts.ledger.list')  // one route, all inputs
 *   invalidate()                        // everything
 */
import { QueryCache } from './lib/queryCache.ts';

export const queryCache = new QueryCache();

export function invalidate(prefix = ''): void {
  queryCache.invalidate(prefix);
}

/** Forget all cached data (company closed/switched or user logged out). */
export function clearQueryCache(): void {
  queryCache.clear();
}

// Drop long-unused entries every few minutes.
if (typeof window !== 'undefined') {
  window.setInterval(() => queryCache.gc(10 * 60_000), 5 * 60_000);
}
