import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ANCHOR_KEY_FILE, FileAuditAnchorStore, loadOrCreateAnchorKey } from '../core/app/auditAnchors.ts';
import { loadAnchorKeyForWorker, safeStorageSealer, type SafeStorageLike } from './anchor-key.ts';

/** Stand-in for Electron safeStorage: "encrypts" by XOR with a per-account secret (reversible only with it). */
function fakeSafeStorage(account: number, backend = 'gnome_libsecret', available = true): SafeStorageLike {
  const x = (b: Buffer): Buffer => Buffer.from(b.map((c) => c ^ (account & 0xff)));
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plain) => Buffer.concat([Buffer.from('SEALED:'), x(Buffer.from(plain, 'utf8'))]),
    decryptString: (enc) => {
      if (!enc.subarray(0, 7).equals(Buffer.from('SEALED:'))) throw new Error('not sealed');
      return x(enc.subarray(7)).toString('utf8');
    },
  };
}

const quiet = (): void => undefined;
const head = { companyId: 'c1', companyGuid: 'g', lastId: 7, lastHash: 'a'.repeat(64), at: '2026-10-09T00:00:00.000Z' };

describe('edit-log anchor key sealed by main (safeStorage) and handed to the core worker', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-anchorkey-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the key sealed on disk; the same account gets the same key back; the raw key is never written', () => {
    const k1 = loadAnchorKeyForWorker(dir, fakeSafeStorage(0x5a), quiet);
    assert.ok(k1 && k1.length === 32);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, ANCHOR_KEY_FILE), 'utf8')) as { sealed: boolean; key: string };
    assert.equal(stored.sealed, true);
    assert.ok(!stored.key.includes(Buffer.from(k1).toString('hex')), 'the key file does not contain the key in clear');
    const k2 = loadAnchorKeyForWorker(dir, fakeSafeStorage(0x5a), quiet);
    assert.deepEqual(k2, k1);
  });

  it('the worker-side store signs with the key main passed (same MAC as a store that loaded it itself)', () => {
    const key = loadAnchorKeyForWorker(dir, fakeSafeStorage(0x11), quiet) as Uint8Array;
    const worker = new FileAuditAnchorStore({ dir, log: quiet, key });
    const sealer = safeStorageSealer(fakeSafeStorage(0x11));
    const direct = new FileAuditAnchorStore({ dir, log: quiet, sealer });
    assert.equal(worker.sign(head), direct.sign(head));
  });

  it('a key file copied to another account cannot be unsealed: a new key is made and old anchors no longer verify', () => {
    const mine = new FileAuditAnchorStore({ dir, log: quiet, key: loadAnchorKeyForWorker(dir, fakeSafeStorage(0x21), quiet) });
    const mac = mine.sign(head);
    const other = new FileAuditAnchorStore({ dir, log: quiet, key: loadAnchorKeyForWorker(dir, fakeSafeStorage(0x42), quiet) });
    assert.equal(other.verify({ ...head, mac }), false);
  });

  it('a key stored unsealed (before OS protection) is kept and re-sealed', () => {
    const plain = loadOrCreateAnchorKey({ dir, log: quiet });
    assert.equal((JSON.parse(fs.readFileSync(path.join(dir, ANCHOR_KEY_FILE), 'utf8')) as { sealed: boolean }).sealed, false);
    const sealed = loadAnchorKeyForWorker(dir, fakeSafeStorage(0x33), quiet);
    assert.deepEqual(Buffer.from(sealed as Uint8Array), plain);
    assert.equal((JSON.parse(fs.readFileSync(path.join(dir, ANCHOR_KEY_FILE), 'utf8')) as { sealed: boolean }).sealed, true);
  });

  it('a sealed key read without the OS sealer (headless core) is never replaced', () => {
    const key = loadAnchorKeyForWorker(dir, fakeSafeStorage(0x44), quiet);
    const before = fs.readFileSync(path.join(dir, ANCHOR_KEY_FILE), 'utf8');
    const headless = loadOrCreateAnchorKey({ dir, log: quiet });
    assert.notDeepEqual(headless, Buffer.from(key as Uint8Array), 'a throw-away key for that run');
    assert.equal(fs.readFileSync(path.join(dir, ANCHOR_KEY_FILE), 'utf8'), before, 'the sealed key file is untouched');
    assert.deepEqual(loadAnchorKeyForWorker(dir, fakeSafeStorage(0x44), quiet), key);
  });

  it('no real OS protection (unavailable, or Linux basic_text): stored unsealed, still loads', () => {
    assert.equal(safeStorageSealer(fakeSafeStorage(1, 'basic_text'), 'linux'), undefined);
    assert.equal(safeStorageSealer(fakeSafeStorage(1, 'unknown', false), 'win32'), undefined);
    assert.ok(safeStorageSealer(fakeSafeStorage(1, 'unknown'), 'win32'));
    const key = loadAnchorKeyForWorker(dir, fakeSafeStorage(1, 'basic_text'), quiet);
    assert.ok(key && key.length === 32);
    assert.equal((JSON.parse(fs.readFileSync(path.join(dir, ANCHOR_KEY_FILE), 'utf8')) as { sealed: boolean }).sealed, false);
  });
});
