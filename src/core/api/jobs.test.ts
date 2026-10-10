/**
 * Exclusive jobs (api/jobs.ts): one open transaction across a long async job, and nothing else may
 * write into it — neither later requests (dispatcher) nor requests already in flight when it starts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Db } from '../db/db.ts';
import { AppError } from '../lib/errors.ts';
import { beginCompanyWork, BUSY_DETAILS, companyWorkInFlight, exclusiveJobFor, OTHER_WORK_RUNNING_MESSAGE, runExclusiveJob, whenJobDone } from './jobs.ts';

const job = { message: 'An import is running.', allow: new Set<string>() };
const code = (err: unknown): string => (err instanceof AppError ? err.code : String(err));

describe('exclusive jobs', () => {
  it('counts in-flight async work and refuses to start a job under someone else’s (its own request is allowed)', async () => {
    const db = new Db(':memory:');
    try {
      db.exec('CREATE TABLE t (x INTEGER)');
      const own = beginCompanyWork(db); // the import request itself (the dispatcher counts it)
      const other = beginCompanyWork(db); // e.g. an export that yields and audits at the end
      assert.equal(companyWorkInFlight(db), 2);
      await assert.rejects(
        runExclusiveJob(db, job, async () => undefined),
        (err: unknown) => code(err) === 'CONFLICT' && (err as Error).message === OTHER_WORK_RUNNING_MESSAGE,
      );
      // "Busy" conflicts say so in their details, so the screen can offer "Wait and retry".
      await assert.rejects(runExclusiveJob(db, job, async () => undefined), (err: unknown) => JSON.stringify((err as { details?: unknown }).details) === JSON.stringify(BUSY_DETAILS));
      assert.deepEqual(BUSY_DETAILS, { reason: 'busy', retryable: true });
      assert.equal(db.inTransaction, false, 'nothing was started');
      other();
      other(); // idempotent
      assert.equal(companyWorkInFlight(db), 1);
      assert.equal(await runExclusiveJob(db, job, async () => 'ran'), 'ran');
      own();
      assert.equal(companyWorkInFlight(db), 0);
    } finally {
      db.close();
    }
  });

  it('whenJobDone resolves only after the job committed or rolled back (never rejects)', async () => {
    const db = new Db(':memory:');
    try {
      db.exec('CREATE TABLE t (x INTEGER)');
      await whenJobDone(db); // no job: immediate
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const running = runExclusiveJob(db, job, async () => {
        db.run('INSERT INTO t (x) VALUES (1)');
        await gate;
        throw new Error('preview rollback');
      });
      assert.equal(exclusiveJobFor(db), job);
      let doneSeen = false;
      const done = whenJobDone(db).then(() => {
        doneSeen = true;
        // By now the job's transaction is over: a write here is the caller's own.
        assert.equal(db.inTransaction, false);
        db.run('INSERT INTO t (x) VALUES (2)');
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(doneSeen, false);
      release();
      await assert.rejects(running, /preview rollback/);
      await done;
      assert.equal(exclusiveJobFor(db), undefined);
      assert.deepEqual(
        db.all<{ x: number }>('SELECT x FROM t').map((r) => r.x),
        [2],
        'the job rolled back; the deferred write survived',
      );
    } finally {
      db.close();
    }
  });
});
