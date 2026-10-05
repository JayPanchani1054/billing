/**
 * Test fixtures: an in-memory company with all seeded masters, a fixed clock and a ready CompanyCtx.
 *
 *   import { createTestCompany } from '../../testing/fixtures.ts';
 *
 *   const t = createTestCompany({ gst: true, stateCode: '27', today: '2026-04-15' });
 *   const party = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('29') });
 *   const item  = t.addStockItem({ name: 'Widget', unit: 'Nos', gstRate: 18, hsnSac: '8471', openingQty: 10, openingRate: 100 });
 *   saveVoucher(t.ctx, { … ledgerId: t.ids.ledgers.SALES … });
 *   const res = await t.call(myRoutes, 'vouchers.save', input);     // through the real dispatcher
 *   t.close();
 *
 * Conventions: money arguments are integer paise (openingBalance, sellingPrice, …); rates are rupees
 * per unit (openingRate) like the vouchers schema. `ids.*` maps throw on unknown keys, so a typo or
 * a GST ledger requested from a non-GST company fails loudly instead of yielding undefined.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApiResult } from '../../shared/api.ts';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  type GroupCode,
  type LedgerCode,
  type Permission,
  type VoucherBaseType,
} from '../../shared/constants.ts';
import { financialYear } from '../../shared/dates.ts';
import { lineAmount } from '../../shared/money.ts';
import type { CompanyFeatures } from '../../shared/settings.ts';
import type { CreateCompanyInput } from '../../shared/types/app.ts';
import type { AppRuntime, CompanyCtx, OpenCompanyInfo, Session } from '../api/context.ts';
import { createDispatcher } from '../api/dispatch.ts';
import type { RouteMap } from '../api/route.ts';
import { fixedClock, type FixedClock } from '../app/clock.ts';
import { buildSession, implicitSession } from '../app/auth.ts';
import { Db, type BindValue } from '../db/db.ts';
import { migrate } from '../db/migrate.ts';
import { seedCompany } from '../db/seed.ts';
import { appendAudit } from '../lib/audit.ts';
import { hashPasswordSync } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';
import { getFeatures } from '../modules/company/service.ts';

/** Password of the Owner user created by `createTestCompany({ security: true })`. */
export const TEST_OWNER_PASSWORD = 'Owner@1234';
export const TEST_OWNER_USERNAME = 'owner';
/** PAN used for generated GSTINs (a valid-looking firm PAN). */
export const TEST_PAN = 'AAPFU0939F';

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Build a checksum-valid GSTIN for a state: makeGstin('29') → '29AAPFU0939F1Z?'.
 * Vary `pan` or `entity` to get distinct parties in the same state.
 */
export function makeGstin(stateCode: string, pan = TEST_PAN, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z$/.test(first14)) throw new Error(`makeGstin: bad inputs ${first14}`);
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARSET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return first14 + GSTIN_CHARSET[(36 - (sum % 36)) % 36];
}

/** Distinct test PAN from an index: testPan(1) → 'AAAPA0001A'. */
export function testPan(n: number): string {
  return `AAAPA${String(n % 10_000).padStart(4, '0')}A`;
}

export interface TestCompanyOptions {
  /** GST registered with GST feature on (default true). false → unregistered company. */
  gst?: boolean;
  /** Company state (default '27' Maharashtra). */
  stateCode?: string;
  /** Turn on security with an Owner user (TEST_OWNER_USERNAME / TEST_OWNER_PASSWORD); ctx.session is that user. */
  security?: boolean;
  features?: Partial<CompanyFeatures>;
  /** Working date (default '2026-04-15'). */
  today?: string;
  /** Books beginning (default: start of the financial year containing `today`). */
  booksFrom?: string;
  registrationType?: 'regular' | 'composition' | 'unregistered';
  name?: string;
}

export interface TestIds {
  groups: Record<GroupCode, number>;
  /** GST ledgers exist only when GST is on; accessing a missing one throws. */
  ledgers: Record<LedgerCode, number>;
  /** Predefined voucher type id by base type. */
  voucherTypes: Record<VoucherBaseType, number>;
  /** Unit id by symbol ('Nos', 'Kg', …). */
  units: Record<string, number>;
  /** Role id by name ('Owner', 'Accountant', 'Data Entry', 'Auditor'). */
  roles: Record<string, number>;
  mainGodownId: number;
  currencyId: number;
  costCategoryId: number;
  ownerUserId: number | null;
}

export type PartyRegistrationType = 'regular' | 'composition' | 'unregistered' | 'consumer' | 'sez' | 'overseas' | 'deemed_export' | 'uin';
export type Taxability = 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';

export interface TestLedgerSpec {
  name: string;
  group: GroupCode;
  alias?: string;
  /** Paise, Dr +, Cr − (as at books beginning). */
  openingBalance?: number;
  /** Opening bill-wise detail (amount in paise, Dr +, Cr −). */
  openingBills?: Array<{ name: string; date: string; amount: number; dueDate?: string }>;
  // Party
  gstin?: string;
  /** Defaults to the GSTIN's state, else the company's state. */
  stateCode?: string;
  /** Defaults to 'regular' with a GSTIN, else 'unregistered' (party groups only). */
  registrationType?: PartyRegistrationType;
  /** Defaults to true for Sundry Debtors/Creditors when the billWise feature is on. */
  billWise?: boolean;
  creditDays?: number;
  /** Paise. */
  creditLimit?: number;
  address?: string;
  pan?: string;
  email?: string;
  mobile?: string;
  // Sales/purchase/income/expense GST details
  gstApplicable?: boolean;
  gstRate?: number;
  cessRate?: number;
  hsnSac?: string;
  taxability?: Taxability;
  supplyType?: 'goods' | 'services';
  isReverseCharge?: boolean;
  itcEligibility?: 'inputs' | 'capital_goods' | 'input_services' | 'ineligible';
  gstNatureOverride?: string;
  includeInAssessable?: 'none' | 'goods' | 'services';
  // Duties & taxes
  taxType?: 'GST' | 'TDS' | 'TCS' | 'OTHER';
  dutyHead?: 'IGST' | 'CGST' | 'SGST' | 'CESS';
  taxDirection?: 'output' | 'input' | 'rcm_liability';
  // Bank
  bank?: { accountNo?: string; ifsc?: string; bankName?: string; branch?: string; holder?: string; upiId?: string };
  costCentres?: boolean;
  inventoryAffected?: boolean;
  interestRate?: number;
  /** Raw column overrides (snake_case), applied last. Columns are checked against the schema. */
  columns?: Record<string, BindValue>;
}

export interface TestStockItemSpec {
  name: string;
  /** Unit symbol (default 'Nos'). */
  unit?: string;
  gstRate?: number;
  cessRate?: number;
  hsnSac?: string;
  taxability?: Taxability;
  groupId?: number;
  categoryId?: number;
  /** Opening quantity in the main godown (or `godownId`). */
  openingQty?: number;
  /** Opening rate in rupees per unit (opening value = qty × rate, in paise). */
  openingRate?: number;
  /** Opening value override in paise. */
  openingValue?: number;
  godownId?: number;
  batchName?: string;
  /** Paise. */
  sellingPrice?: number;
  /** Paise. */
  purchasePrice?: number;
  /** Paise. */
  mrp?: number;
  isService?: boolean;
  maintainBatches?: boolean;
  costingMethod?: 'avg_cost' | 'fifo' | 'lifo' | 'last_purchase' | 'std_cost';
  reorderLevel?: number;
  alias?: string;
  partNo?: string;
  barcode?: string;
  /** Raw column overrides (snake_case), applied last. */
  columns?: Record<string, BindValue>;
}

export interface CallOptions {
  /** Run as this session instead of t.ctx.session (see ctxAs / sessionAs). */
  session?: Session | null;
}

export interface TestCompany {
  db: Db;
  ctx: CompanyCtx;
  ids: TestIds;
  /** Working date the clock is pinned to (changes if you call clock.setToday). */
  readonly today: string;
  booksFrom: string;
  clock: FixedClock;
  /** Lines written through ctx.app.log. */
  logs: Array<{ level: string; message: string; meta?: unknown }>;
  addLedger(spec: TestLedgerSpec): number;
  addStockItem(spec: TestStockItemSpec): number;
  /** A non-owner session holding exactly these permissions (or a system role's permissions). */
  sessionAs(who: { role?: string; permissions?: readonly Permission[]; username?: string; userId?: number | null }): Session;
  /** Same ctx (same DB/clock) but with a different session. */
  ctxAs(who: { role?: string; permissions?: readonly Permission[]; username?: string }): CompanyCtx;
  /** Invoke a route through the real dispatcher (access checks, validation, transaction, error mapping). */
  call(routes: RouteMap, name: string, input?: unknown, opts?: CallOptions): Promise<ApiResult<unknown>>;
  /** Like call() but returns data and throws an AppError when the result is not ok. */
  callOk<T = unknown>(routes: RouteMap, name: string, input?: unknown, opts?: CallOptions): Promise<T>;
  close(): void;
}

/** Wrap a lookup table so reading an unknown key throws a descriptive error. */
function strict<T extends object>(label: string, target: T, hint = ''): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === 'symbol' || key in obj) return Reflect.get(obj, key, receiver);
      if (key === 'then' || key === 'toJSON' || key === 'constructor') return undefined;
      throw new Error(`Test fixture: ${label} "${String(key)}" does not exist in this company${hint}`);
    },
  });
}

export function createTestCompany(opts: TestCompanyOptions = {}): TestCompany {
  const today = opts.today ?? '2026-04-15';
  const gst = opts.gst ?? true;
  const stateCode = opts.stateCode ?? '27';
  const registrationType = opts.registrationType ?? (gst ? 'regular' : 'unregistered');
  const booksFrom = opts.booksFrom ?? financialYear(today).start;
  const clock = fixedClock(today);
  const logs: TestCompany['logs'] = [];

  const db = new Db(':memory:');
  migrate(db);

  const input: CreateCompanyInput = {
    name: opts.name ?? 'Test Traders Pvt Ltd',
    address: '12 MG Road',
    stateCode,
    pincode: '400001',
    gstRegistrationType: registrationType,
    gstin: registrationType === 'unregistered' ? undefined : makeGstin(stateCode),
    booksFrom,
    features: { ...opts.features, gst },
    owner: opts.security ? { username: TEST_OWNER_USERNAME, displayName: 'Test Owner', password: TEST_OWNER_PASSWORD } : undefined,
  };
  const seeded = seedCompany(db, input, {
    now: clock.now(),
    ownerPasswordHash: opts.security ? hashPasswordSync(TEST_OWNER_PASSWORD) : undefined,
  });

  // Lazily created temp folder for code that writes files (attachments, exports).
  let tmpRoot: string | null = null;
  const tmp = (sub: string): string => {
    if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-test-'));
    const p = path.join(tmpRoot, sub);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  const app: AppRuntime = {
    get dataDir() {
      return tmp('data');
    },
    appVersion: '0.0.0-test',
    log: (level, message, meta) => {
      logs.push({ level, message, meta });
    },
  };

  const company: OpenCompanyInfo = {
    id: 'test-company',
    get name() {
      return db.value<string>('SELECT name FROM company WHERE id = 1') ?? '';
    },
    dbPath: ':memory:',
    get dir() {
      return tmp('company');
    },
    get gstEnabled() {
      return getFeatures(db).gst;
    },
    get securityEnabled() {
      return getFeatures(db).security;
    },
  };

  const ownerSession: Session =
    opts.security && seeded.ownerUserId !== null ? buildSession(db, seeded.ownerUserId, clock.now()) : implicitSession(clock.now());

  const makeCtx = (session: Session): CompanyCtx => ({
    app,
    clock,
    session,
    company,
    db,
    audit: (entry) => {
      appendAudit(db, entry, session, clock.now());
    },
  });
  const ctx = makeCtx(ownerSession);

  const gstHint = seeded.features.gst ? '' : ' (GST is disabled, so GST ledgers are not created)';
  const ids: TestIds = {
    groups: strict('group', { ...seeded.groupIds }),
    ledgers: strict('ledger', { ...seeded.ledgerIds } as Record<LedgerCode, number>, gstHint),
    voucherTypes: strict('voucher type', { ...seeded.voucherTypeIds }),
    units: strict('unit', { ...seeded.unitIds }),
    roles: strict('role', { ...seeded.roleIds }),
    mainGodownId: seeded.mainGodownId,
    currencyId: seeded.currencyId,
    costCategoryId: seeded.costCategoryId,
    ownerUserId: seeded.ownerUserId,
  };

  const columnCache = new Map<string, Set<string>>();
  const columnsOf = (table: string): Set<string> => {
    let cols = columnCache.get(table);
    if (!cols) {
      cols = new Set(db.all<{ name: string }>(`SELECT name FROM pragma_table_info(:t)`, { t: table }).map((r) => r.name));
      columnCache.set(table, cols);
    }
    return cols;
  };

  /** Insert a row from a column → value map (column names validated against the table). */
  const insert = (table: 'ledgers' | 'stock_items', row: Record<string, BindValue>): number => {
    const cols = columnsOf(table);
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    for (const k of keys) if (!cols.has(k)) throw new Error(`Test fixture: unknown column ${table}.${k}`);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `:${k}`).join(', ')})`;
    const params: Record<string, BindValue> = {};
    for (const k of keys) params[k] = row[k];
    return db.run(sql, params).lastInsertRowid;
  };

  const ts = clock.now().toISOString();
  const PARTY_GROUPS: readonly GroupCode[] = ['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS'];
  const TRADING_GROUPS: readonly GroupCode[] = ['SALES_ACCOUNTS', 'PURCHASE_ACCOUNTS'];

  const addLedger = (spec: TestLedgerSpec): number => {
    const features = getFeatures(db);
    const isParty = PARTY_GROUPS.includes(spec.group);
    const isTrading = TRADING_GROUPS.includes(spec.group);
    const gstin = spec.gstin?.toUpperCase();
    const gstDetails =
      spec.gstApplicable ?? (spec.gstRate !== undefined || spec.taxability !== undefined || spec.hsnSac !== undefined || (isTrading && features.gst));
    const row: Record<string, BindValue> = {
      guid: randomUUID(),
      name: spec.name,
      alias: spec.alias,
      group_id: ids.groups[spec.group],
      opening_balance: spec.openingBalance ?? 0,
      maintain_bill_wise: spec.billWise ?? (isParty && features.billWise),
      default_credit_days: spec.creditDays,
      credit_limit: spec.creditLimit,
      interest_enabled: spec.interestRate !== undefined,
      interest_rate: spec.interestRate,
      cost_centres_applicable: spec.costCentres ?? false,
      inventory_values_affected: spec.inventoryAffected ?? isTrading,
      address: spec.address,
      state_code: spec.stateCode ?? (gstin ? gstin.slice(0, 2) : isParty ? stateCode : undefined),
      country: 'India',
      email: spec.email,
      mobile: spec.mobile,
      pan: spec.pan ?? (gstin ? gstin.slice(2, 12) : undefined),
      gst_registration_type: spec.registrationType ?? (isParty ? (gstin ? 'regular' : 'unregistered') : undefined),
      gstin,
      tax_type: spec.taxType ?? (spec.dutyHead ? 'GST' : undefined),
      gst_duty_head: spec.dutyHead,
      gst_tax_direction: spec.taxDirection,
      gst_applicable: gstDetails ? 'applicable' : 'not_applicable',
      gst_taxability: gstDetails ? (spec.taxability ?? 'taxable') : undefined,
      gst_rate: spec.gstRate,
      cess_rate: spec.cessRate,
      hsn_sac: spec.hsnSac,
      gst_supply_type: spec.supplyType,
      is_reverse_charge: spec.isReverseCharge ?? false,
      itc_eligibility: spec.itcEligibility,
      gst_nature_override: spec.gstNatureOverride,
      include_in_assessable: spec.includeInAssessable,
      bank_account_no: spec.bank?.accountNo,
      bank_ifsc: spec.bank?.ifsc,
      bank_name: spec.bank?.bankName,
      bank_branch: spec.bank?.branch,
      bank_account_holder: spec.bank?.holder,
      bank_upi_id: spec.bank?.upiId,
      created_at: ts,
      updated_at: ts,
      ...spec.columns,
    };
    return db.transaction(() => {
      const id = insert('ledgers', row);
      for (const b of spec.openingBills ?? []) {
        db.run(
          'INSERT INTO opening_bills (ledger_id, bill_name, bill_date, due_date, amount) VALUES (:id, :name, :date, :due, :amount)',
          { id, name: b.name, date: b.date, due: b.dueDate, amount: b.amount },
        );
      }
      if (spec.gstRate !== undefined || spec.taxability !== undefined) {
        db.run(
          `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate)
           VALUES ('ledger', :id, :from, :hsn, :tax, :rate, :cess)`,
          { id, from: booksFrom, hsn: spec.hsnSac, tax: spec.taxability ?? 'taxable', rate: spec.gstRate ?? 0, cess: spec.cessRate ?? 0 },
        );
      }
      return id;
    });
  };

  const addStockItem = (spec: TestStockItemSpec): number => {
    const unitId = ids.units[spec.unit ?? 'Nos'];
    const row: Record<string, BindValue> = {
      guid: randomUUID(),
      name: spec.name,
      alias: spec.alias,
      part_no: spec.partNo,
      barcode: spec.barcode,
      group_id: spec.groupId,
      category_id: spec.categoryId,
      unit_id: unitId,
      maintain_batches: spec.maintainBatches ?? false,
      costing_method: spec.costingMethod ?? 'avg_cost',
      is_service: spec.isService ?? false,
      gst_applicable: 'applicable',
      hsn_sac: spec.hsnSac,
      gst_taxability: spec.taxability ?? 'taxable',
      gst_rate: spec.gstRate,
      cess_rate: spec.cessRate,
      selling_price: spec.sellingPrice,
      purchase_price: spec.purchasePrice,
      mrp: spec.mrp,
      reorder_level: spec.reorderLevel,
      created_at: ts,
      updated_at: ts,
      ...spec.columns,
    };
    return db.transaction(() => {
      const id = insert('stock_items', row);
      if (spec.openingQty !== undefined && spec.openingQty !== 0) {
        const rate = spec.openingRate ?? 0;
        db.run(
          `INSERT INTO stock_openings (item_id, godown_id, batch_name, qty, rate, value)
           VALUES (:id, :godown, :batch, :qty, :rate, :value)`,
          {
            id,
            godown: spec.godownId ?? ids.mainGodownId,
            batch: spec.batchName,
            qty: spec.openingQty,
            rate,
            value: spec.openingValue ?? lineAmount(spec.openingQty, rate),
          },
        );
      }
      if (spec.gstRate !== undefined || spec.taxability !== undefined) {
        db.run(
          `INSERT INTO gst_rate_history (entity_type, entity_id, applicable_from, hsn_sac, taxability, rate, cess_rate)
           VALUES ('stock_item', :id, :from, :hsn, :tax, :rate, :cess)`,
          { id, from: booksFrom, hsn: spec.hsnSac, tax: spec.taxability ?? 'taxable', rate: spec.gstRate ?? 0, cess: spec.cessRate ?? 0 },
        );
      }
      return id;
    });
  };

  const sessionAs: TestCompany['sessionAs'] = (who) => {
    let perms: readonly Permission[] = who.permissions ?? [];
    if (who.role) {
      const role = SYSTEM_ROLES.find((r) => r.name === who.role);
      if (!role) throw new Error(`Test fixture: unknown role ${who.role}`);
      perms = role.permissions === 'all' ? PERMISSIONS : role.permissions;
    }
    const isOwner = who.role === 'Owner';
    return {
      userId: who.userId === undefined ? 9_999 : who.userId,
      username: who.username ?? (who.role ? who.role.toLowerCase().replace(/\s+/g, '') : 'tester'),
      displayName: who.username ?? who.role ?? 'Tester',
      role: who.role ?? 'Custom',
      permissions: new Set(perms),
      isOwner,
      implicit: false,
      startedAt: clock.now().toISOString(),
    };
  };

  const call: TestCompany['call'] = (routes, name, input, callOpts) => {
    const session = callOpts && 'session' in callOpts ? (callOpts.session ?? null) : ctx.session;
    const dispatcher = createDispatcher(routes, () => ({ app, clock, company, db, session }));
    return dispatcher.dispatch(name, input === undefined ? {} : input);
  };

  return {
    db,
    ctx,
    ids,
    get today() {
      return clock.today();
    },
    booksFrom,
    clock,
    logs,
    addLedger,
    addStockItem,
    sessionAs,
    ctxAs: (who) => makeCtx(sessionAs(who)),
    call,
    async callOk<T>(routes: RouteMap, name: string, input?: unknown, callOpts?: CallOptions): Promise<T> {
      const r = await call(routes, name, input, callOpts);
      if (!r.ok) throw new AppError(r.error.code, `${name}: ${r.error.message}`, r.error.details);
      return r.data as T;
    },
    close() {
      db.close();
      if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
