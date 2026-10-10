/**
 * Security review (final wave) of sharing: the shared-documents folder is never reached through a
 * link / junction, and the draft e-mail's To: header stays well-formed for many recipients.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildDraftEml, ensureSharedExportsDir, freeFileName, SharedFolderError } from './share.ts';

function tempDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-share-'));
  fs.mkdirSync(path.join(root, 'companies', 'acme'), { recursive: true });
  return root;
}

describe('ensureSharedExportsDir', () => {
  it('creates exports/shared inside the company folder', async () => {
    const data = tempDataDir();
    try {
      const dir = await ensureSharedExportsDir(data, 'acme');
      assert.equal(dir, path.join(data, 'companies', 'acme', 'exports', 'shared'));
      assert.ok(fs.statSync(dir as string).isDirectory());
      assert.equal(await ensureSharedExportsDir(data, 'acme'), dir); // idempotent
      assert.equal(await ensureSharedExportsDir(data, '../acme'), null);
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  it('refuses an exports or shared folder that is a link (or a file) and writes nothing through it', { skip: process.platform === 'win32' }, async () => {
    const data = tempDataDir();
    try {
      const elsewhere = path.join(data, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(data, 'companies', 'acme', 'exports'), 'dir');
      await assert.rejects(ensureSharedExportsDir(data, 'acme'), SharedFolderError);
      assert.deepEqual(fs.readdirSync(elsewhere), []);

      fs.unlinkSync(path.join(data, 'companies', 'acme', 'exports'));
      fs.mkdirSync(path.join(data, 'companies', 'acme', 'exports'));
      fs.symlinkSync(elsewhere, path.join(data, 'companies', 'acme', 'exports', 'shared'), 'dir');
      await assert.rejects(ensureSharedExportsDir(data, 'acme'), SharedFolderError);

      fs.unlinkSync(path.join(data, 'companies', 'acme', 'exports', 'shared'));
      fs.writeFileSync(path.join(data, 'companies', 'acme', 'exports', 'shared'), 'not a folder');
      await assert.rejects(ensureSharedExportsDir(data, 'acme'), SharedFolderError);
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('draft e-mail headers', () => {
  it('folds a long recipient list one address per line (no header line over 998 characters)', () => {
    const to = Array.from({ length: 20 }, (_, i) => `${'a'.repeat(60)}${i}@${'b'.repeat(60)}.example.com`);
    const eml = buildDraftEml({
      to,
      subject: 'Invoice',
      body: 'Please find attached.',
      attachment: { fileName: 'Invoice.pdf', contentType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) },
      date: new Date(2026, 9, 10, 10, 0, 0),
      boundary: 'b',
    });
    const head = eml.split('\r\n\r\n')[0];
    for (const line of head.split('\r\n')) assert.ok(line.length <= 998, `${line.length}`);
    // Unfolded, the header is the plain comma-separated list.
    const unfolded = head.replace(/\r\n /g, ' ');
    assert.ok(unfolded.includes(`To: ${to.join(', ')}`));
  });
});

describe('freeFileName (shared PDF / draft names)', () => {
  it('never names a shared file after a Windows device, whatever the window sent', async () => {
    const data = tempDataDir();
    try {
      for (const wanted of ['CON .pdf', 'nul', 'Aux .x', 'COM¹']) {
        const name = await freeFileName(data, wanted, '.pdf');
        assert.equal(name, 'document.pdf', wanted);
      }
      assert.equal(await freeFileName(data, 'Tax Invoice 12 - Acme', '.pdf'), 'Tax Invoice 12 - Acme.pdf');
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});
