/**
 * Import and reconciliation stamps are shown as the LOCAL (IST) day (regression: the UTC timestamp
 * was sliced, so an import at 01:00 IST read as the previous day in the "already imported on" message
 * and the export's "Reconciled on" title). Own file: it pins the process time zone to India
 * (node --test runs each file in its own process).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.TZ = 'Asia/Kolkata';
const { readXlsx } = await import('../../lib/xlsx.ts');
const { enc, gstr2bJson, importFile, routes, S1, setupRecon } = await import('./testkit.ts');

test('"already imported on" and "Reconciled on" use the IST day of the stamp', async () => {
  const k = setupRecon({ today: '2026-05-20' });
  // Fixed clock 04:30Z on 20-May; +15 h = 19:30Z on 20-May = 01:00 IST on 21-May.
  k.t.clock.advance(15 * 3_600_000);
  assert.equal(k.t.clock.now().toISOString(), '2026-05-20T19:30:00.000Z');
  const file = gstr2bJson({ gstin: k.gstin, rtnprd: '042026', b2b: [{ ctin: S1, trdnm: 'SUPREME SUPPLIERS', inv: [{ inum: 'INV-1', dt: '05-04-2026', items: [[18, 1000, 0, 90, 90]] }] }] });
  await importFile(k, 'gstr2b', enc(file), { fileName: 'april.json' });

  const again = await k.t.call(routes, 'gstrecon.import', { source: 'gstr2b', fileName: 'april-2.json', bytes: enc(file) });
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.equal(again.error.code, 'CONFLICT');
    assert.match(again.error.message, /already imported on 21-May-2026 /);
  }

  await k.t.callOk(routes, 'gstrecon.run', { period: '042026', source: 'gstr2b' });
  const out = await k.t.callOk<{ bytes: Uint8Array }>(routes, 'gstrecon.export', { period: '042026', source: 'gstr2b', format: 'xlsx' });
  const cells = readXlsx(out.bytes).sheets.flatMap((s) => s.rows.flat()).filter((c): c is string => typeof c === 'string');
  const stamp = cells.find((c) => c.startsWith('Reconciled on '));
  assert.ok(stamp, 'the export title carries the reconciliation date');
  assert.match(stamp, /^Reconciled on 21-May-2026;/);
  k.t.close();
});
