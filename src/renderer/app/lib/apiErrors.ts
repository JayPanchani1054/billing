/**
 * Client-side API error type and helpers — pure (tested in apiErrors.test.ts).
 */
import type { ApiErrorPayload, ErrorCode, FieldIssue } from '../../../shared/api.ts';

/** Server codes plus client-only ones: no preload bridge (plain browser) or a broken IPC call. */
export type ClientErrorCode = ErrorCode | 'BRIDGE_UNAVAILABLE' | 'IPC_FAILED';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly details: unknown;
  /** Route or native action that failed (for logs / "copy details"). */
  readonly route: string;

  constructor(code: ClientErrorCode, message: string, details?: unknown, route = '') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.route = route;
  }

  static from(payload: ApiErrorPayload, route = ''): ApiError {
    return new ApiError(payload.code, payload.message, payload.details, route);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

function isFieldIssue(x: unknown): x is FieldIssue {
  return typeof x === 'object' && x !== null && typeof (x as FieldIssue).path === 'string' && typeof (x as FieldIssue).message === 'string';
}

/**
 * VALIDATION details → { path: message } (first message per path wins). Paths keep the server's
 * dot/bracket notation ('owner.password', 'items[2].qty'). Non-validation errors → {}.
 */
export function fieldErrorsOf(err: unknown): Record<string, string> {
  if (!isApiError(err) || err.code !== 'VALIDATION' || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const issue of err.details) {
    if (isFieldIssue(issue) && !(issue.path in out)) out[issue.path] = issue.message;
  }
  return out;
}

/** Field errors whose path starts with `prefix.` re-keyed without the prefix ('owner.password' → 'password'). */
export function nestedFieldErrors(errors: Readonly<Record<string, string>>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const p = `${prefix}.`;
  for (const [k, v] of Object.entries(errors)) if (k.startsWith(p)) out[k.slice(p.length)] = v;
  return out;
}

export interface ConfirmationRequest {
  message: string;
  warnings: string[];
}

/**
 * Business-rule confirmation protocol: a route that can proceed after the user accepts warnings
 * fails with BUSINESS_RULE and details `{ needsConfirmation: true, warnings: string[] }`; the
 * client asks and retries the same call with `acknowledgeWarnings: true`.
 */
export function confirmationOf(err: unknown): ConfirmationRequest | null {
  if (!isApiError(err) || err.code !== 'BUSINESS_RULE') return null;
  const d = err.details;
  if (typeof d !== 'object' || d === null || (d as { needsConfirmation?: unknown }).needsConfirmation !== true) return null;
  const raw = (d as { warnings?: unknown }).warnings;
  const warnings = Array.isArray(raw) ? raw.filter((w): w is string => typeof w === 'string' && w.trim() !== '') : [];
  return { message: err.message, warnings };
}

/**
 * CONFLICT that only means "busy right now": an automatic backup, an export, a Tally import or another
 * import holds the company (core api/jobs.ts BUSY_DETAILS). The same request works once that task
 * finishes, so screens offer "Wait and retry" (retryWhileBusy) instead of a dead end.
 */
export function isBusyConflict(err: unknown): boolean {
  if (!isApiError(err) || err.code !== 'CONFLICT') return false;
  const d = err.details;
  return typeof d === 'object' && d !== null && (d as { reason?: unknown }).reason === 'busy';
}

export interface RetryWhileBusyOptions {
  /** Pause between attempts (default 2 s). */
  intervalMs?: number;
  /** Give up (rethrow the last busy conflict) after this long (default 2 minutes). */
  timeoutMs?: number;
  /** Called before each new attempt (attempt 2, 3, …) — e.g. to show "Still waiting…". */
  onWait?: (attempt: number) => void;
  /** Stop waiting (screen closed): the last busy conflict is rethrown. */
  cancelled?: () => boolean;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Run `fn`; while it fails with a busy conflict, wait and run it again (bounded). Other errors are thrown at once. */
export async function retryWhileBusy<T>(fn: () => Promise<T>, opts: RetryWhileBusyOptions = {}): Promise<T> {
  const interval = opts.intervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusyConflict(err) || now() - started + interval > timeout || opts.cancelled?.()) throw err;
    }
    await sleep(interval);
    opts.onWait?.(attempt + 1);
  }
}

/** A sentence safe to show to a user for any thrown value. */
export function userMessage(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === 'BRIDGE_UNAVAILABLE') return 'Pevqori must be opened from the desktop app.';
    if (err.code === 'IPC_FAILED') return 'The app could not complete the request. Please try again; if it keeps happening, restart Pevqori.';
    if (err.code === 'INTERNAL') return err.message || 'Something went wrong. Details have been written to the application log.';
    if (err.code === 'VALIDATION') {
      const fields = Object.values(fieldErrorsOf(err));
      if (fields.length === 1) return fields[0];
      if (fields.length > 1) return `Please correct ${fields.length} fields and try again.`;
    }
    return err.message;
  }
  if (err instanceof Error && err.message) return 'Something went wrong. Please try again.';
  return 'Something went wrong. Please try again.';
}

/** Plain-text details for "Copy details" buttons (never includes input payloads). */
export function errorDetailsText(err: unknown, extra: Record<string, string> = {}): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
  if (isApiError(err)) {
    lines.push(`Code: ${err.code}`);
    if (err.route) lines.push(`Action: ${err.route}`);
    lines.push(`Message: ${err.message}`);
  } else if (err instanceof Error) {
    lines.push(`Error: ${err.name}: ${err.message}`);
    if (err.stack) lines.push(err.stack.split('\n').slice(0, 8).join('\n'));
  } else {
    lines.push(`Error: ${String(err)}`);
  }
  return lines.join('\n');
}
