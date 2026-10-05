import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decryptBytes,
  dummyPasswordHash,
  encryptBytes,
  hashPassword,
  hashPasswordSync,
  isEncrypted,
  needsRehash,
  passwordPolicy,
  randomBase36,
  randomToken,
  sha256Hex,
  verifyPassword,
  verifyPasswordSync,
} from './crypto.ts';
import { AppError } from './errors.ts';

describe('password hashing', () => {
  it('produces scrypt$N$r$p$salt$hash with fresh salts', async () => {
    const h1 = await hashPassword('Secret123');
    const h2 = await hashPassword('Secret123');
    const parts = h1.split('$');
    assert.equal(parts.length, 6);
    assert.deepEqual(parts.slice(0, 4), ['scrypt', '32768', '8', '1']);
    assert.equal(Buffer.from(parts[4], 'base64').length, 16, '16-byte salt');
    assert.equal(Buffer.from(parts[5], 'base64').length, 64, '64-byte key');
    assert.notEqual(h1, h2, 'salted');
    assert.equal(needsRehash(h1), false);
  });

  it('verifies correct passwords and rejects wrong ones (async and sync interoperate)', async () => {
    const h = await hashPassword('Secret123');
    assert.equal(await verifyPassword('Secret123', h), true);
    assert.equal(await verifyPassword('secret123', h), false);
    assert.equal(verifyPasswordSync('Secret123', h), true);
    const hs = hashPasswordSync('Pässwörd9');
    assert.equal(await verifyPassword('Pässwörd9', hs), true);
    // NFKC normalisation: composed and decomposed forms are the same password.
    assert.equal(await verifyPassword('Pässwörd9', hs), true);
  });

  it('returns false for malformed or hostile hashes without throwing', async () => {
    for (const bad of ['', 'plain', 'scrypt$1$8$1$a$b', 'bcrypt$x', 'scrypt$33554432$8$1$AAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAA==', 'scrypt$1000$8$1$AAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAA==']) {
      assert.equal(await verifyPassword('x', bad), false, bad);
      assert.equal(verifyPasswordSync('x', bad), false, bad);
      assert.equal(needsRehash(bad), true);
    }
    assert.equal(await verifyPassword('anything', dummyPasswordHash()), false);
  });

  it('refuses hashes demanding excessive scrypt work (regression: up to 4 GiB was accepted)', async () => {
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
    const key = 'A'.repeat(86) + '==';
    for (const params of ['262144$8$1', '1048576$8$1', '32768$32$1', '32768$8$16']) {
      const hostile = `scrypt$${params}$${salt}$${key}`;
      const started = Date.now();
      assert.equal(await verifyPassword('x', hostile), false, params);
      assert.equal(verifyPasswordSync('x', hostile), false, params);
      assert.ok(Date.now() - started < 2000, `${params} rejected without running scrypt`);
    }
  });
});

describe('passwordPolicy', () => {
  it('requires 8+ chars with a letter and a digit', () => {
    assert.match(passwordPolicy('Ab1') ?? '', /at least 8/);
    assert.match(passwordPolicy('abcdefgh') ?? '', /digit/);
    assert.match(passwordPolicy('12345678') ?? '', /letter/);
    assert.match(passwordPolicy(' abcdef12') ?? '', /space/);
    assert.match(passwordPolicy('a1'.repeat(200)) ?? '', /at most/);
    assert.equal(passwordPolicy('abcdefg1'), null);
    assert.equal(passwordPolicy('पासवर्ड123'), null, 'non-Latin letters count as letters');
  });
});

describe('random helpers and digests', () => {
  it('randomBase36 / randomToken have the right shape', () => {
    const s = randomBase36(6);
    assert.match(s, /^[0-9a-z]{6}$/);
    assert.notEqual(randomBase36(12), randomBase36(12));
    assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  });

  it('sha256Hex matches a known vector', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(new Uint8Array([0x61, 0x62, 0x63])), sha256Hex('abc'));
  });
});

describe('AES-256-GCM envelope', () => {
  const data = new TextEncoder().encode('Bahi backup payload ₹ 1,23,456.00');

  it('round-trips with the right password', () => {
    const enc = encryptBytes(data, 'Backup#2026');
    assert.ok(isEncrypted(enc));
    assert.equal(Buffer.from(enc.subarray(0, 8)).toString('ascii'), 'BAHIENC1');
    assert.equal(enc.length, 8 + 16 + 12 + 16 + data.length);
    assert.deepEqual(decryptBytes(enc, 'Backup#2026'), data);
    assert.notDeepEqual(encryptBytes(data, 'Backup#2026'), enc, 'fresh salt/iv each time');
  });

  it('round-trips empty data', () => {
    assert.equal(decryptBytes(encryptBytes(new Uint8Array(0), 'pw'), 'pw').length, 0);
  });

  it('rejects a wrong password, tampering and non-envelopes with a user-facing error', () => {
    const enc = encryptBytes(data, 'right');
    const isWrong = (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && e.message === 'Wrong password or corrupted file';
    assert.throws(() => decryptBytes(enc, 'wrong'), isWrong);
    for (const pos of [10, 30, 40, enc.length - 1]) {
      const t = new Uint8Array(enc);
      t[pos] ^= 0x01; // header (salt/iv) is authenticated too
      assert.throws(() => decryptBytes(t, 'right'), isWrong, `byte ${pos}`);
    }
    assert.throws(() => decryptBytes(enc.subarray(0, 20), 'right'), isWrong);
    assert.throws(() => decryptBytes(data, 'right'), isWrong);
    assert.equal(isEncrypted(data), false);
  });

  it('requires a password to encrypt', () => {
    assert.throws(() => encryptBytes(data, ''), AppError);
  });
});
