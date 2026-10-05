/**
 * Cryptographic helpers (node:crypto only).
 *
 *  - Password hashing: scrypt (N=2^15, r=8, p=1), 16-byte salt, 64-byte key, stored as
 *    'scrypt$N$r$p$saltB64$hashB64'. Verification is constant-time and reads the parameters
 *    from the stored hash, so the cost can be raised later without breaking old hashes
 *    (see needsRehash).
 *    Async variants are preferred (they run on the libuv pool and keep Electron's main thread
 *    responsive); the *Sync variants exist for code that must run inside a synchronous
 *    DB transaction (e.g. a transactional company route creating a user).
 *  - File encryption: AES-256-GCM with a scrypt-derived key. Envelope layout:
 *      'BAHIENC1' (8) | salt (16) | iv (12) | tag (16) | ciphertext
 *    The 36-byte header (magic + salt + iv) is authenticated as AAD.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { AppError } from './errors.ts';

// ───────────────────────────── Passwords ─────────────────────────────

export const SCRYPT_N = 2 ** 15;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/**
 * Upper bounds accepted when verifying a stored hash. A restored or imported company file can carry
 * any hash string, so these cap the work a crafted hash can force: scrypt needs ≈128·N·r bytes
 * (≤ 256 MiB here) and time ∝ N·r·p. Raise them together with SCRYPT_* if the defaults ever grow.
 */
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

/** scrypt needs 128·N·r bytes; give it 2× head-room over Node's 32 MiB default. */
const maxmemFor = (n: number, r: number, p: number): number => 256 * n * r * Math.max(1, p);

function scryptOptions(n: number, r: number, p: number): ScryptOptions {
  return { N: n, r, p, maxmem: maxmemFor(n, r, p) };
}

function scryptAsync(password: string | Uint8Array, salt: Uint8Array, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function encodeHash(n: number, r: number, p: number, salt: Uint8Array, key: Uint8Array): string {
  return `scrypt$${n}$${r}$${p}$${Buffer.from(salt).toString('base64')}$${Buffer.from(key).toString('base64')}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isSafeInteger(x) && x > 0)) return null;
  // N must be a power of two > 1.
  if (n < 2 || (n & (n - 1)) !== 0 || n > MAX_N || r > MAX_R || p > MAX_P) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || key.length < 16) return null;
  return { n, r, p, salt, key };
}

/** Hash a password for storage (async; preferred). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_BYTES, scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P));
  return encodeHash(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, key);
}

/** Synchronous variant for use inside synchronous DB transactions. Blocks ~50–150 ms. */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password.normalize('NFKC'), salt, KEY_BYTES, scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P));
  return encodeHash(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, key);
}

/** Constant-time verification. Returns false (never throws) for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const key = await scryptAsync(password.normalize('NFKC'), parsed.salt, parsed.key.length, scryptOptions(parsed.n, parsed.r, parsed.p));
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

export function verifyPasswordSync(password: string, stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const key = scryptSync(password.normalize('NFKC'), parsed.salt, parsed.key.length, scryptOptions(parsed.n, parsed.r, parsed.p));
    return timingSafeEqual(key, parsed.key);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than the current defaults (re-hash on next login). */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  return !parsed || parsed.n < SCRYPT_N || parsed.r < SCRYPT_R || parsed.key.length < KEY_BYTES;
}

/**
 * A syntactically valid hash of a random secret. Used to spend the same scrypt time when a username
 * does not exist, so response timing does not reveal which usernames are valid.
 */
let dummyHash: string | null = null;
export function dummyPasswordHash(): string {
  if (!dummyHash) {
    const salt = randomBytes(SALT_BYTES);
    dummyHash = encodeHash(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, randomBytes(KEY_BYTES));
  }
  return dummyHash;
}

/** Password policy: returns a user-facing error message, or null when acceptable. */
export function passwordPolicy(password: string): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH)
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`;
  if (!/\p{L}/u.test(password)) return 'Password must contain at least one letter';
  if (!/\p{Nd}/u.test(password)) return 'Password must contain at least one digit';
  if (password.trim() !== password) return 'Password must not start or end with a space';
  return null;
}

// ───────────────────────────── Random identifiers & digests ─────────────────────────────

export const newGuid = (): string => randomUUID();

/** URL-safe random token (default 32 bytes → 43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Uniformly random lowercase base-36 string (unbiased; uses crypto.randomInt). */
export function randomBase36(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += BASE36[randomInt(36)];
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ───────────────────────────── AES-256-GCM file envelope ─────────────────────────────

const MAGIC = Buffer.from('BAHIENC1', 'ascii');
const ENC_SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + ENC_SALT_BYTES + IV_BYTES; // 36, authenticated as AAD
const ENVELOPE_OVERHEAD = HEADER_BYTES + TAG_BYTES;

function deriveFileKey(password: string, salt: Uint8Array): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, 32, scryptOptions(SCRYPT_N, SCRYPT_R, SCRYPT_P));
}

/** True when `data` starts with the Bahi encryption envelope magic. */
export function isEncrypted(data: Uint8Array): boolean {
  return data.length >= MAGIC.length && Buffer.from(data.buffer, data.byteOffset, MAGIC.length).equals(MAGIC);
}

/** Encrypt bytes with a password (AES-256-GCM, scrypt key). */
export function encryptBytes(data: Uint8Array, password: string): Uint8Array {
  if (typeof password !== 'string' || password.length === 0) throw new AppError('VALIDATION', 'A password is required to encrypt');
  const salt = randomBytes(ENC_SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', deriveFileKey(password, salt), iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([header, tag, body]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Decrypt an envelope produced by encryptBytes. Wrong password or any tampering → VALIDATION error. */
export function decryptBytes(data: Uint8Array, password: string): Uint8Array {
  const wrong = (): AppError => new AppError('VALIDATION', 'Wrong password or corrupted file');
  if (!(data instanceof Uint8Array) || data.length < ENVELOPE_OVERHEAD || !isEncrypted(data)) throw wrong();
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const header = buf.subarray(0, HEADER_BYTES);
  const salt = buf.subarray(MAGIC.length, MAGIC.length + ENC_SALT_BYTES);
  const iv = buf.subarray(MAGIC.length + ENC_SALT_BYTES, HEADER_BYTES);
  const tag = buf.subarray(HEADER_BYTES, ENVELOPE_OVERHEAD);
  const body = buf.subarray(ENVELOPE_OVERHEAD);
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveFileKey(String(password ?? ''), salt), iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    throw wrong();
  }
}
