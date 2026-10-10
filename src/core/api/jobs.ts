/**
 * Exclusive jobs: a long, asynchronous job (an Excel/CSV import) that keeps ONE transaction open on a
 * company's connection while it yields to the event loop between chunks (to publish progress).
 * While it runs, the dispatcher refuses every other company route on that connection — except the
 * ones the job allows (its progress route) — with CONFLICT, so no other request can join, read the
 * uncommitted work of, or be rolled back with the job's transaction.
 */
import type { Db } from '../db/db.ts';
import { AppError } from '../lib/errors.ts';

export interface ExclusiveJob {
  /** Shown to anyone whose request is refused meanwhile. */
  message: string;
  /** Routes still served while the job runs (they must not touch the database). */
  allow: ReadonlySet<string>;
}

const running = new WeakMap<Db, ExclusiveJob>();
const finished = new WeakMap<Db, Promise<void>>();
const activeWork = new WeakMap<Db, number>();

/**
 * Count one asynchronous company request on `db` (the dispatcher calls this for every
 * `transactional: false` route before its handler starts) until the returned function is called.
 * Such requests (an export, a backup, a Tally import) yield to the event loop and write later — e.g.
 * their edit-log entry, a Tally chunk — with ctx.db.transaction(): if an exclusive job had started
 * meanwhile, those writes would nest inside the job's transaction and vanish when it rolls back (a
 * preview always does). So a job only starts when no other such request is in flight.
 */
export function beginCompanyWork(db: Db): () => void {
  activeWork.set(db, (activeWork.get(db) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (activeWork.get(db) ?? 1) - 1;
    if (n > 0) activeWork.set(db, n);
    else activeWork.delete(db);
  };
}

/** Asynchronous company requests in flight on `db` (see beginCompanyWork). */
export function companyWorkInFlight(db: Db): number {
  return activeWork.get(db) ?? 0;
}

/**
 * Details of a CONFLICT that only means "busy right now — the same request will work once the other
 * task finishes" (a backup, export, Tally import or import job holds the company). The renderer offers
 * "Wait and retry" for it (app/lib/apiErrors.ts isBusyConflict).
 */
export const BUSY_DETAILS: { readonly reason: 'busy'; readonly retryable: true } = { reason: 'busy', retryable: true };

export const OTHER_WORK_RUNNING_MESSAGE =
  'Another task is still running in this company (an export, a backup or a Tally import). Wait for it to finish, then try again.';

/** The job holding `db`, if any (the dispatcher checks this for every company route). */
export function exclusiveJobFor(db: Db): ExclusiveJob | undefined {
  return running.get(db);
}

/**
 * Resolves once the job holding `db` has committed or rolled back (immediately when none runs). Never
 * rejects. App-level writes that bypass the dispatcher (the controller's logout/idle edit-log entry)
 * wait for this, so they are never swallowed by — or rolled back with — the job's transaction.
 */
export function whenJobDone(db: Db): Promise<void> {
  return finished.get(db) ?? Promise.resolve();
}

/**
 * Run `fn` in one transaction on `db` as an exclusive job (see above). Throws CONFLICT when another
 * job already holds the connection, or when another asynchronous request is still in flight on it
 * (the caller's own request — counted by the dispatcher — is the one allowed), and INTERNAL when a
 * transaction is open on it (a nested call).
 */
export async function runExclusiveJob<T>(db: Db, job: ExclusiveJob, fn: () => Promise<T>): Promise<T> {
  if (running.has(db)) throw new AppError('CONFLICT', running.get(db)?.message ?? 'Another job is running. Wait for it to finish.', BUSY_DETAILS);
  if (companyWorkInFlight(db) > 1) throw new AppError('CONFLICT', OTHER_WORK_RUNNING_MESSAGE, BUSY_DETAILS);
  if (db.inTransaction) throw new AppError('INTERNAL', 'An exclusive job cannot start inside a transaction.');
  running.set(db, job);
  let release: () => void = () => undefined;
  finished.set(
    db,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    return await db.transactionAsync(fn);
  } finally {
    running.delete(db);
    finished.delete(db);
    release();
  }
}
