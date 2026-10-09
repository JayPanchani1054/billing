/**
 * Seed a freshly migrated company database: company row, features/config, the 28 predefined
 * groups, reserved ledgers, voucher types, units, main godown, base currency, cost category,
 * system roles and (optionally) the Owner user. Runs in one transaction.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_UNITS,
  MAIN_GODOWN_NAME,
  PERMISSIONS,
  PREDEFINED_GROUPS,
  PREDEFINED_LEDGERS,
  PREDEFINED_VOUCHER_TYPES,
  SYSTEM_ROLES,
  type GroupCode,
  type LedgerCode,
  type Permission,
  type PredefinedLedger,
  type VoucherBaseType,
} from '../../shared/constants.ts';
import { DEFAULT_CONFIG, DEFAULT_FEATURES, mergeDefaults, type CompanyFeatures } from '../../shared/settings.ts';
import type { CreateCompanyInput } from '../../shared/types/app.ts';
import { AppError, conflict } from '../lib/errors.ts';
import { normalizeCompanyIdentity } from '../modules/company/validation.ts';
import { ensureMfgVoucherTypes } from '../modules/mfg/voucherTypes.ts';
import type { Db } from './db.ts';

export interface SeedOptions {
  now: Date;
  /** scrypt hash of input.owner.password (required when input.owner is given). */
  ownerPasswordHash?: string;
}

export interface SeedResult {
  companyGuid: string;
  features: CompanyFeatures;
  groupIds: Record<GroupCode, number>;
  /** GST ledgers are present only when GST is enabled. */
  ledgerIds: Partial<Record<LedgerCode, number>>;
  /** Predefined voucher type id per base type. */
  voucherTypeIds: Record<VoucherBaseType, number>;
  /** Unit id by symbol ('Nos', 'Kg', …). */
  unitIds: Record<string, number>;
  mainGodownId: number;
  currencyId: number;
  costCategoryId: number;
  /** Role id by name ('Owner', 'Accountant', …). */
  roleIds: Record<string, number>;
  ownerUserId: number | null;
}

/** Voucher types whose config carries a default sales/purchase ledger. */
const DEFAULT_LEDGER_BY_BASE: Partial<Record<VoucherBaseType, LedgerCode>> = {
  sales: 'SALES',
  credit_note: 'SALES',
  purchase: 'PURCHASE',
  debit_note: 'PURCHASE',
};

/** Resolve the effective features for a new company from user choices + registration rules. */
export function resolveInitialFeatures(input: CreateCompanyInput): CompanyFeatures {
  const f = mergeDefaults(DEFAULT_FEATURES, input.features ?? {});
  if (input.gstRegistrationType === 'unregistered') f.gst = false;
  if (!f.gst) {
    f.einvoice = false;
    f.ewayBill = false;
  }
  // Security needs at least one user who can log in.
  f.security = Boolean(input.owner);
  return f;
}

export function seedCompany(db: Db, input: CreateCompanyInput, opts: SeedOptions): SeedResult {
  const company = normalizeCompanyIdentity(input);
  if (input.owner && !opts.ownerPasswordHash) throw new AppError('INTERNAL', 'seedCompany: ownerPasswordHash is required when an owner is given');
  const ts = opts.now.toISOString();
  const features = resolveInitialFeatures(input);

  return db.transaction((): SeedResult => {
    if (db.value('SELECT COUNT(*) FROM company') !== 0) throw conflict('This company database is already initialised');
    const companyGuid = randomUUID();

    db.run(
      `INSERT INTO company (id, guid, name, mailing_name, address, state_code, country, pincode, phone, mobile, email, website,
                            gstin, gst_registration_type, pan, tan, cin, fy_start_month, books_from, base_currency, logo,
                            created_at, updated_at)
       VALUES (1, :guid, :name, :mailingName, :address, :stateCode, :country, :pincode, :phone, :mobile, :email, :website,
               :gstin, :reg, :pan, :tan, :cin, :fyStartMonth, :booksFrom, 'INR', NULL, :ts, :ts)`,
      {
        guid: companyGuid,
        name: company.name,
        mailingName: company.mailingName,
        address: company.address,
        stateCode: company.stateCode,
        country: company.country,
        pincode: company.pincode,
        phone: company.phone,
        mobile: company.mobile,
        email: company.email,
        website: company.website,
        gstin: company.gstin,
        reg: company.gstRegistrationType,
        pan: company.pan,
        tan: company.tan,
        cin: company.cin,
        fyStartMonth: company.fyStartMonth,
        booksFrom: company.booksFrom,
        ts,
      },
    );

    const putSetting = (key: string, value: unknown): void => {
      db.run('INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :ts)', { key, value: JSON.stringify(value), ts });
    };
    putSetting('features', features);
    putSetting('config', DEFAULT_CONFIG);

    // Groups — parents always precede children in PREDEFINED_GROUPS.
    const groupIds = {} as Record<GroupCode, number>;
    PREDEFINED_GROUPS.forEach((g, i) => {
      const parentId = g.parent ? groupIds[g.parent] : null;
      if (g.parent && parentId === undefined) throw new Error(`Group ${g.code} listed before its parent ${g.parent}`);
      groupIds[g.code] = db.run(
        `INSERT INTO groups (guid, name, parent_id, nature, affects_gross_profit, reserved_code, is_predefined, is_subledger,
                             sort_order, created_at, updated_at)
         VALUES (:guid, :name, :parentId, :nature, :agp, :code, 1, :sub, :sort, :ts, :ts)`,
        {
          guid: randomUUID(),
          name: g.name,
          parentId,
          nature: g.nature,
          agp: g.affectsGrossProfit,
          code: g.code,
          sub: g.isSubledger ?? false,
          sort: (i + 1) * 10,
          ts,
        },
      ).lastInsertRowid;
    });

    // Base currency.
    const currencyId = db.run(
      `INSERT INTO currencies (guid, symbol, formal_name, iso_code, decimal_places, is_base, created_at, updated_at)
       VALUES (:guid, '₹', 'Indian Rupee', 'INR', 2, 1, :ts, :ts)`,
      { guid: randomUUID(), ts },
    ).lastInsertRowid;

    // Reserved ledgers.
    const ledgerIds: Partial<Record<LedgerCode, number>> = {};
    for (const l of PREDEFINED_LEDGERS) {
      if (l.gstOnly) continue;
      ledgerIds[l.code] = insertPredefinedLedger(db, l, groupIds[l.group], features, ts);
    }
    if (features.gst) Object.assign(ledgerIds, ensureGstLedgers(db, ts));

    // Voucher types.
    const voucherTypeIds = {} as Record<VoucherBaseType, number>;
    for (const vt of PREDEFINED_VOUCHER_TYPES) {
      const defCode = DEFAULT_LEDGER_BY_BASE[vt.baseType];
      const config = defCode ? { defaultLedgerId: ledgerIds[defCode] ?? null } : {};
      voucherTypeIds[vt.baseType] = db.run(
        `INSERT INTO voucher_types (guid, name, abbreviation, base_type, is_predefined, numbering_method, numbering_restart,
                                    config, created_at, updated_at)
         VALUES (:guid, :name, :abbr, :base, 1, 'automatic', 'yearly', :config, :ts, :ts)`,
        { guid: randomUUID(), name: vt.name, abbr: vt.abbreviation, base: vt.baseType, config: JSON.stringify(config), ts },
      ).lastInsertRowid;
    }
    // Classed stock journal types (mfg module) when the company starts with Manufacturing / Job work on.
    if (features.manufacturing || features.jobWork) ensureMfgVoucherTypes(db, ts, features);

    // Units of measure.
    const unitIds: Record<string, number> = {};
    for (const u of DEFAULT_UNITS) {
      unitIds[u.symbol] = db.run(
        `INSERT INTO units (guid, symbol, formal_name, uqc, decimal_places, created_at, updated_at)
         VALUES (:guid, :symbol, :formal, :uqc, :dp, :ts, :ts)`,
        { guid: randomUUID(), symbol: u.symbol, formal: u.formalName, uqc: u.uqc, dp: u.decimals, ts },
      ).lastInsertRowid;
    }

    const mainGodownId = db.run(
      `INSERT INTO godowns (guid, name, is_predefined, created_at, updated_at) VALUES (:guid, :name, 1, :ts, :ts)`,
      { guid: randomUUID(), name: MAIN_GODOWN_NAME, ts },
    ).lastInsertRowid;

    const costCategoryId = db.run(
      `INSERT INTO cost_categories (guid, name, allocate_revenue, allocate_non_revenue, is_predefined, created_at, updated_at)
       VALUES (:guid, 'Primary Cost Category', 1, 0, 1, :ts, :ts)`,
      { guid: randomUUID(), ts },
    ).lastInsertRowid;

    // System roles.
    const roleIds: Record<string, number> = {};
    for (const role of SYSTEM_ROLES) {
      const perms: readonly Permission[] = role.permissions === 'all' ? PERMISSIONS : role.permissions;
      roleIds[role.name] = db.run(
        `INSERT INTO roles (name, description, permissions, is_system, created_at, updated_at)
         VALUES (:name, :description, :permissions, 1, :ts, :ts)`,
        { name: role.name, description: role.description, permissions: JSON.stringify([...perms]), ts },
      ).lastInsertRowid;
    }

    let ownerUserId: number | null = null;
    if (input.owner) {
      ownerUserId = db.run(
        `INSERT INTO users (username, display_name, password_hash, role_id, is_active, must_change_password, created_at, updated_at)
         VALUES (:username, :displayName, :hash, :roleId, 1, 0, :ts, :ts)`,
        {
          username: input.owner.username.trim(),
          displayName: input.owner.displayName?.trim() || input.owner.username.trim(),
          hash: opts.ownerPasswordHash,
          roleId: roleIds.Owner,
          ts,
        },
      ).lastInsertRowid;
    }

    return {
      companyGuid,
      features,
      groupIds,
      ledgerIds,
      voucherTypeIds,
      unitIds,
      mainGodownId,
      currencyId,
      costCategoryId,
      roleIds,
      ownerUserId,
    };
  });
}

function insertPredefinedLedger(db: Db, l: PredefinedLedger, groupId: number, features: Pick<CompanyFeatures, 'gst'>, ts: string): number {
  const isTax = Boolean(l.dutyHead);
  const isTrading = l.code === 'SALES' || l.code === 'PURCHASE';
  return db.run(
    `INSERT INTO ledgers (guid, name, group_id, reserved_code, is_predefined, inventory_values_affected,
                          tax_type, gst_duty_head, gst_tax_direction, gst_applicable, gst_taxability, created_at, updated_at)
     VALUES (:guid, :name, :groupId, :code, 1, :inv, :taxType, :duty, :dir, :gstApplicable, :taxability, :ts, :ts)`,
    {
      guid: randomUUID(),
      name: l.name,
      groupId,
      code: l.code,
      inv: isTrading,
      taxType: isTax ? 'GST' : null,
      duty: l.dutyHead ?? null,
      dir: l.direction ?? null,
      // Sales/Purchase ledgers are taxable supplies by default; the rate comes from items (or line overrides).
      gstApplicable: isTrading && features.gst ? 'applicable' : 'not_applicable',
      taxability: isTrading && features.gst ? 'taxable' : null,
      ts,
    },
  ).lastInsertRowid;
}

/**
 * Create any missing GST tax ledgers (Output/Input/RCM × IGST/CGST/SGST/Cess). Idempotent by
 * reserved_code. If a user-created ledger already uses the standard name under Duties & Taxes it is
 * adopted (reserved code + tax fields set); otherwise a free name is chosen. Returns all GST ledger ids.
 */
export function ensureGstLedgers(db: Db, ts: string): Partial<Record<LedgerCode, number>> {
  return db.transaction(() => {
    const out: Partial<Record<LedgerCode, number>> = {};
    const dutiesGroupId = db.value<number>(`SELECT id FROM groups WHERE reserved_code = 'DUTIES_TAXES'`);
    if (dutiesGroupId === undefined) throw new AppError('INTERNAL', 'Duties & Taxes group is missing');
    for (const l of PREDEFINED_LEDGERS) {
      if (!l.gstOnly) continue;
      const existing = db.value<number>('SELECT id FROM ledgers WHERE reserved_code = :code', { code: l.code });
      if (existing !== undefined) {
        out[l.code] = existing;
        continue;
      }
      const sameName = db.get<{ id: number; group_id: number; reserved_code: string | null }>(
        'SELECT id, group_id, reserved_code FROM ledgers WHERE name = :name',
        { name: l.name },
      );
      if (sameName && sameName.group_id === dutiesGroupId && sameName.reserved_code === null) {
        db.run(
          `UPDATE ledgers SET reserved_code = :code, is_predefined = 1, tax_type = 'GST', gst_duty_head = :duty,
                  gst_tax_direction = :dir, updated_at = :ts WHERE id = :id`,
          { code: l.code, duty: l.dutyHead ?? null, dir: l.direction ?? null, ts, id: sameName.id },
        );
        out[l.code] = sameName.id;
        continue;
      }
      const ledger = sameName ? { ...l, name: freeLedgerName(db, l.name) } : l;
      out[l.code] = insertPredefinedLedger(db, ledger, dutiesGroupId, { gst: true }, ts);
    }
    return out;
  });
}

function freeLedgerName(db: Db, base: string): string {
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${base} (GST)` : `${base} (GST ${i})`;
    if (db.value('SELECT 1 FROM ledgers WHERE name = :name', { name: candidate }) === undefined) return candidate;
  }
  throw conflict(`Could not find a free name for ledger ${base}`);
}
