/**
 * Counter lookups: scan-to-add (barcode / part no. / alias / exact name → one stock item with its
 * price, price-level slabs, MRP and stock) and customers by mobile number (find, or create with name +
 * mobile + state only).
 */
import { getState } from '../../../shared/gst/states.ts';
import type { PosCustomer, PosCustomerCreateInput, PosItem, PosItemLookupInput, PosItemLookupResult } from '../../../shared/types/pos.ts';
import { normalizeMobile } from '../../../shared/validators.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { conflict, validation } from '../../lib/errors.ts';
import { saveLedger } from '../accounts/ledgers.ts';
import { getFeatures } from '../company/service.ts';
import { applicableSlabs } from '../inventory/prices.ts';
import { stockQtyAsOf } from '../vouchers/guards.ts';
import { assertPosEnabled } from './store.ts';

interface ItemDbRow {
  id: number;
  name: string;
  barcode: string | null;
  part_no: string | null;
  unit_symbol: string;
  unit_decimals: number;
  mrp: number | null;
  selling_price: number | null;
  rate_inclusive_of_tax: number;
  gst_rate: number | null;
  is_service: number;
  maintain_batches: number;
}

type MatchKind = PosItem['matchedBy'];

/** Exact matches, most specific first: barcode, part number, alias (any), name. Active items only. */
const MATCHERS: ReadonlyArray<{ kind: MatchKind; sql: string }> = [
  { kind: 'barcode', sql: 'SELECT id, name FROM stock_items WHERE barcode = :code AND is_active = 1 ORDER BY name LIMIT 20' },
  { kind: 'part_no', sql: 'SELECT id, name FROM stock_items WHERE part_no = :code COLLATE NOCASE AND is_active = 1 ORDER BY name LIMIT 20' },
  {
    kind: 'alias',
    sql: `SELECT id, name FROM stock_items
           WHERE is_active = 1 AND (alias = :code COLLATE NOCASE OR id IN (SELECT item_id FROM stock_item_aliases WHERE alias = :code COLLATE NOCASE))
           ORDER BY name LIMIT 20`,
  },
  { kind: 'name', sql: 'SELECT id, name FROM stock_items WHERE name = :code COLLATE NOCASE AND is_active = 1 LIMIT 20' },
];

function mainGodownId(db: Db): number {
  return db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ?? 0;
}

export function loadPosItem(db: Db, itemId: number, matchedBy: MatchKind, opts: { date: string; today: string; priceLevelId?: number; godownId?: number }): PosItem | null {
  const r = db.get<ItemDbRow>(
    `SELECT si.id, si.name, si.barcode, si.part_no, u.symbol AS unit_symbol, u.decimal_places AS unit_decimals, si.mrp, si.selling_price,
            si.rate_inclusive_of_tax, si.gst_rate, si.is_service, si.maintain_batches
       FROM stock_items si JOIN units u ON u.id = si.unit_id WHERE si.id = :id`,
    { id: itemId },
  );
  if (!r) return null;
  const features = getFeatures(db);
  const slabs =
    features.priceLevels && opts.priceLevelId !== undefined
      ? (applicableSlabs(db, opts.priceLevelId, opts.date, [itemId]).get(itemId)?.slabs ?? []).map((s) => ({ qtyFrom: s.qtyFrom, qtyTo: s.qtyTo, rate: s.rate, discountPct: s.discountPct }))
      : [];
  const godownId = opts.godownId ?? mainGodownId(db);
  const service = r.is_service === 1;
  return {
    itemId: r.id,
    name: r.name,
    matchedBy,
    barcode: r.barcode,
    partNo: r.part_no,
    unit: r.unit_symbol,
    unitDecimals: r.unit_decimals,
    mrp: r.mrp !== null && r.mrp > 0 ? r.mrp : null,
    sellingRate: Number(r.selling_price ?? 0) / 100,
    slabs,
    rateInclusiveOfTax: r.rate_inclusive_of_tax === 1,
    gstRate: r.gst_rate,
    isService: service,
    maintainBatches: features.batches && r.maintain_batches === 1,
    stock: service ? null : stockQtyAsOf(db, { itemId: r.id, godownId, date: opts.date, today: opts.today, excludeVoucherId: null }),
  };
}

/** Scan-to-add: what the scanner (or the cashier) typed, matched exactly. */
export function lookupItem(db: Db, input: PosItemLookupInput, today: string): PosItemLookupResult {
  assertPosEnabled(db);
  const code = input.code.trim();
  if (code === '') return { item: null, candidates: [] };
  for (const m of MATCHERS) {
    const rows = db.all<{ id: number; name: string }>(m.sql, { code });
    if (rows.length === 0) continue;
    if (rows.length === 1) {
      return { item: loadPosItem(db, rows[0].id, m.kind, { date: input.date, today, priceLevelId: input.priceLevelId, godownId: input.godownId }), candidates: [] };
    }
    return { item: null, candidates: rows.map((r) => ({ itemId: r.id, name: r.name, matchedBy: m.kind })) };
  }
  return { item: null, candidates: [] };
}

// ───────────────────────────── Customers ─────────────────────────────

/** Digits of a stored mobile (spaces, dashes, brackets, + removed), last 10 — SQL side. */
const MOBILE_DIGITS = `substr(replace(replace(replace(replace(replace(l.mobile, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), -10)`;

export function findCustomers(db: Db, mobile: string): PosCustomer[] {
  assertPosEnabled(db);
  const m = normalizeMobile(mobile);
  if (!m) return [];
  return db
    .all<{ id: number; name: string; mobile: string | null; state_code: string | null; gstin: string | null; group_name: string }>(
      `SELECT l.id, l.name, l.mobile, l.state_code, l.gstin, g.name AS group_name
         FROM ledgers l JOIN groups g ON g.id = l.group_id
        WHERE l.mobile IS NOT NULL AND l.is_active = 1 AND ${MOBILE_DIGITS} = :m
        ORDER BY l.name LIMIT 20`,
      { m },
    )
    .map((r) => ({ ledgerId: r.id, name: r.name, mobile: r.mobile, stateCode: r.state_code, gstin: r.gstin, groupName: r.group_name }));
}

/**
 * Create a customer from the counter: name + mobile + state only, under Sundry Debtors, registration
 * type Consumer (unregistered end customer, B2C). Goes through the ledger master service (validated, audited). A name already used gets
 * the mobile number appended; a mobile already on a customer is refused (choose that customer).
 */
export function createCustomer(ctx: CompanyCtx, input: PosCustomerCreateInput): PosCustomer {
  const { db } = ctx;
  assertPosEnabled(db);
  const mobile = normalizeMobile(input.mobile);
  if (!mobile) throw validation([{ path: 'mobile', message: 'Mobile number must be 10 digits starting with 6, 7, 8 or 9 (optionally with +91).' }]);
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name === '') throw validation([{ path: 'name', message: "Enter the customer's name." }]);
  const companyState = db.value<string | null>('SELECT state_code FROM company WHERE id = 1') ?? null;
  const stateCode = (input.stateCode ?? '').trim() || companyState;
  if (stateCode && !getState(stateCode)) throw validation([{ path: 'stateCode', message: 'Choose a valid state.' }]);
  const existing = findCustomers(db, mobile)[0];
  if (existing) throw conflict(`${existing.name} already has mobile ${mobile}. Choose that customer instead of creating a new one.`, [{ path: 'mobile', message: `Already used by ${existing.name}` }]);
  const taken = (n: string): boolean =>
    db.value('SELECT 1 FROM ledgers WHERE name = :n COLLATE NOCASE UNION ALL SELECT 1 FROM groups WHERE name = :n COLLATE NOCASE LIMIT 1', { n }) !== undefined;
  let finalName = name;
  if (taken(finalName)) finalName = `${name} (${mobile})`;
  for (let i = 2; taken(finalName) && i < 100; i++) finalName = `${name} (${mobile}) ${i}`;
  const groupId = db.value<number>(`SELECT id FROM groups WHERE reserved_code = 'SUNDRY_DEBTORS'`);
  if (groupId === undefined) throw validation([{ path: 'name', message: 'The Sundry Debtors group is missing.' }]);
  const saved = saveLedger(ctx, {
    name: finalName,
    groupId,
    mobile,
    stateCode: stateCode ?? null,
    country: 'India',
    registrationType: 'consumer',
  });
  return { ledgerId: saved.id, name: saved.name, mobile: saved.mobile, stateCode: saved.stateCode, gstin: saved.gstin, groupName: saved.groupName };
}
