import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Test-only runtime import from core: the input the dialog sends passes the route's schema with unknown keys refused.
import { parse } from '../../../../core/lib/validate.ts';
import { bankingRoutes } from '../../../../core/modules/banking/routes.ts';
import { batchLabel, deleteBatchPlan, deleteBatchResultText, linkedLines } from './batches.ts';
import type { BatchLike } from './batches.ts';

const batch = (counts: Partial<BatchLike['counts']> = {}): BatchLike => ({
  id: 9,
  fileName: 'HDFC Apr.csv',
  ledgerName: 'HDFC Bank',
  from: '2026-04-01',
  to: '2026-04-30',
  lineCount: 42,
  counts: { unmatched: 42, matched: 0, created: 0, ignored: 0, ...counts },
});

describe('deleting an imported bank statement', () => {
  it('labels the import with its file, dates and line count', () => {
    assert.match(batchLabel(batch()), /^HDFC Apr\.csv · .+ – .+ · 42 lines$/);
    assert.match(batchLabel({ ...batch(), fileName: null, lineCount: 1 }), /^Statement · .* · 1 line$/);
  });

  it('a statement with nothing reconciled is deleted as is', () => {
    const p = deleteBatchPlan(batch(), false);
    assert.equal(p.linked, 0);
    assert.equal(p.canDelete, true);
    assert.deepEqual(p.input, { batchId: 9 });
    assert.match(p.message, /42 statement lines imported into HDFC Bank will be removed/);
    assert.match(p.title, /“HDFC Apr\.csv”/);
  });

  it('reconciled lines (matched or created) block the delete until "also unmatch" is ticked', () => {
    const b = batch({ unmatched: 30, matched: 10, created: 2 });
    assert.equal(linkedLines(b), 12);
    const blocked = deleteBatchPlan(b, false);
    assert.equal(blocked.canDelete, false);
    assert.match(blocked.message, /12 lines are reconciled with vouchers\. Tick "Also unmatch"/);
    const ok = deleteBatchPlan(b, true);
    assert.equal(ok.canDelete, true);
    assert.deepEqual(ok.input, { batchId: 9, unmatch: true });
    assert.match(ok.message, /lose their bank date/);
  });

  it('sends only what banking.statement.deleteBatch declares', () => {
    const schema = bankingRoutes['banking.statement.deleteBatch'].input;
    for (const unmatch of [false, true]) {
      const input = deleteBatchPlan(batch({ matched: 1 }), unmatch).input;
      assert.deepEqual(parse(schema, input, { unknownKeys: 'reject' }), input);
    }
  });

  it('reports what was removed', () => {
    assert.equal(deleteBatchResultText({ batchId: 9, deletedLines: 42, unmatched: 0 }), 'Imported statement deleted — 42 lines removed');
    assert.equal(deleteBatchResultText({ batchId: 9, deletedLines: 1, unmatched: 1 }), 'Imported statement deleted — 1 line removed, 1 voucher unmatched');
  });
});
