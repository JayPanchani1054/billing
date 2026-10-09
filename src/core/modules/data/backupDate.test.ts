/**
 * Backup verification describes the backup with the LOCAL (IST) day it was made (regression: the
 * manifest's UTC `createdAt` was sliced, so a backup at 01:00 IST read as made the previous day).
 * Own file: it pins the process time zone to India (node --test runs each file in its own process).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.TZ = 'Asia/Kolkata';
const { createTestCompany } = await import('../../testing/fixtures.ts');
const { createBackup, verifyBackup } = await import('./backup.ts');

test('the container check says the IST day the backup was made', async () => {
  const t = createTestCompany({ today: '2026-10-05', name: 'Shree Ganesh Traders' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-bkdate-'));
  try {
    // Fixed clock 04:30Z on 5-Oct; +15 h = 19:30Z on 5-Oct = 01:00 IST on 6-Oct.
    t.clock.advance(15 * 3_600_000);
    const r = await createBackup(t.ctx, { folder: dir });
    assert.equal(r.createdAt, '2026-10-05T19:30:00.000Z');
    const v = await verifyBackup(t.ctx, r.path, undefined);
    const container = v.checks.find((c) => c.name === 'container');
    assert.match(container?.message ?? '', /made on 06-Oct-2026/);
  } finally {
    t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
