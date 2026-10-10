/**
 * Final wave: "remove unreferenced stored files" — 'attachments.unused' / 'attachments.sweep'
 * (attachments.remove; edit log). A file still referenced is never removed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AttachmentRow, AttachmentSweepResult, AttachmentUnusedResult } from '../../../shared/types/attachments.ts';
import { salesInput, save, setupKit } from '../vouchers/testkit.ts';
import { attachmentsRoutes } from './routes.ts';
import { attachmentsDir, sha256Hex } from './store.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const USED = enc('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const STRAY = enc('%PDF-1.4\n% left behind by an attach that did not finish\n%%EOF\n');

describe('attachments: remove unused stored files', () => {
  it('lists and removes only files no attachment refers to; needs attachments.remove; recorded in the edit log', async () => {
    const k = setupKit();
    const voucherId = save(k, salesInput(k)).id;
    const kept = await k.t.callOk<AttachmentRow>(attachmentsRoutes, 'attachments.add', { entityType: 'voucher', entityId: voucherId, fileName: 'bill.pdf', bytes: USED });
    const dir = attachmentsDir(k.t.ctx.company.dir);
    const strayName = `${sha256Hex(STRAY)}.pdf`;
    fs.writeFileSync(path.join(dir, strayName), STRAY);

    const unused = await k.t.callOk<AttachmentUnusedResult>(attachmentsRoutes, 'attachments.unused', {});
    assert.deepEqual(unused.files, [{ name: strayName, bytes: STRAY.byteLength }]);
    assert.equal(unused.totalBytes, STRAY.byteLength);

    // Without attachments.remove: refused, nothing deleted.
    const denied = await k.t.call(attachmentsRoutes, 'attachments.sweep', {}, { session: k.t.sessionAs({ permissions: ['vouchers.view', 'attachments.add'] }) });
    assert.equal(denied.ok, false);
    assert.ok(fs.existsSync(path.join(dir, strayName)));

    const r = await k.t.callOk<AttachmentSweepResult>(attachmentsRoutes, 'attachments.sweep', {});
    assert.deepEqual(r, { removed: 1, bytes: STRAY.byteLength });
    assert.equal(fs.existsSync(path.join(dir, strayName)), false, 'the stray file is gone');
    assert.ok(fs.existsSync(path.join(dir, `${kept.sha256}.pdf`)), 'the attached file stays');
    const log = k.t.db.get<{ action: string; entity_label: string }>(`SELECT action, entity_label FROM audit_log WHERE entity_type = 'attachment_files' ORDER BY id DESC LIMIT 1`);
    assert.equal(log?.action, 'delete');
    assert.match(log?.entity_label ?? '', /Unused attachment files removed: 1/);
    // Nothing left: a second sweep removes nothing and writes no entry.
    const again = await k.t.callOk<AttachmentSweepResult>(attachmentsRoutes, 'attachments.sweep', {});
    assert.deepEqual(again, { removed: 0, bytes: 0 });
    assert.equal(k.t.db.value(`SELECT COUNT(*) FROM audit_log WHERE entity_type = 'attachment_files'`), 1);
    k.t.close();
  });
});
