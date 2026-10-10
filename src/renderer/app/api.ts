/**
 * Typed API client. Route names, inputs and outputs come from the core route table
 * (`import type` only — no core code is bundled into the renderer).
 *
 *   const state = await api('app.state');
 *   const profile = await api('company.profile.save', input);   // throws ApiError on failure
 *
 * Errors: `ApiError(code, message, details)`. UNAUTHENTICATED / NO_COMPANY from company routes
 * notify the app state (session expired → login screen; company gone → company list).
 */
import type { ApiResult } from '../../shared/api.ts';
import type { RouteInput, RouteOutput } from '../../core/api/route.ts';
import type { ApiRoutes, RouteName } from '../../core/api/routes.ts';
import { getBridge } from './bridge.ts';
import { ApiError } from './lib/apiErrors.ts';

export type { RouteName };
export type ApiInput<K extends RouteName> = RouteInput<ApiRoutes[K]>;
export type ApiOutput<K extends RouteName> = RouteOutput<ApiRoutes[K]>;
/** Input is optional for routes that take none (v.none()) or only optional fields. */
export type ApiArgs<K extends RouteName> = Record<string, never> extends ApiInput<K> ? [input?: ApiInput<K>] : [input: ApiInput<K>];

type SessionErrorListener = (err: ApiError) => void;
let sessionErrorListener: SessionErrorListener | null = null;

/** The app state registers here to react to expired sessions / closed companies. */
export function setSessionErrorListener(listener: SessionErrorListener | null): void {
  sessionErrorListener = listener;
}

const activityListeners = new Set<() => void>();
let inFlight = 0;
let lastMutationAt = 0;

/** Requests in flight (for the status bar's "Working…" indicator). */
export function apiActivity(): { inFlight: number; lastMutationAt: number } {
  return { inFlight, lastMutationAt };
}

export function onApiActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

function emitActivity(): void {
  for (const l of [...activityListeners]) l();
}

/** Record a successful save (status bar "All changes saved"). Called by useApiMutation. */
export function noteMutation(): void {
  lastMutationAt = Date.now();
  emitActivity();
}

async function call(route: string, input: unknown): Promise<unknown> {
  const bridge = getBridge();
  if (!bridge) throw new ApiError('BRIDGE_UNAVAILABLE', 'Pevqori must be opened from the desktop app.', undefined, route);
  inFlight++;
  emitActivity();
  let res: ApiResult<unknown>;
  try {
    res = await bridge.api(route, input === undefined ? {} : input);
  } catch {
    throw new ApiError('IPC_FAILED', 'The app could not complete the request. Please try again.', undefined, route);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    emitActivity();
  }
  if (!res || typeof res !== 'object') throw new ApiError('IPC_FAILED', 'The app returned an unexpected response.', undefined, route);
  if (res.ok) return res.data;
  const err = ApiError.from(res.error, route);
  if ((err.code === 'UNAUTHENTICATED' || err.code === 'NO_COMPANY') && !route.startsWith('app.')) {
    try {
      sessionErrorListener?.(err);
    } catch {
      // never let a listener mask the original error
    }
  }
  throw err;
}

/** Call a route. Resolves with the route's output; rejects with ApiError. */
export function api<K extends RouteName>(route: K, ...args: ApiArgs<K>): Promise<ApiOutput<K>> {
  return call(route, args[0]) as Promise<ApiOutput<K>>;
}

/**
 * Call a route that may not exist in this build (another module may not have shipped it yet).
 * Untyped on purpose: validate the result at runtime. Rejects with ApiError('UNKNOWN_ROUTE') when
 * the route is missing — see `isMissingRoute`.
 */
export function apiOptional(route: string, input: unknown = {}): Promise<unknown> {
  return call(route, input);
}

export function isMissingRoute(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'UNKNOWN_ROUTE';
}

export { ApiError };
