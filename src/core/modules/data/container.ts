/**
 * The .pvqbak backup container — streaming writer and reader.
 *
 * Layout (all integers little-endian):
 *
 *   offset 0   'PEVQBAK1'                     8 bytes magic
 *   offset 8   uint32 M                       length of the manifest area
 *   offset 12  manifest area (M bytes)        UTF-8 JSON (BackupManifest), right-padded with spaces
 *   offset 12+M payload                       gzip(SQLite database)
 *                                             or, with a password, the PEVQENC1 envelope of
 *                                             src/core/lib/crypto.ts around gzip(db):
 *                                             'PEVQENC1' | salt(16) | iv(12) | GCM tag(16) | ciphertext
 *
 * The writer reserves MANIFEST_RESERVED bytes for the manifest, streams the payload after it and then
 * fills in the manifest (and the GCM tag) in place, so the database is read once and memory use stays
 * constant (≈ 64 KiB buffers + zlib state, independent of the database size). The encrypted payload is
 * byte-compatible with decryptBytes() (same scrypt parameters, same AAD), so small payloads can also be
 * opened in memory.
 *
 * Integrity: manifest.payloadSha256 covers the stored payload (detects damage without the password),
 * manifest.dbSha256 the uncompressed database. Deliberate tampering is only detectable for encrypted
 * backups (AES-GCM authenticates the ciphertext); an unencrypted backup can be rewritten consistently by
 * anyone with write access to the file.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, type Hash, type ScryptOptions } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { BackupManifest } from '../../../shared/types/data.ts';
import { SCRYPT_N, SCRYPT_P, SCRYPT_R, randomToken } from '../../lib/crypto.ts';
import { AppError } from '../../lib/errors.ts';
import { renameWithRetry } from '../../lib/fsutil.ts';

export const BACKUP_MAGIC = 'PEVQBAK1';
export const FORMAT_VERSION = 1;
/** Space reserved for the manifest JSON by the writer (readers accept any length up to MAX_MANIFEST). */
export const MANIFEST_RESERVED = 16 * 1024;
const MAX_MANIFEST = 1024 * 1024;
const FIXED_HEADER = 12;

const ENC_MAGIC = Buffer.from('PEVQENC1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENC_HEADER = ENC_MAGIC.length + SALT_BYTES + IV_BYTES; // 36, authenticated as AAD
const ENC_PREFIX = ENC_HEADER + TAG_BYTES; // 52

/** A user-facing problem with a backup file (always VALIDATION / CONFLICT AppErrors). */
export class BackupFileError extends AppError {
  readonly stage: 'container' | 'checksum' | 'password' | 'decompress' | 'database_checksum';
  constructor(stage: BackupFileError['stage'], message: string) {
    super('VALIDATION', message, [{ path: 'path', message }]);
    this.name = 'BackupFileError';
    this.stage = stage;
  }
}

function deriveKey(password: string, salt: Uint8Array): Promise<Buffer> {
  // Same parameters as crypto.ts deriveFileKey → payloads interoperate with decryptBytes().
  const opts: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * SCRYPT_N * SCRYPT_R * SCRYPT_P };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Pass-through stream that feeds every chunk to a hash and counts bytes. */
class HashTap extends Transform {
  readonly hash: Hash = createHash('sha256');
  bytes = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/** Largest database a backup may declare (far above any real company; refuses absurd manifests). */
export const MAX_DB_BYTES = 50 * 1024 ** 3;
/** Free space kept on the data folder's disk when unpacking a backup (WAL, logs, other companies). */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

const BOMB_MESSAGE = 'This backup file is damaged (it unpacks to more data than it declares).';

/**
 * Pass-through stream that fails as soon as more than `limit` bytes have gone through: a
 * decompression bomb (a small gzip that inflates to many GB) never fills the disk.
 */
export class ByteLimit extends Transform {
  private seen = 0;
  private readonly limit: number;
  constructor(limit: number) {
    super();
    this.limit = limit;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.limit) cb(new BackupFileError('decompress', BOMB_MESSAGE));
    else cb(null, chunk);
  }
}

/** Refuse a manifest whose database could not possibly fit (absolute cap, then free disk space). */
function assertRoomFor(dbBytes: number, outPath: string): void {
  if (dbBytes > MAX_DB_BYTES) throw new BackupFileError('decompress', 'This backup file is damaged (it declares an impossibly large database).');
  let free: number | null = null;
  try {
    const st = fs.statfsSync(path.dirname(outPath));
    free = Number(st.bavail) * Number(st.bsize);
  } catch {
    free = null; // file systems that cannot report free space: the byte limit still applies
  }
  if (free !== null && Number.isFinite(free) && dbBytes + FREE_SPACE_MARGIN > free) {
    const mb = (n: number): string => `${Math.ceil(n / 1_048_576).toLocaleString('en-IN')} MB`;
    throw new AppError('BUSINESS_RULE', `There is not enough free disk space in the data folder to unpack this backup (it needs ${mb(dbBytes)}; ${mb(Math.max(0, free))} free). Free some space and try again.`);
  }
}

/** sha256 + size of a file region [start, end). */
export async function hashFileRegion(file: string, start: number, end?: number): Promise<{ sha256: string; bytes: number }> {
  const tap = new HashTap();
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  if (end !== undefined && end <= start) return { sha256: createHash('sha256').digest('hex'), bytes: 0 };
  await pipeline(fs.createReadStream(file, { start, end: end === undefined ? undefined : end - 1 }), tap, sink);
  return { sha256: tap.hash.digest('hex'), bytes: tap.bytes };
}

export type ManifestDraft = Omit<BackupManifest, 'payloadSha256' | 'payloadBytes' | 'dbSha256' | 'dbBytes' | 'encrypted' | 'compression' | 'format' | 'formatVersion'>;

/**
 * Write a container for the SQLite file `dbPath` to `target` atomically (temp file in the same folder,
 * fsync, rename). Never overwrites an existing file (fails with CONFLICT instead).
 */
export async function writeContainer(opts: {
  dbPath: string;
  target: string;
  manifest: ManifestDraft;
  password?: string;
}): Promise<{ manifest: BackupManifest; sizeBytes: number }> {
  const dir = path.dirname(opts.target);
  const tmp = path.join(dir, `.${path.basename(opts.target)}.${randomToken(6)}.tmp`);
  const handle = await fsp.open(tmp, 'wx', 0o600);
  let closed = false;
  try {
    const header = Buffer.alloc(FIXED_HEADER + MANIFEST_RESERVED, 0x20);
    header.write(BACKUP_MAGIC, 0, 'ascii');
    header.writeUInt32LE(MANIFEST_RESERVED, 8);
    await handle.write(header, 0, header.length, 0);
    const payloadOffset = FIXED_HEADER + MANIFEST_RESERVED;

    const dbTap = new HashTap();
    const gzip = createGzip({ level: 6 });
    let payloadSha256: string;
    let payloadBytes: number;
    if (opts.password) {
      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      const encHeader = Buffer.concat([ENC_MAGIC, salt, iv]);
      const key = await deriveKey(opts.password, salt);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(encHeader);
      await handle.write(Buffer.concat([encHeader, Buffer.alloc(TAG_BYTES)]), 0, ENC_PREFIX, payloadOffset);
      const out = fs.createWriteStream(tmp, { flags: 'r+', start: payloadOffset + ENC_PREFIX });
      const ctTap = new HashTap();
      await pipeline(fs.createReadStream(opts.dbPath), dbTap, gzip, cipher, ctTap, out);
      await handle.write(cipher.getAuthTag(), 0, TAG_BYTES, payloadOffset + ENC_HEADER);
      await handle.sync();
      // The tag precedes the ciphertext, so the payload digest needs a second (sequential) read.
      const h = await hashFileRegion(tmp, payloadOffset);
      payloadSha256 = h.sha256;
      payloadBytes = h.bytes;
      if (payloadBytes !== ENC_PREFIX + ctTap.bytes) throw new AppError('INTERNAL', 'Backup payload size mismatch');
    } else {
      const out = fs.createWriteStream(tmp, { flags: 'r+', start: payloadOffset });
      const payloadTap = new HashTap();
      await pipeline(fs.createReadStream(opts.dbPath), dbTap, gzip, payloadTap, out);
      payloadSha256 = payloadTap.hash.digest('hex');
      payloadBytes = payloadTap.bytes;
    }

    const manifest: BackupManifest = {
      format: 'pevqori-backup',
      formatVersion: FORMAT_VERSION,
      ...opts.manifest,
      encrypted: Boolean(opts.password),
      compression: 'gzip',
      payloadSha256,
      payloadBytes,
      dbSha256: dbTap.hash.digest('hex'),
      dbBytes: dbTap.bytes,
    };
    const json = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (json.length > MANIFEST_RESERVED) throw new AppError('VALIDATION', 'The backup note is too long. Shorten it and try again.');
    await handle.write(json, 0, json.length, FIXED_HEADER);
    await handle.sync();
    await handle.close();
    closed = true;
    if (fs.existsSync(opts.target)) throw new AppError('CONFLICT', `A file named ${path.basename(opts.target)} already exists in the backup folder.`);
    renameWithRetry(tmp, opts.target);
    return { manifest, sizeBytes: payloadOffset + payloadBytes };
  } catch (err) {
    if (!closed) await handle.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface ContainerInfo {
  manifest: BackupManifest;
  payloadOffset: number;
  fileSize: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function checkManifest(raw: unknown): BackupManifest {
  const bad = (why: string): never => {
    throw new BackupFileError('container', `This backup file is damaged (${why}).`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('no manifest');
  const m = raw as Record<string, unknown>;
  if (m.format !== 'pevqori-backup') bad('unknown format');
  if (typeof m.formatVersion !== 'number' || !Number.isInteger(m.formatVersion)) bad('no format version');
  if ((m.formatVersion as number) > FORMAT_VERSION) {
    throw new AppError('CONFLICT', `This backup was made by a newer version of Pevqori (backup format ${String(m.formatVersion)}). Update Pevqori to use it.`);
  }
  const str = (k: string): void => {
    if (typeof m[k] !== 'string' || (m[k] as string).length > 1000) bad(`field ${k}`);
  };
  for (const k of ['appVersion', 'companyId', 'companyGuid', 'companyName', 'booksFrom', 'createdAt']) str(k);
  for (const k of ['schemaVersion', 'payloadBytes', 'dbBytes']) if (typeof m[k] !== 'number' || !Number.isSafeInteger(m[k]) || (m[k] as number) < 0) bad(`field ${k}`);
  if (typeof m.encrypted !== 'boolean') bad('field encrypted');
  if (m.compression !== 'gzip') bad('unknown compression');
  if (typeof m.payloadSha256 !== 'string' || !HEX64.test(m.payloadSha256)) bad('field payloadSha256');
  if (typeof m.dbSha256 !== 'string' || !HEX64.test(m.dbSha256)) bad('field dbSha256');
  return {
    format: 'pevqori-backup',
    formatVersion: 1,
    appVersion: m.appVersion as string,
    schemaVersion: m.schemaVersion as number,
    companyId: m.companyId as string,
    companyGuid: m.companyGuid as string,
    companyName: m.companyName as string,
    gstin: typeof m.gstin === 'string' ? m.gstin : null,
    booksFrom: m.booksFrom as string,
    createdAt: m.createdAt as string,
    createdBy: typeof m.createdBy === 'string' ? m.createdBy : null,
    note: typeof m.note === 'string' ? m.note : null,
    kind: m.kind === 'auto' ? 'auto' : 'manual',
    encrypted: m.encrypted as boolean,
    compression: 'gzip',
    payloadSha256: m.payloadSha256 as string,
    payloadBytes: m.payloadBytes as number,
    dbSha256: m.dbSha256 as string,
    dbBytes: m.dbBytes as number,
    ...auditHeadOf(m.auditHead),
  };
}

/** Optional manifest.auditHead, kept only when well-formed (older backups have none). */
function auditHeadOf(raw: unknown): Pick<BackupManifest, 'auditHead'> {
  if (!raw || typeof raw !== 'object') return {};
  const h = raw as Record<string, unknown>;
  if (typeof h.lastId !== 'number' || !Number.isSafeInteger(h.lastId) || typeof h.lastHash !== 'string' || !HEX64.test(h.lastHash)) return {};
  const mac = typeof h.mac === 'string' && HEX64.test(h.mac) ? h.mac : null;
  return { auditHead: { lastId: h.lastId, lastHash: h.lastHash, mac } };
}

/** Read and validate the header + manifest (the payload is not read). Synchronous: a few KiB. */
export function readContainerInfo(file: string): ContainerInfo {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AppError('NOT_FOUND', 'The backup file no longer exists.');
    throw new BackupFileError('container', `The backup file cannot be read${code ? ` (${code})` : ''}.`);
  }
  try {
    const fileSize = fs.fstatSync(fd).size;
    const head = Buffer.alloc(FIXED_HEADER);
    if (fs.readSync(fd, head, 0, FIXED_HEADER, 0) < FIXED_HEADER || head.toString('ascii', 0, 8) !== BACKUP_MAGIC) {
      throw new BackupFileError('container', 'This is not a Pevqori backup file (.pvqbak).');
    }
    const len = head.readUInt32LE(8);
    if (len === 0 || len > MAX_MANIFEST || FIXED_HEADER + len > fileSize) throw new BackupFileError('container', 'This backup file is damaged (bad header).');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, FIXED_HEADER);
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new BackupFileError('container', 'This backup file is damaged (unreadable manifest).');
    }
    const manifest = checkManifest(parsed);
    const payloadOffset = FIXED_HEADER + len;
    if (fileSize - payloadOffset !== manifest.payloadBytes) {
      throw new BackupFileError('container', 'This backup file is incomplete or damaged (its size does not match). It may have been cut short while copying.');
    }
    return { manifest, payloadOffset, fileSize };
  } finally {
    fs.closeSync(fd);
  }
}

/** Compare the stored payload with manifest.payloadSha256 (no password needed). */
export async function checkPayloadDigest(file: string, info: ContainerInfo): Promise<void> {
  const h = await hashFileRegion(file, info.payloadOffset);
  if (h.sha256 !== info.manifest.payloadSha256 || h.bytes !== info.manifest.payloadBytes) {
    throw new BackupFileError('checksum', 'This backup file is damaged or has been modified (checksum mismatch). Use another backup.');
  }
}

/**
 * Decrypt (when encrypted) and decompress the payload into `outPath` (created exclusively), verifying
 * manifest.dbSha256. Call checkPayloadDigest first: a failure here then means a wrong password.
 */
export async function extractPayload(file: string, info: ContainerInfo, password: string | undefined, outPath: string): Promise<void> {
  if (info.manifest.encrypted && !password) {
    throw new BackupFileError('password', 'This backup is protected with a password. Enter the password to continue.');
  }
  assertRoomFor(info.manifest.dbBytes, outPath);
  const dbTap = new HashTap();
  try {
    if (info.manifest.encrypted) {
      const prefix = Buffer.alloc(ENC_PREFIX);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, prefix, 0, ENC_PREFIX, info.payloadOffset);
      } finally {
        fs.closeSync(fd);
      }
      if (!prefix.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) throw new BackupFileError('container', 'This backup file is damaged (bad encryption header).');
      const salt = prefix.subarray(ENC_MAGIC.length, ENC_MAGIC.length + SALT_BYTES);
      const iv = prefix.subarray(ENC_MAGIC.length + SALT_BYTES, ENC_HEADER);
      const key = await deriveKey(password as string, salt);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(prefix.subarray(0, ENC_HEADER));
      decipher.setAuthTag(prefix.subarray(ENC_HEADER, ENC_PREFIX));
      try {
        await pipeline(
          fs.createReadStream(file, { start: info.payloadOffset + ENC_PREFIX }),
          decipher,
          createGunzip(),
          new ByteLimit(info.manifest.dbBytes),
          dbTap,
          fs.createWriteStream(outPath, { flags: 'wx', mode: 0o600 }),
        );
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new BackupFileError('password', 'Wrong password for this backup (or the file is damaged).');
      }
    } else {
      try {
        await pipeline(
          fs.createReadStream(file, { start: info.payloadOffset }),
          createGunzip(),
          new ByteLimit(info.manifest.dbBytes),
          dbTap,
          fs.createWriteStream(outPath, { flags: 'wx', mode: 0o600 }),
        );
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new BackupFileError('decompress', 'This backup file is damaged (its data cannot be decompressed).');
      }
    }
    if (dbTap.hash.digest('hex') !== info.manifest.dbSha256 || dbTap.bytes !== info.manifest.dbBytes) {
      throw new BackupFileError('database_checksum', 'The restored data does not match the checksum recorded in the backup. Use another backup.');
    }
  } catch (err) {
    await fsp.rm(outPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
