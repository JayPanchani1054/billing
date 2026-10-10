import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { exists, isInside, isPidAlive, probeWritable, readJsonFile, samePath, sizeOf, slugify, writeFileAtomic, writeJsonAtomic } from './fsutil.ts';

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-fsutil-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('fsutil', () => {
  it('writes atomically, replacing existing content and leaving no temp files', () => {
    const f = path.join(dir, 'nested', 'a.json');
    writeJsonAtomic(f, { a: 1 });
    writeFileAtomic(f, '{"a":2}');
    assert.deepEqual(readJsonFile(f), { status: 'ok', value: { a: 2 } });
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['a.json']);
  });

  it('distinguishes missing from corrupt JSON and tolerates a BOM', () => {
    assert.deepEqual(readJsonFile(path.join(dir, 'none.json')), { status: 'missing' });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    assert.equal(readJsonFile(bad).status, 'corrupt');
    const bom = path.join(dir, 'bom.json');
    fs.writeFileSync(bom, '﻿{"x":1}');
    assert.deepEqual(readJsonFile(bom), { status: 'ok', value: { x: 1 } });
    const folder = path.join(dir, 'folder.json');
    fs.mkdirSync(folder);
    assert.equal(readJsonFile(folder).status, 'unreadable', 'I/O errors are not "corrupt"');
  });

  it('probes writability and creates the folder', () => {
    const target = path.join(dir, 'probe', 'deep');
    assert.equal(probeWritable(target), null);
    assert.ok(exists(target));
    assert.deepEqual(fs.readdirSync(target), [], 'probe file removed');
    const file = path.join(dir, 'plain-file');
    fs.writeFileSync(file, 'x');
    assert.notEqual(probeWritable(path.join(file, 'sub')), null, 'a file is not a folder');
  });

  it('computes folder sizes recursively', () => {
    const d = path.join(dir, 'sized');
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a'), 'abc');
    fs.writeFileSync(path.join(d, 'sub', 'b'), 'defgh');
    assert.equal(sizeOf(d), 8);
    assert.equal(sizeOf(path.join(dir, 'missing')), 0);
  });

  it('compares paths', () => {
    assert.ok(isInside(path.join(dir, 'a', 'b'), dir));
    assert.ok(!isInside(dir, dir));
    assert.ok(!isInside(path.join(dir, '..', 'other'), dir));
    assert.ok(!isInside(`${dir}-sibling`, dir));
    assert.ok(samePath(path.join(dir, 'x', '..'), dir));
  });

  it('slugifies names into safe folder ids', () => {
    assert.equal(slugify('Sharma & Sons Pvt. Ltd.'), 'sharma-sons-pvt-ltd');
    assert.equal(slugify('Café Ølé'), 'cafe-le');
    assert.equal(slugify('शर्मा ट्रेडर्स'), 'company');
    assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
    assert.ok(slugify('x'.repeat(100)).length <= 40);
  });

  it('detects live processes', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(2 ** 22 + 12345), false);
  });
});
