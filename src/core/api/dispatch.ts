/**
 * The dispatcher: the single entry point from IPC into core. For every call it
 *   1. resolves the route (unknown → UNKNOWN_ROUTE),
 *   2. enforces the session idle timeout,
 *   3. checks scope (company routes need an open company → NO_COMPANY) and authentication
 *      (→ UNAUTHENTICATED) and the route's permission (→ FORBIDDEN; Owner holds all),
 *   4. validates the input schema (→ VALIDATION with field issues),
 *   5. runs the handler — company routes inside one DB transaction unless `transactional: false`,
 *   6. maps errors to ApiResult payloads. AppErrors pass through; everything else is logged in full
 *      and returned as a generic INTERNAL error (stack traces never cross the bridge).
 *
 * Transaction rule: a transactional handler must be synchronous. If it returns a Promise the
 * transaction is rolled back and the call fails with INTERNAL telling the developer to set
 * `transactional: false` (async handlers then manage their own ctx.db.transaction blocks).
 */
import type { ApiErrorPayload, ApiResult } from '../../shared/api.ts';
import type { Db } from '../db/db.ts';
import { appendAudit } from '../lib/audit.ts';
import { AppError, toErrorPayload } from '../lib/errors.ts';
import { parse } from '../lib/validate.ts';
import type { AppCtx, AppRuntime, Clock, CompanyCtx, OpenCompanyInfo, Session } from './context.ts';
import { beginCompanyWork, exclusiveJobFor } from './jobs.ts';
import type { AnyRoute, RouteAccess, RouteMap } from './route.ts';

/** Snapshot of runtime state the dispatcher needs for one call. */
export interface DispatchState {
  app: AppRuntime;
  clock: Clock;
  company: OpenCompanyInfo | null;
  db: Db | null;
  session: Session | null;
  /** When true, company routes are refused until the user changes their password. */
  mustChangePassword?: boolean;
  /** Idle timeout for non-implicit sessions, in ms. 0/undefined disables it. */
  idleTimeoutMs?: number;
  /** Epoch ms of the last authorised call (0/undefined = unknown, never expires). */
  lastActivityMs?: number;
  /** Record activity for the idle timer. */
  touch?(nowMs: number): void;
  /** Drop the session because of inactivity (company stays open; login required). */
  expireSession?(): void;
  /**
   * Register an in-flight asynchronous (`transactional: false`) company route call, so the runtime
   * can let it finish before closing the database under it.
   */
  track?(work: Promise<unknown>): void;
}

export interface Dispatcher {
  dispatch(route: string, input: unknown): Promise<ApiResult<unknown>>;
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

function isPromiseLike(x: unknown): x is PromiseLike<unknown> {
  return x !== null && (typeof x === 'object' || typeof x === 'function') && typeof (x as { then?: unknown }).then === 'function';
}

function hasAccess(session: Session, access: RouteAccess): boolean {
  if (access === 'public' || access === 'authenticated') return true;
  return session.isOwner || session.permissions.has(access);
}

function unauthenticated(expired: boolean): AppError {
  return expired
    ? new AppError('UNAUTHENTICATED', 'Your session ended after a period of inactivity. Please log in again.', { reason: 'idle' })
    : new AppError('UNAUTHENTICATED', 'Please log in to continue.');
}

/**
 * Translate SQLite constraint failures that slipped past service checks into user-facing errors.
 * Returns null for anything else.
 */
function sqliteConstraintPayload(err: unknown): ApiErrorPayload | null {
  const e = err as { code?: unknown; errcode?: unknown };
  if (!(err instanceof Error) || e.code !== 'ERR_SQLITE_ERROR') return null;
  if (e.errcode === SQLITE_CONSTRAINT_UNIQUE || e.errcode === SQLITE_CONSTRAINT_PRIMARYKEY)
    return { code: 'CONFLICT', message: 'A record with the same name or number already exists.' };
  if (e.errcode === SQLITE_CONSTRAINT_FOREIGNKEY)
    return { code: 'BUSINESS_RULE', message: 'This change conflicts with related records (it is in use, or refers to something that no longer exists).' };
  return null;
}

/**
 * Strict route input: when on, a key that a route's input schema does not declare is a VALIDATION error
 * ("Unknown field …") instead of being dropped, so a misspelt filter (`action` for `actions`) fails
 * loudly rather than returning unfiltered data.
 *   - Off in production builds, where a renderer that sends an extra key must keep working.
 *   - On under `node --test` (NODE_TEST_CONTEXT is set in every test process), i.e. the whole test suite,
 *     and in development (`BAHI_STRICT_INPUT=1`, set by scripts/dev.mjs).
 * Schemas built with `v.strictObject` (e.g. the edit-log filters) reject unknown keys in production too.
 */
let strictRouteInput =
  typeof process !== 'undefined' && (process.env?.BAHI_STRICT_INPUT === '1' || process.env?.NODE_TEST_CONTEXT !== undefined);

export function setStrictRouteInput(on: boolean): void {
  strictRouteInput = on;
}

export function isStrictRouteInput(): boolean {
  return strictRouteInput;
}

export function createDispatcher(routes: RouteMap, getState: () => DispatchState): Dispatcher {
  return {
    async dispatch(name: string, input: unknown): Promise<ApiResult<unknown>> {
      const route: AnyRoute | undefined = typeof name === 'string' && Object.hasOwn(routes, name) ? routes[name] : undefined;
      if (!route) return { ok: false, error: { code: 'UNKNOWN_ROUTE', message: `Unknown action: ${String(name).slice(0, 100)}` } };

      let state: DispatchState | null = null;
      try {
        state = getState();
        const st = state;
        const nowMs = st.clock.now().getTime();

        // Idle timeout (only for real users; the implicit owner session never expires).
        let session = st.session;
        let expired = false;
        if (
          session &&
          !session.implicit &&
          st.idleTimeoutMs &&
          st.idleTimeoutMs > 0 &&
          st.lastActivityMs &&
          nowMs - st.lastActivityMs > st.idleTimeoutMs
        ) {
          st.expireSession?.();
          session = null;
          expired = true;
        }

        if (route.scope === 'company') {
          if (!st.company || !st.db) throw new AppError('NO_COMPANY', 'Open a company first.');
          if (!session) throw unauthenticated(expired);
          // A long job (import) holds one open transaction on this connection: nothing else may join it.
          const job = exclusiveJobFor(st.db);
          if (job && !job.allow.has(name)) throw new AppError('CONFLICT', job.message);
          if (st.mustChangePassword)
            throw new AppError('UNAUTHENTICATED', 'Please change your password to continue.', { reason: 'must_change_password' });
        } else if (route.access !== 'public' && !session) {
          throw unauthenticated(expired);
        }
        if (session && !hasAccess(session, route.access)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
        if (session && route.access !== 'public') st.touch?.(nowMs);

        const parsed: unknown = parse(route.input, input, { unknownKeys: strictRouteInput ? 'reject' : 'strip' });

        let data: unknown;
        if (route.scope === 'company') {
          const db = st.db as Db;
          const s = session as Session;
          const ctx: CompanyCtx = {
            app: st.app,
            clock: st.clock,
            session: s,
            company: st.company as OpenCompanyInfo,
            db,
            audit: (entry) => {
              appendAudit(db, entry, s, st.clock.now());
            },
          };
          if (route.transactional === false) {
            // Counted while in flight, so an exclusive job (import) cannot start under it (api/jobs.ts).
            const endWork = beginCompanyWork(db);
            // Starts synchronously (like a direct call); a sync throw becomes a rejection.
            const work = (async () => route.handler(ctx, parsed))();
            void work.then(endWork, endWork);
            st.track?.(work);
            data = await work;
          } else {
            data = db.transaction(() => {
              const out = route.handler(ctx, parsed);
              if (isPromiseLike(out)) {
                // Swallow the orphaned promise's outcome; the transaction is rolled back below.
                Promise.resolve(out).catch(() => undefined);
                throw new AppError(
                  'INTERNAL',
                  `Route "${name}" is transactional but its handler returned a Promise. ` +
                    'Make the handler synchronous, or set transactional: false and use ctx.db.transaction() yourself.',
                );
              }
              return out;
            });
          }
        } else {
          const ctx: AppCtx = { app: st.app, clock: st.clock, session, company: st.company };
          data = await route.handler(ctx, parsed);
        }
        return { ok: true, data: data === undefined ? null : data };
      } catch (err) {
        const log = state?.app.log;
        if (err instanceof AppError) {
          if (err.code === 'INTERNAL') log?.('error', `Route ${name} failed`, { error: err });
          return { ok: false, error: err.toPayload() };
        }
        const constraint = sqliteConstraintPayload(err);
        if (constraint) {
          log?.('warn', `Route ${name}: database constraint`, { error: err });
          return { ok: false, error: constraint };
        }
        try {
          log?.('error', `Route ${name} failed`, { error: err });
        } catch {
          /* logging must never mask the original failure */
        }
        return { ok: false, error: toErrorPayload(err) };
      }
    },
  };
}
