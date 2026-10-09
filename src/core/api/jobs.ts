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

/** The job holding `db`, if any (the dispatcher checks this for every company route). */
export function exclusiveJobFor(db: Db): ExclusiveJob | undefined {
  return running.get(db);
}

/**
 * Run `fn` in one transaction on `db` as an exclusive job (see above). Throws CONFLICT when another
 * job already holds the connection, or when a transaction is open on it (a nested call).
 */
export async function runExclusiveJob<T>(db: Db, job: ExclusiveJob, fn: () => Promise<T>): Promise<T> {
  if (running.has(db)) throw new AppError('CONFLICT', running.get(db)?.message ?? 'Another job is running. Wait for it to finish.');
  if (db.inTransaction) throw new AppError('INTERNAL', 'An exclusive job cannot start inside a transaction.');
  running.set(db, job);
  try {
    return await db.transactionAsync(fn);
  } finally {
    running.delete(db);
  }
}
