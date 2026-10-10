import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AppError } from '../core/lib/errors.ts';
import { checkOpenCopy, OPEN_COPY_FOLDER, writeOpenCopy } from './attachments.ts';

describe('attachment.openCopy (main)', () => {
  it('accepts allowed kinds only and drops folders from the name', () => {
    const ok = checkOpenCopy({ fileName: '..\\..\\bill.pdf', bytes: new Uint8Array([1]) });
    assert.equal(ok.fileName, 'bill.pdf');
    for (const fileName of ['run.exe', 'x.bat', 'page.html', 'noext']) {
      assert.throws(() => checkOpenCopy({ fileName, bytes: new Uint8Array([1]) }), (e: unknown) => e instanceof AppError && e.code === 'FORBIDDEN');
    }
    assert.throws(() => checkOpenCopy({ fileName: 'a.pdf', bytes: 'not bytes' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
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
});
