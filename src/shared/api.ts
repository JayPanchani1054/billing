/**
 * Wire-level contract between renderer and main. Every IPC call resolves to an ApiResult —
 * handlers never throw across the bridge.
 */

export type ErrorCode =
  | 'VALIDATION'        // input failed schema validation
  | 'BUSINESS_RULE'     // valid input rejected by an accounting/GST rule (e.g. unbalanced voucher)
  | 'NOT_FOUND'
  | 'CONFLICT'          // duplicate name/number, stale update
  | 'FORBIDDEN'         // permission denied
  | 'UNAUTHENTICATED'   // login required / session expired
  | 'LOCKED'            // period locked, account locked, company vault locked
  | 'NO_COMPANY'        // route needs an open company
  | 'UNKNOWN_ROUTE'
  | 'INTERNAL';

export interface ApiErrorPayload {
  code: ErrorCode;
  message: string;
  /** Field-level issues for VALIDATION (path → message) or extra context. */
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorPayload };

/** Field issue reported by the validator; `path` is dot/bracket notation, e.g. `items[2].qty`. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** IPC channel names. The renderer only ever talks to main through these. */
export const IPC = {
  /** invoke(route: string, input: unknown) → ApiResult */
  api: 'bahi:api',
  /** invoke(kind: NativeAction, payload) → ApiResult — dialogs, print, open external, etc. */
  native: 'bahi:native',
  /** main → renderer push events (menu commands, update available, company closed, …) */
  event: 'bahi:event',
} as const;
