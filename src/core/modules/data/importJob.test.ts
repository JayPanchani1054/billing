/**
 * Excel/CSV import as an asynchronous, chunked, exclusive job (file-backed company through the real
 * runtime): the event loop is free while it runs (progress is answered, other requests get a clear
 * CONFLICT instead of joining its open transaction), and the result is still all-or-nothing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ApiResult } from '../../../shared/api.ts';
import type { AppState } from '../../../shared/types/app.ts';
import type { ImportCommitResult, ImportPreviewResult, TallyProgress } from '../../../shared/types/data.ts';
import { appRoutes } from '../../app/routes.ts';
import { fixedClock } from '../../app/clock.ts';
import { createRuntimeWithRoutes } from '../../app/runtime-core.ts';
import type { Runtime } from '../../app/runtime.ts';
import { Db } from '../../db/db.ts';
import { makeGstin } from '../../testing/fixtures.ts';
import { companyRoutes } from '../company/routes.ts';
import { IMPORT_CHUNK } from './importer.ts';
import { dataRoutes } from './routes.ts';

let root: string;
let rt: Runtime;
let dbPath: string;

const call = async <T>(route: string, input: unknown = {}): Promise<T> => {
  const r: ApiResult<unknown> = await rt.dispatch(route, input);
  if (!r.ok) {
    const log = path.join(root, 'u', 'logs', 'bahi.log');
    assert.fail(`${route}: ${r.error.code} ${r.error.message} ${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('error')).slice(-3).join('\n') : ''}`);
  }
  return r.data as T;
};
const csv = (s: string): Uint8Array => new TextEncoder().encode(s);
/** n balanced journals of ₹100 each (Office Rent Dr / Capital Cr), dated in April 2026. */
const journals = (n: number, badLast = false): Uint8Array => {
  const lines = ['Voucher Key,Date,Voucher Type,Ledger,Debit,Credit'];
  for (let i = 1; i <= n; i++) {
    const credit = badLast && i === n ? 90 : 100;
    lines.push(`J${i},${String(1 + (i % 28)).padStart(2, '0')}-04-2026,Journal,Office Rent,100,`, `J${i},${String(1 + (i % 28)).padStart(2, '0')}-04-2026,Journal,Owner Capital,,${credit}`);
  }
  return csv(lines.join('\r\n'));
};
const count = (sql: string): number => {
  const db = new Db(dbPath, { readOnly: true });
  try {
    return db.value<number>(sql) ?? 0;
  } finally {
    db.close();
  }
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-impjob-'));
  rt = createRuntimeWithRoutes(
    { userDataDir: path.join(root, 'u'), defaultDataDir: path.join(root, 'data'), appVersion: '1.0.0', clock: fixedClock('2026-10-05'), consoleLog: false },
    { ...appRoutes, ...companyRoutes, ...dataRoutes },
  );
  const s = await call<AppState>('app.company.create', { name: 'Import Job Co', stateCode: '27', gstRegistrationType: 'regular', gstin: makeGstin('27'), booksFrom: '2026-04-01' });
  dbPath = path.join(root, 'data', 'companies', s.companies[0].id, 'company.db');
  const masters = csv('Name,Under\r\nOffice Rent,Indirect Expenses\r\nOwner Capital,Capital Account');
  const m = await call<ImportCommitResult>('data.import.commit', { kind: 'ledgers', fileName: 'l.csv', bytes: masters, options: { skipInvalid: false, updateExisting: false } });
  assert.equal(m.created, 2);
});
afterEach(async () => {
  await rt.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('import job (chunked, own connection)', () => {
  it('answers progress while it runs, refuses other company requests clearly, and the books change only when it commits', async () => {
    const n = IMPORT_CHUNK * 2 + 50; // three chunks
    const job = rt.dispatch('data.import.commit', { kind: 'vouchers_ledger', fileName: 'v.csv', bytes: journals(n), options: { skipInvalid: false, updateExisting: false } });
    let sawRunning = false;
    let sawEmptyBooks = false;
    let settled = false;
    void job.then(() => (settled = true));
    for (let i = 0; i < 200 && !settled; i++) {
      const p = await call<TallyProgress>('data.import.progress');
      if (p.running && p.phase === 'vouchers' && p.done > 0 && p.done < n) {
        sawRunning = true;
        // Another company request is refused at once (it never joins the import's open transaction) …
        const other = await rt.dispatch('company.summary', {});
        assert.equal(other.ok ? 'ok' : other.error.code, 'CONFLICT');
        assert.match(other.ok ? '' : other.error.message, /An import is running/);
        // … and the file shows the books as they were until the import commits.
        if (count('SELECT COUNT(*) FROM vouchers') === 0) sawEmptyBooks = true;
      }
      await new Promise((r) => setImmediate(r));
    }
    const r = await job;
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(sawRunning, 'progress was visible while importing');
    assert.ok(sawEmptyBooks, 'nothing was visible before the commit');
    assert.equal((r.ok ? (r.data as ImportCommitResult) : null)?.created, n);
    assert.equal(count('SELECT COUNT(*) FROM vouchers'), n);
    assert.equal(count('SELECT SUM(amount) FROM ledger_entries'), 0);
    assert.equal(count(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'voucher' AND action = 'create'`), n, 'every voucher audited');
    const done = await call<TallyProgress>('data.import.progress');
    assert.deepEqual([done.running, done.phase, done.done], [false, 'done', n]);
    await call('company.summary'); // the company is free again
  });

  it('stays all-or-nothing across chunks: one bad voucher at the end imports nothing (no numbers used up)', async () => {
    const n = IMPORT_CHUNK + 10;
    const r = await rt.dispatch('data.import.commit', { kind: 'vouchers_ledger', fileName: 'v.csv', bytes: journals(n, true), options: { skipInvalid: false, updateExisting: false } });
    assert.equal(r.ok ? 'ok' : r.error.code, 'VALIDATION');
    assert.equal(count('SELECT COUNT(*) FROM vouchers'), 0);
    assert.equal(count('SELECT COUNT(*) FROM voucher_counters WHERE last_number > 0'), 0);
    assert.equal(count(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'voucher'`), 0);
    // With "skip invalid rows" the rest goes in.
    const ok = await call<ImportCommitResult>('data.import.commit', { kind: 'vouchers_ledger', fileName: 'v.csv', bytes: journals(n, true), options: { skipInvalid: true, updateExisting: false } });
    assert.deepEqual([ok.created, ok.failed], [n - 1, 1]);
  });

  it('a preview writes nothing and one job runs at a time per company', async () => {
    const bytes = journals(IMPORT_CHUNK + 1);
    const first = rt.dispatch('data.import.preview', { kind: 'vouchers_ledger', fileName: 'v.csv', bytes });
    const second = await rt.dispatch('data.import.commit', { kind: 'vouchers_ledger', fileName: 'v.csv', bytes, options: { skipInvalid: false, updateExisting: false } });
    assert.equal(second.ok ? 'ok' : second.error.code, 'CONFLICT');
    const p = await first;
    assert.ok(p.ok);
    assert.equal((p.data as ImportPreviewResult).summary.willCreate, IMPORT_CHUNK + 1);
    assert.equal(count('SELECT COUNT(*) FROM vouchers'), 0);
  });
});
