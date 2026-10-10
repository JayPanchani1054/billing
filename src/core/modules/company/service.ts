/**
 * Company profile, features (F11), configuration (F12) and period lock.
 *
 * Other modules import from here:
 *   getFeatures(db), getConfig(db)      — always merged over defaults, never null
 *   assertDateUnlocked(db, date)        — call before creating/altering/deleting a dated entry
 *   getCompanyProfile(db)               — for print headers, GST state, books-from date
 */
import { formatDate } from '../../../shared/dates.ts';
import {
  DEFAULT_CONFIG,
  DEFAULT_FEATURES,
  mergeDefaults,
  type CompanyConfig,
  type CompanyFeatures,
} from '../../../shared/settings.ts';
import type { OpenCompanySummary } from '../../../shared/types/app.ts';
import {
  COMPANY_LOGO_MAX_BYTES,
  COMPANY_LOGO_MIME_TYPES,
  type CompanyConfigInput,
  type CompanyFeaturesInput,
  type CompanyProfile,
  type CompanyProfileInput,
  type GstRegistrationType,
  type PeriodLockResult,
} from '../../../shared/types/company.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { ensureGstLedgers } from '../../db/seed.ts';
import { ensureMfgVoucherTypes } from '../mfg/voucherTypes.ts';
import { ensureForexLedger } from '../forex/store.ts';
import { ensurePosSetup } from '../pos/store.ts';
import { AppError, forbidden, notFound, rule, validation } from '../../lib/errors.ts';
import { authorizeUserPath, isBackupFolderApproved } from '../../lib/paths.ts';
import { normalizeCompanyIdentity } from './validation.ts';

// ───────────────────────────── Settings storage ─────────────────────────────

/** Raw JSON value of a settings key (undefined when absent or unparsable). */
export function readSetting(db: Db, key: string): unknown {
  const raw = db.value<string>('SELECT value FROM settings WHERE key = :key', { key });
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeSetting(db: Db, key: string, value: unknown, now: Date): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :ts)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    { key, value: JSON.stringify(value), ts: now.toISOString() },
  );
}

/**
 * Features merged over defaults. Always a fresh object: mergeDefaults() can hand back (parts of) the
 * shared DEFAULT_* constants, and a caller mutating the result must never change the defaults of
 * every other company opened in this process.
 */
export function getFeatures(db: Db): CompanyFeatures {
  return structuredClone(mergeDefaults(DEFAULT_FEATURES, readSetting(db, 'features')));
}

/** Configuration merged over defaults (fresh object, see getFeatures). */
export function getConfig(db: Db): CompanyConfig {
  return structuredClone(mergeDefaults(DEFAULT_CONFIG, readSetting(db, 'config')));
}

// ───────────────────────────── Profile ─────────────────────────────

interface CompanyRow {
  guid: string;
  name: string;
  mailing_name: string | null;
  address: string | null;
  state_code: string | null;
  country: string;
  pincode: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  gst_registration_type: GstRegistrationType;
  pan: string | null;
  tan: string | null;
  cin: string | null;
  fy_start_month: number;
  books_from: string;
  base_currency: string;
  logo: Uint8Array | null;
  created_at: string;
  updated_at: string;
}

function companyRow(db: Db): CompanyRow {
  const row = db.get<CompanyRow>('SELECT * FROM company WHERE id = 1');
  if (!row) throw notFound('Company');
  return row;
}

/** Detect an image type from magic bytes. */
function sniffImage(bytes: Uint8Array): (typeof COMPANY_LOGO_MIME_TYPES)[number] | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP')
    return 'image/webp';
  return null;
}

export function logoToDataUrl(bytes: Uint8Array | null): string | null {
  if (!bytes || bytes.length === 0) return null;
  const mime = sniffImage(bytes);
  return mime ? `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` : null;
}

/** Decode and verify a logo data URL. Throws VALIDATION with a user-facing message. */
export function decodeLogo(dataUrl: string): Uint8Array {
  const bad = (message: string): AppError => validation([{ path: 'logo', message }]);
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) throw bad('Logo must be a PNG, JPEG, WebP or GIF image');
  const declared = m[1].toLowerCase();
  if (!(COMPANY_LOGO_MIME_TYPES as readonly string[]).includes(declared)) throw bad('Logo must be a PNG, JPEG, WebP or GIF image');
  // Size guard before decoding: base64 expands by 4/3.
  if (m[2].length > Math.ceil((COMPANY_LOGO_MAX_BYTES * 4) / 3) + 8) throw bad('Logo is too large (maximum 512 KB)');
  const bytes = new Uint8Array(Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
  if (bytes.length === 0) throw bad('Logo image is empty');
  if (bytes.length > COMPANY_LOGO_MAX_BYTES) throw bad('Logo is too large (maximum 512 KB)');
  if (sniffImage(bytes) === null) throw bad('Logo file is not a valid image');
  return bytes;
}

function toProfile(row: CompanyRow): CompanyProfile {
  return {
    guid: row.guid,
    name: row.name,
    mailingName: row.mailing_name,
    address: row.address,
    stateCode: row.state_code,
    country: row.country,
    pincode: row.pincode,
    phone: row.phone,
    mobile: row.mobile,
    email: row.email,
    website: row.website,
    gstin: row.gstin,
    gstRegistrationType: row.gst_registration_type,
    pan: row.pan,
    tan: row.tan,
    cin: row.cin,
    fyStartMonth: row.fy_start_month,
    booksFrom: row.books_from,
    baseCurrency: row.base_currency,
    logo: logoToDataUrl(row.logo),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getCompanyProfile(db: Db): CompanyProfile {
  return toProfile(companyRow(db));
}

/** Profile for the audit log (logo summarised, not embedded). */
const auditView = (p: CompanyProfile): Record<string, unknown> => ({ ...p, logo: p.logo ? `[logo ${p.logo.length} chars]` : null });

export function saveCompanyProfile(ctx: CompanyCtx, input: CompanyProfileInput): CompanyProfile {
  const { db } = ctx;
  const before = getCompanyProfile(db);
  const c = normalizeCompanyIdentity(input);

  if (c.booksFrom !== before.booksFrom) {
    const earlier = db.value<number>('SELECT COUNT(*) FROM vouchers WHERE date < :d', { d: c.booksFrom }) ?? 0;
    if (earlier > 0)
      throw rule(`Books cannot begin on ${formatDate(c.booksFrom)}: ${earlier} voucher${earlier === 1 ? ' is' : 's are'} dated before it.`);
  }
  if (c.fyStartMonth !== before.fyStartMonth) {
    const count = db.value<number>('SELECT COUNT(*) FROM vouchers') ?? 0;
    if (count > 0) throw rule('The financial year start month cannot be changed after vouchers have been entered.');
  }

  let logoBytes: Uint8Array | null | undefined; // undefined = keep
  if (input.logo === null) logoBytes = null;
  else if (typeof input.logo === 'string') logoBytes = decodeLogo(input.logo);

  const ts = ctx.clock.now().toISOString();
  db.run(
    `UPDATE company SET name = :name, mailing_name = :mailingName, address = :address, state_code = :stateCode,
            country = :country, pincode = :pincode, phone = :phone, mobile = :mobile, email = :email, website = :website,
            gstin = :gstin, gst_registration_type = :reg, pan = :pan, tan = :tan, cin = :cin,
            fy_start_month = :fyStartMonth, books_from = :booksFrom, updated_at = :ts
      WHERE id = 1`,
    {
      name: c.name,
      mailingName: c.mailingName,
      address: c.address,
      stateCode: c.stateCode,
      country: c.country,
      pincode: c.pincode,
      phone: c.phone,
      mobile: c.mobile,
      email: c.email,
      website: c.website,
      gstin: c.gstin,
      reg: c.gstRegistrationType,
      pan: c.pan,
      tan: c.tan,
      cin: c.cin,
      fyStartMonth: c.fyStartMonth,
      booksFrom: c.booksFrom,
      ts,
    },
  );
  if (logoBytes !== undefined) db.run('UPDATE company SET logo = :logo WHERE id = 1', { logo: logoBytes });

  // Registration changes drive the GST feature: unregistered → off; newly registered → on.
  if (c.gstRegistrationType !== before.gstRegistrationType) {
    const features = getFeatures(db);
    if (c.gstRegistrationType === 'unregistered' && features.gst) applyFeatures(ctx, features, { gst: false });
    else if (before.gstRegistrationType === 'unregistered' && !features.gst) applyFeatures(ctx, features, { gst: true });
  }

  const after = getCompanyProfile(db);
  ctx.audit({ action: 'alter', entityType: 'company', entityId: 1, entityGuid: after.guid, entityLabel: after.name, before: auditView(before), after: auditView(after) });
  return after;
}

// ───────────────────────────── Features (F11) ─────────────────────────────

/** Apply feature dependency rules. Pure. */
export function normalizeFeatures(f: CompanyFeatures): CompanyFeatures {
  const out = { ...f };
  if (!out.gst) {
    out.einvoice = false;
    out.ewayBill = false;
  }
  if (!out.inventory) {
    out.integrateInventory = false;
    out.multipleGodowns = false;
    out.batches = false;
    out.expiryDates = false;
    out.trackingNumbers = false;
    out.rejectionNotes = false;
    out.actualAndBilledQty = false;
    out.priceLevels = false;
    out.manufacturing = false;
    // POS counter bills stock items (pos module).
    out.pos = false;
  }
  if (!out.batches) out.expiryDates = false;
  // Job work needs third-party godowns (mfg module).
  if (!out.multipleGodowns) out.jobWork = false;
  return out;
}

/**
 * Internal options for saveFeatures. NOT reachable from the `company.features.save` route (its handler
 * passes only the validated input).
 */
export interface SaveFeaturesOptions {
  /**
   * Allow `security` to change. Only security/toggle.ts passes this, after it has verified the Owner's
   * password (enable/disable). Any other caller that tries to change `security` gets BUSINESS_RULE, so
   * F11 can never switch security off without the Owner password (which would hand out the implicit
   * owner session after the next logout).
   */
  securityToggle?: boolean;
}

export const SECURITY_TOGGLE_ELSEWHERE =
  'Password protection is turned on or off under Security › Security Settings, which asks for the Owner password.';

function applyFeatures(ctx: CompanyCtx, current: CompanyFeatures, patch: CompanyFeaturesInput, opts: SaveFeaturesOptions = {}): CompanyFeatures {
  const { db } = ctx;
  const next = normalizeFeatures({ ...current, ...patch });
  const now = ctx.clock.now();
  if (next.security !== current.security && opts.securityToggle !== true) throw rule(SECURITY_TOGGLE_ELSEWHERE);

  if (next.gst && !current.gst) {
    const reg = db.value<string>('SELECT gst_registration_type FROM company WHERE id = 1');
    if (reg === 'unregistered')
      throw rule('An unregistered business cannot charge GST. Set the GST registration type and GSTIN in the company profile first.');
    ensureGstLedgers(db, now.toISOString());
  }
  // Manufacturing Journal / Material In / Material Out voucher types (mfg module), when switched on.
  if ((next.manufacturing && !current.manufacturing) || (next.jobWork && !current.jobWork)) {
    ensureMfgVoucherTypes(db, now.toISOString(), { manufacturing: next.manufacturing, jobWork: next.jobWork }, ctx.audit);
  }
  // Forex Gain/Loss system ledger (forex module), when Multiple currencies is switched on.
  if (next.multiCurrency && !current.multiCurrency) ensureForexLedger(db, now.toISOString(), ctx.audit);
  // POS Sales / POS Return voucher types, Cash tender and exchange-credit ledger (pos module), when switched on.
  if (next.pos && !current.pos) ensurePosSetup(db, now.toISOString(), ctx.audit);
  if (next.security !== current.security) {
    if (!ctx.session.isOwner && !ctx.session.permissions.has('security.manage'))
      throw new AppError('FORBIDDEN', 'Only a user who can manage security may turn security on or off');
    if (next.security) {
      const owners =
        db.value<number>(
          `SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1 AND r.is_system = 1 AND r.name = 'Owner'`,
        ) ?? 0;
      if (owners === 0) throw rule('Create an Owner user with a password before turning on security.');
    }
  }

  writeSetting(db, 'features', next, now);
  ctx.audit({ action: 'settings', entityType: 'company_features', entityLabel: 'Features (F11)', before: current, after: next });
  return next;
}

/**
 * Merge a partial features update (F11). Enabling GST creates missing GST ledgers; disabling keeps them.
 * `security` cannot change here unless `opts.securityToggle` (see SaveFeaturesOptions).
 */
export function saveFeatures(ctx: CompanyCtx, partial: CompanyFeaturesInput, opts: SaveFeaturesOptions = {}): CompanyFeatures {
  return applyFeatures(ctx, getFeatures(ctx.db), partial, opts);
}

// ───────────────────────────── Configuration (F12) ─────────────────────────────

/** Deep-merge a partial configuration (F12). `lockedUpTo` is ignored here (see setPeriodLock). */
export function saveConfig(ctx: CompanyCtx, partial: CompanyConfigInput): CompanyConfig {
  const { db } = ctx;
  const current = getConfig(db);
  const { lockedUpTo: _ignored, ...rest } = partial as CompanyConfigInput & { lockedUpTo?: unknown };
  const next = mergeDefaults(current, rest);
  next.lockedUpTo = current.lockedUpTo;

  const bankLedgerId = next.invoice.bankLedgerId;
  if (bankLedgerId !== null && bankLedgerId !== current.invoice.bankLedgerId) {
    const exists = db.value('SELECT 1 FROM ledgers WHERE id = :id', { id: bankLedgerId });
    if (exists === undefined) throw validation([{ path: 'invoice.bankLedgerId', message: 'Selected bank ledger does not exist' }]);
  }
  // The backup folder comes from the renderer: accept a new one only if the user picked it in the folder
  // dialog this session (or it lies in the data folder). Otherwise data.backup.auto would keep exporting
  // the books to wherever a compromised renderer pointed it (e.g. a remote \\host\share).
  // The folder is also approved for this company on THIS installation (AppRuntime.backupFolders): a
  // folder stored in the company file but never picked here (restored backup, copied company) is not
  // a trusted root and is not written to until the user picks it again (F12 or the Backup screen).
  const folder = next.backup.folder;
  const companyGuid = db.value<string>('SELECT guid FROM company WHERE id = 1') ?? null;
  const currentApproved = current.backup.folder !== null && isBackupFolderApproved(ctx.app, companyGuid, current.backup.folder) ? current.backup.folder : null;
  if (folder !== null && folder !== current.backup.folder) {
    next.backup.folder = authorizeUserPath(ctx.app, folder, 'write-dir', { field: 'backup.folder', what: 'backup folder', trusted: [currentApproved] });
    if (companyGuid) ctx.app.backupFolders?.approve(companyGuid, next.backup.folder, ctx.clock.now());
  } else if (folder !== null && currentApproved === null && companyGuid) {
    // Unchanged but not approved here: re-picking the same folder in the dialog approves it; saving
    // other F12 settings leaves it as it is (still unapproved) without refusing the save.
    try {
      ctx.app.backupFolders?.approve(companyGuid, authorizeUserPath(ctx.app, folder, 'write-dir', { field: 'backup.folder', what: 'backup folder' }), ctx.clock.now());
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  const { lutValidFrom, lutValidTo } = next.gst;
  if (lutValidFrom && lutValidTo && lutValidTo < lutValidFrom)
    throw validation([{ path: 'gst.lutValidTo', message: 'LUT validity end date is before its start date' }]);

  writeSetting(db, 'config', next, ctx.clock.now());
  ctx.audit({ action: 'settings', entityType: 'company_config', entityLabel: 'Configuration (F12)', before: current, after: next });
  return next;
}

// ───────────────────────────── Period lock ─────────────────────────────

/** Throw LOCKED when `date` falls on or before the configured lock date. */
export function assertDateUnlocked(db: Db, date: string): void {
  const lockedUpTo = getConfig(db).lockedUpTo;
  if (lockedUpTo && date <= lockedUpTo) {
    throw new AppError(
      'LOCKED',
      `Books are locked up to ${formatDate(lockedUpTo)}. Entries dated on or before this date cannot be created, altered or deleted.`,
      { lockedUpTo },
    );
  }
}

/** Lock books up to `date` (inclusive) or unlock with null. Requires permission period.lock (checked here too). */
export function setPeriodLock(ctx: CompanyCtx, date: string | null): PeriodLockResult {
  const { db, session } = ctx;
  if (!session.isOwner && !session.permissions.has('period.lock')) throw forbidden('You do not have permission to lock or unlock the books');
  const current = getConfig(db);
  if (date !== null && date > ctx.clock.today())
    throw rule(`Books can be locked only up to today (${formatDate(ctx.clock.today())}).`);
  if (current.lockedUpTo === date) return { lockedUpTo: date };
  const next: CompanyConfig = { ...current, lockedUpTo: date };
  writeSetting(db, 'config', next, ctx.clock.now());
  ctx.audit({
    action: 'settings',
    entityType: 'period_lock',
    entityLabel: date ? `Books locked up to ${formatDate(date)}` : 'Books unlocked',
    before: { lockedUpTo: current.lockedUpTo },
    after: { lockedUpTo: date },
  });
  return { lockedUpTo: date };
}

// ───────────────────────────── Summary ─────────────────────────────

export function getOpenCompanySummary(db: Db, companyId: string): OpenCompanySummary {
  const p = getCompanyProfile(db);
  const features = getFeatures(db);
  return {
    id: companyId,
    name: p.name,
    mailingName: p.mailingName,
    gstin: p.gstin,
    stateCode: p.stateCode,
    booksFrom: p.booksFrom,
    fyStartMonth: p.fyStartMonth,
    gstEnabled: features.gst,
    features,
    gstRegistration: p.gstRegistrationType,
  };
}
