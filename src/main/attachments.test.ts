import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AppError } from '../core/lib/errors.ts';
import { checkOpenCopy, OPEN_COPY_FOLDER, writeOpenCopy } from './attachments.ts';

const PDF = new Uint8Array([...Buffer.from('%PDF-1.7\n')]);
const forbidden = (e: unknown): boolean => e instanceof AppError && e.code === 'FORBIDDEN';

describe('attachment.openCopy (main)', () => {
  it('accepts allowed kinds only and drops folders from the name', () => {
    const ok = checkOpenCopy({ fileName: '..\\..\\bill.pdf', bytes: PDF });
    assert.equal(ok.fileName, 'bill.pdf');
    for (const fileName of ['run.exe', 'x.bat', 'page.html', 'noext']) {
      assert.throws(() => checkOpenCopy({ fileName, bytes: new Uint8Array([1]) }), forbidden);
    }
    assert.throws(() => checkOpenCopy({ fileName: 'a.pdf', bytes: 'not bytes' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
  });

  it('re-checks the content: a renamed program or a web page sent as XML / text is never opened (renderer untrusted)', () => {
    assert.throws(() => checkOpenCopy({ fileName: 'bill.pdf', bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]) }), forbidden);
    assert.throws(() => checkOpenCopy({ fileName: 'bill.pdf', bytes: new Uint8Array([1, 2, 3]) }), forbidden);
    const page = new TextEncoder().encode('<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="x.xsl"?><a/>');
    assert.throws(() => checkOpenCopy({ fileName: 'einvoice.xml', bytes: page }), forbidden);
    assert.throws(() => checkOpenCopy({ fileName: 'notes.txt', bytes: new Uint8Array([0x23, 0x21, 0x2f]) }), forbidden); // '#!/'
    assert.equal(checkOpenCopy({ fileName: 'einvoice.json', bytes: new TextEncoder().encode('{"Irn":"x"}') }).fileName, 'einvoice.json');
  });

  it('never names the copy after a Windows device', () => {
    assert.equal(checkOpenCopy({ fileName: 'CON.pdf', bytes: PDF }).fileName, '_CON.pdf');
    assert.equal(checkOpenCopy({ fileName: 'nul .pdf', bytes: PDF }).fileName, '_nul .pdf');
    assert.equal(checkOpenCopy({ fileName: 'com1.tar.pdf', bytes: PDF }).fileName, '_com1.tar.pdf');
    assert.equal(checkOpenCopy({ fileName: 'console.pdf', bytes: PDF }).fileName, 'console.pdf');
  });

  it('writes a fresh copy under the temp folder and sweeps day-old copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-open-'));
    try {
      const old = path.join(root, OPEN_COPY_FOLDER, 'old');
      fs.mkdirSync(old, { recursive: true });
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      fs.utimesSync(old, past, past);
      const file = writeOpenCopy(root, 'bill.pdf', new Uint8Array([37, 80, 68, 70]));
      assert.equal(path.basename(file), 'bill.pdf');
      assert.ok(file.startsWith(path.join(root, OPEN_COPY_FOLDER)));
      assert.deepEqual([...fs.readFileSync(file)], [37, 80, 68, 70]);
      assert.equal(fs.existsSync(old), false);
      // Two opens of the same name never overwrite each other.
      assert.notEqual(writeOpenCopy(root, 'bill.pdf', new Uint8Array([1])), file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a copies folder that is a link planted by someone else, and the sweep never follows a link', { skip: process.platform === 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-open-'));
    try {
      // Another account's folder the link points at: day-old files there must survive.
      const victim = path.join(root, 'victim');
      fs.mkdirSync(victim);
      const precious = path.join(victim, 'books.db');
      fs.writeFileSync(precious, 'x');
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      fs.utimesSync(precious, past, past);
      fs.symlinkSync(victim, path.join(root, OPEN_COPY_FOLDER), 'dir');
      assert.throws(() => writeOpenCopy(root, 'bill.pdf', PDF), forbidden);
      assert.equal(fs.existsSync(precious), true);
      assert.deepEqual(fs.readdirSync(victim), ['books.db']);

      // Inside our own folder, a day-old link is removed as a link (its target untouched).
      const root2 = path.join(root, 'r2');
      fs.mkdirSync(root2);
      fs.mkdirSync(path.join(root2, OPEN_COPY_FOLDER), { mode: 0o700 });
      const link = path.join(root2, OPEN_COPY_FOLDER, 'stale');
      fs.symlinkSync(victim, link, 'dir');
      fs.lutimesSync(link, past, past);
      writeOpenCopy(root2, 'bill.pdf', PDF);
      assert.equal(fs.existsSync(link), false);
      assert.equal(fs.existsSync(precious), true);

      // A group / world-writable copies folder is not private.
      const root3 = path.join(root, 'r3');
      fs.mkdirSync(path.join(root3, OPEN_COPY_FOLDER), { recursive: true });
      fs.chmodSync(path.join(root3, OPEN_COPY_FOLDER), 0o777);
      assert.throws(() => writeOpenCopy(root3, 'bill.pdf', PDF), forbidden);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
