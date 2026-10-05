import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isPathInside, PathSet, readJsonFile, sanitizeFileName, writeFileAtomic, writeFileAtomicSync } from './files.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-main-files-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeFileAtomic', () => {
  it('writes bytes and text, replacing existing files, leaving no temp files', async () => {
    const target = path.join(dir, 'out.csv');
    await writeFileAtomic(target, 'a,b\n1,2\n');
    assert.equal(fs.readFileSync(target, 'utf8'), 'a,b\n1,2\n');
    await writeFileAtomic(target, new Uint8Array([1, 2, 3]));
    assert.deepEqual([...fs.readFileSync(target)], [1, 2, 3]);
    assert.deepEqual(fs.readdirSync(dir), ['out.csv']);
  });

  it('cleans up and rethrows when the folder does not exist', async () => {
    await assert.rejects(writeFileAtomic(path.join(dir, 'missing', 'x.txt'), 'x'), { code: 'ENOENT' });
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('sync variant creates the folder and round-trips JSON', () => {
    const file = path.join(dir, 'nested', 'state.json');
    writeFileAtomicSync(file, JSON.stringify({ width: 1360 }));
    assert.deepEqual(readJsonFile(file), { width: 1360 });
    assert.equal(readJsonFile(path.join(dir, 'nope.json')), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(readJsonFile(path.join(dir, 'bad.json')), null);
  });
});

describe('sanitizeFileName', () => {
  it('keeps ordinary names', () => {
    assert.equal(sanitizeFileName('Sales Register 2026-27.xlsx'), 'Sales Register 2026-27.xlsx');
    assert.equal(sanitizeFileName('Invoice SI_001.pdf'), 'Invoice SI_001.pdf');
  });

  it('strips directories, forbidden characters and trailing dots', () => {
    assert.equal(sanitizeFileName('..\\..\\Windows\\evil.exe'), '.. .. Windows evil.exe');
    assert.equal(sanitizeFileName('a/b:c*d?e"f<g>h|i.txt'), 'a b c d e f g h i.txt');
    assert.equal(sanitizeFileName('report.  '), 'report');
  });

  it('falls back for empty and reserved device names', () => {
    assert.equal(sanitizeFileName(''), 'export');
    assert.equal(sanitizeFileName('..'), 'export');
    assert.equal(sanitizeFileName('CON'), 'export');
    assert.equal(sanitizeFileName('nul.txt', 'file'), 'file');
  });

  it('bounds the length but keeps the extension', () => {
    const name = sanitizeFileName(`${'x'.repeat(400)}.pdf`);
    assert.ok(name.length <= 180);
    assert.ok(name.endsWith('.pdf'));
  });
});

describe('isPathInside / PathSet', () => {
  it('detects containment without prefix tricks', () => {
    const root = path.join(dir, 'Data');
    assert.equal(isPathInside(root, root), true);
    assert.equal(isPathInside(root, path.join(root, 'companies', 'a', 'company.db')), true);
    assert.equal(isPathInside(root, path.join(dir, 'Data2', 'x')), false);
    assert.equal(isPathInside(root, path.join(root, '..', 'secret.txt')), false);
    assert.equal(isPathInside(root, dir), false);
  });

  it('remembers chosen paths and folders', () => {
    const set = new PathSet();
    const folder = path.join(dir, 'Backups');
    const file = path.join(dir, 'export.csv');
    set.add(folder);
    set.add(file);
    assert.equal(set.has(file), true);
    assert.equal(set.covers(path.join(folder, 'b.bahibak')), true);
    assert.equal(set.covers(path.join(dir, 'other.csv')), false);
    assert.equal(set.covers(path.join(file, '..', 'other.csv')), false);
  });
});
