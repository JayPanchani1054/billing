/**
 * Read side of the vouchers module: voucher detail, Day Book style list, entry-screen context,
 * party context (balance + pending bills) and open delivery/receipt notes and orders.
 */
import type { GstDutyHead, LedgerCode, VoucherBaseType } from '../../../shared/constants.ts';
import { financialYear } from '../../../shared/dates.ts';
import { parseAmount } from '../../../shared/money.ts';
import type { GstNature, RegistrationType, SupplyKind, Taxability } from '../../../shared/types/gst.ts';
import { REGISTRATION_TYPES } from '../../../shared/gst/index.ts';
import type {
  BillAllocationView,
  BillRefType,
  ConsigneeInput,
  CostAllocationView,
  DispatchDetailsInput,
  ExportDetailsInput,
  GstLineView,
  InstrumentInput,
  InstrumentType,
  LedgerEntryRole,
  OrderDetailsInput,
  PartyContext,
  PreviewInventoryLine,
  TrackingDoc,
  TrackingKind,
  VoucherDetail,
  VoucherDetailEntry,
  VoucherEntryContext,
  VoucherListInput,
  VoucherListResult,
  VoucherListRow,
} from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound } from '../../lib/errors.ts';
import { getConfig, getFeatures } from '../company/service.ts';
import { pendingBills } from './bills.ts';
import { ledgerBalanceAsOf } from './guards.ts';
import { Masters } from './masters.ts';
import { loadVoucherType, previewNextNumber } from './numbering.ts';
import { ALLOWED_MODES } from './posting.ts';
import { loadCompanyEssentials, loadVoucherRow, modeOfRow, parseJson, parseMeta, storedInput } from './service.ts';

// ───────────────────────────── Detail ─────────────────────────────

interface EntryRow {
  id: number;
  line_no: number;
  ledger_id: number;
  ledger_name: string;
  amount: number;
  role: string;
  gst_duty_head: string | null;
  narration: string | null;
  instrument_type: string | null;
  instrument_no: string | null;
  instrument_date: string | null;
  bank_name: string | null;
  favouring: string | null;
  bank_date: string | null;
}

interface InventoryRow {
  line_no: number;
  item_id: number;
  item_name: string;
  unit: string;
  godown_id: number | null;
  godown_name: string | null;
  batch_name: string | null;
  qty: number;
  billed_qty: number | null;
  rate: number;
  discount_pct: number;
  amount: number;
  ledger_id: number | null;
  affects_stock: number;
  tracking_ref: string | null;
  order_ref: string | null;
  is_consumption: number;
  hsn_sac: string | null;
  gst_rate: number | null;
}

interface GstRow {
  line_no: number;
  source: string;
  item_id: number | null;
  ledger_id: number | null;
  description: string | null;
  hsn_sac: string | null;
  uqc: string | null;
  qty: number | null;
  supply_type: string;
  taxability: string;
  rate: number;
  cess_rate: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  is_reverse_charge: number;
  itc_eligibility: string | null;
}

export function inventoryView(db: Db, voucherId: number): PreviewInventoryLine[] {
  return db
    .all<InventoryRow>(
      `SELECT ie.line_no, ie.item_id, si.name AS item_name, u.symbol AS unit, ie.godown_id, g.name AS godown_name, ie.batch_name,
              ie.qty, ie.billed_qty, ie.rate, ie.discount_pct, ie.amount, ie.ledger_id, ie.affects_stock, ie.tracking_ref,
              ie.order_ref, ie.is_consumption, ie.hsn_sac, ie.gst_rate
         FROM inventory_entries ie
         JOIN stock_items si ON si.id = ie.item_id
         JOIN units u ON u.id = si.unit_id
         LEFT JOIN godowns g ON g.id = ie.godown_id
        WHERE ie.voucher_id = :id
        ORDER BY ie.line_no, ie.id`,
      { id: voucherId },
    )
    .map((r) => ({
      lineNo: r.line_no,
      itemId: r.item_id,
      itemName: r.item_name,
      unit: r.unit,
      godownId: r.godown_id ?? 0,
      godownName: r.godown_name ?? '',
      batchName: r.batch_name,
      qty: r.qty,
      billedQty: r.billed_qty,
      rate: r.rate,
      discountPct: r.discount_pct,
      amount: r.amount,
      ledgerId: r.ledger_id,
      affectsStock: r.affects_stock === 1,
      trackingRef: r.tracking_ref,
      orderRef: r.order_ref,
      isConsumption: r.is_consumption === 1,
      hsnSac: r.hsn_sac,
      gstRate: r.gst_rate,
    }));
}

export function gstLinesView(db: Db, voucherId: number): GstLineView[] {
  return db.all<GstRow>('SELECT * FROM gst_lines WHERE voucher_id = :id ORDER BY line_no', { id: voucherId }).map((g) => ({
    lineNo: g.line_no,
    source: g.source === 'ledger' ? 'ledger' : 'item',
    itemId: g.item_id,
    ledgerId: g.ledger_id,
    description: g.description,
    hsnSac: g.hsn_sac,
    uqc: g.uqc,
    qty: g.qty,
    supplyType: g.supply_type as SupplyKind,
    taxability: g.taxability as Taxability,
    rate: g.rate,
    cessRate: g.cess_rate,
    taxableValue: g.taxable_value,
    igst: g.igst,
    cgst: g.cgst,
    sgst: g.sgst,
    cess: g.cess,
    isReverseCharge: g.is_reverse_charge === 1,
    itcEligibility: g.itc_eligibility,
  }));
}

export function getVoucher(db: Db, id: number): VoucherDetail {
  const row = loadVoucherRow(db, id);
  if (!row) throw notFound('Voucher', id);
  const vt = loadVoucherType(db, row.voucher_type_id);
  const meta = parseMeta(row.meta);
  const partyLedgerName =
    row.party_ledger_id !== null ? (db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: row.party_ledger_id }) ?? null) : null;
  const userName = (uid: number | null): string | null =>
    uid === null ? null : (db.value<string>('SELECT display_name FROM users WHERE id = :id', { id: uid }) ?? null);

  const bills = db.all<{ ledger_entry_id: number; ref_type: string; bill_name: string | null; amount: number; credit_days: number | null; due_date: string | null }>(
    'SELECT ledger_entry_id, ref_type, bill_name, amount, credit_days, due_date FROM bill_allocations WHERE voucher_id = :id ORDER BY id',
    { id },
  );
  const costs = db.all<{ ledger_entry_id: number; cost_centre_id: number; name: string | null; amount: number }>(
    `SELECT ca.ledger_entry_id, ca.cost_centre_id, cc.name, ca.amount FROM cost_allocations ca
       LEFT JOIN cost_centres cc ON cc.id = ca.cost_centre_id WHERE ca.voucher_id = :id ORDER BY ca.id`,
    { id },
  );
  const entries: VoucherDetailEntry[] = db
    .all<EntryRow>(
      `SELECT le.id, le.line_no, le.ledger_id, l.name AS ledger_name, le.amount, le.role, le.gst_duty_head, le.narration,
              le.instrument_type, le.instrument_no, le.instrument_date, le.bank_name, le.favouring, le.bank_date
         FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
        WHERE le.voucher_id = :id ORDER BY le.line_no`,
      { id },
    )
    .map((e) => {
      const instrument: InstrumentInput | null = e.instrument_type
        ? {
            type: e.instrument_type as InstrumentType,
            ...(e.instrument_no ? { number: e.instrument_no } : {}),
            ...(e.instrument_date ? { date: e.instrument_date } : {}),
            ...(e.bank_name ? { bankName: e.bank_name } : {}),
            ...(e.favouring ? { favouring: e.favouring } : {}),
          }
        : null;
      return {
        id: e.id,
        lineNo: e.line_no,
        ledgerId: e.ledger_id,
        ledgerName: e.ledger_name,
        amount: e.amount,
        role: e.role as LedgerEntryRole,
        gstDutyHead: (e.gst_duty_head as GstDutyHead | null) ?? null,
        narration: e.narration,
        instrument,
        bankDate: e.bank_date,
        billAllocations: bills
          .filter((b) => b.ledger_entry_id === e.id)
          .map((b): BillAllocationView => ({
            refType: b.ref_type as BillRefType,
            billName: b.bill_name,
            amount: b.amount,
            creditDays: b.credit_days,
            dueDate: b.due_date,
          })),
        costAllocations: costs
          .filter((c) => c.ledger_entry_id === e.id)
          .map((c): CostAllocationView => ({ costCentreId: c.cost_centre_id, ...(c.name ? { costCentreName: c.name } : {}), amount: c.amount })),
      };
    });

  const input = { ...storedInput(db, row), id: row.id, expectedUpdatedAt: row.updated_at } as VoucherDetail['input'];
  if (row.number) input.number = row.number;

  return {
    id: row.id,
    guid: row.guid,
    voucherType: { id: vt.id, name: vt.name, baseType: vt.baseType },
    mode: modeOfRow(row),
    number: row.number,
    numberSeq: row.number_seq,
    date: row.date,
    effectiveDate: row.effective_date,
    referenceNo: row.reference_no,
    referenceDate: row.reference_date,
    partyLedgerId: row.party_ledger_id,
    partyLedgerName,
    party: {
      name: row.party_name,
      address: row.party_address,
      stateCode: row.party_state_code,
      gstin: row.party_gstin,
      registrationType: row.party_registration_type,
      pincode: row.party_pincode,
    },
    placeOfSupply: row.place_of_supply,
    priceLevelId: row.price_level_id,
    isOptional: row.is_optional === 1,
    isPostDated: row.is_post_dated === 1,
    isCancelled: row.is_cancelled === 1,
    affectsBooks: row.affects_books === 1,
    affectsStock: row.affects_stock === 1,
    isReverseCharge: row.is_reverse_charge === 1,
    narration: row.narration,
    totals: { amount: row.total_amount, taxable: row.taxable_amount, tax: row.tax_amount, roundOff: row.round_off },
    gstNature: (row.gst_nature as GstNature | null) ?? null,
    originalInvoiceNo: row.original_invoice_no,
    originalInvoiceDate: row.original_invoice_date,
    noteReason: row.note_reason,
    irn: { irn: row.irn, ackNo: row.irn_ack_no, ackDate: row.irn_ack_date, signedQr: row.irn_signed_qr, status: row.irn_status },
    ewayBill: { number: row.eway_bill_no, date: row.eway_bill_date, validUpto: row.eway_valid_upto },
    consignee: parseJson<ConsigneeInput>(row.consignee),
    dispatch: parseJson<DispatchDetailsInput>(row.dispatch),
    orderDetails: parseJson<OrderDetailsInput>(row.order_details),
    exportDetails: parseJson<ExportDetailsInput>(row.export_details),
    input,
    entries,
    inventory: inventoryView(db, id),
    gstLines: gstLinesView(db, id),
    cancellation: meta.cancelled ? { reason: meta.cancelled.reason, at: meta.cancelled.at, by: meta.cancelled.byName } : null,
    createdBy: { id: row.created_by, name: userName(row.created_by) ?? meta.createdByName ?? null },
    createdAt: row.created_at,
    updatedBy: { id: row.updated_by, name: userName(row.updated_by) ?? meta.updatedByName ?? null },
    updatedAt: row.updated_at,
  };
}

// ───────────────────────────── List ─────────────────────────────

interface ListRow {
  id: number;
  date: string;
  number: string | null;
  voucher_type_id: number;
  voucher_type_name: string;
  base_type: string;
  party_ledger_id: number | null;
  party_name: string | null;
  narration: string | null;
  total_amount: number;
  taxable_amount: number;
  tax_amount: number;
  reference_no: string | null;
  gst_nature: string | null;
  is_optional: number;
  is_cancelled: number;
  is_post_dated: number;
  irn_status: string | null;
}

export const MAX_LIST_LIMIT = 1000;

export function listVouchers(db: Db, q: VoucherListInput): VoucherListResult {
  const where: string[] = ['v.date BETWEEN :from AND :to'];
  const params: Record<string, string | number> = { from: q.from, to: q.to };
  if (q.voucherTypeIds && q.voucherTypeIds.length > 0) {
    where.push('v.voucher_type_id IN (SELECT value FROM json_each(:typeIds))');
    params.typeIds = JSON.stringify(q.voucherTypeIds);
  }
  if (q.baseTypes && q.baseTypes.length > 0) {
    where.push('v.base_type IN (SELECT value FROM json_each(:baseTypes))');
    params.baseTypes = JSON.stringify(q.baseTypes);
  }
  if (q.partyLedgerId !== undefined) {
    where.push('v.party_ledger_id = :party');
    params.party = q.partyLedgerId;
  }
  if (q.ledgerId !== undefined) {
    where.push('EXISTS (SELECT 1 FROM ledger_entries le WHERE le.voucher_id = v.id AND le.ledger_id = :ledgerId)');
    params.ledgerId = q.ledgerId;
  }
  if (q.includeOptional === false) where.push('v.is_optional = 0');
  if (q.includeCancelled === false) where.push('v.is_cancelled = 0');
  if (q.onlyPostDated === true) where.push('v.is_post_dated = 1');
  const search = q.search?.trim();
  if (search) {
    const parts = [
      "instr(lower(COALESCE(v.number, '')), :s) > 0",
      "instr(lower(COALESCE(v.reference_no, '')), :s) > 0",
      "instr(lower(COALESCE(v.narration, '')), :s) > 0",
      "instr(lower(COALESCE(v.party_name, pl.name, '')), :s) > 0",
    ];
    params.s = search.toLowerCase();
    const amount = /\d/.test(search) ? parseAmount(search) : null;
    if (amount !== null && amount !== 0) {
      parts.push('v.total_amount = :amt');
      params.amt = Math.abs(amount);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const whereSql = where.join(' AND ');
  const agg = db.get<{ n: number; total: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(v.total_amount), 0) AS total
       FROM vouchers v LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
      WHERE ${whereSql}`,
    params,
  ) ?? { n: 0, total: 0 };
  const dir = q.sort === 'date_desc' ? 'DESC' : 'ASC';
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, q.limit ?? 200));
  const offset = Math.max(0, q.offset ?? 0);
  const rows = db.all<ListRow>(
    `SELECT v.id, v.date, v.number, v.voucher_type_id, vt.name AS voucher_type_name, v.base_type, v.party_ledger_id,
            COALESCE(v.party_name, pl.name,
                     (SELECT l.name FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
                       WHERE le.voucher_id = v.id ORDER BY le.line_no LIMIT 1)) AS party_name,
            v.narration, v.total_amount, v.taxable_amount, v.tax_amount, v.reference_no, v.gst_nature,
            v.is_optional, v.is_cancelled, v.is_post_dated, v.irn_status
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
      WHERE ${whereSql}
      ORDER BY v.date ${dir}, COALESCE(v.number_seq, 0) ${dir}, v.id ${dir}
      LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset },
  );
  return {
    rows: rows.map(
      (r): VoucherListRow => ({
        id: r.id,
        date: r.date,
        number: r.number,
        voucherTypeId: r.voucher_type_id,
        voucherTypeName: r.voucher_type_name,
        baseType: r.base_type as VoucherBaseType,
        partyLedgerId: r.party_ledger_id,
        partyName: r.party_name,
        narration: r.narration,
        amount: r.total_amount,
        taxable: r.taxable_amount,
        tax: r.tax_amount,
        referenceNo: r.reference_no,
        gstNature: (r.gst_nature as GstNature | null) ?? null,
        isOptional: r.is_optional === 1,
        isCancelled: r.is_cancelled === 1,
        isPostDated: r.is_post_dated === 1,
        irnStatus: r.irn_status,
      }),
    ),
    total: agg.n,
    sums: { amount: agg.total },
  };
}

// ───────────────────────────── Entry context ─────────────────────────────

const can = (ctx: CompanyCtx, p: 'vouchers.alter' | 'vouchers.backdate' | 'vouchers.delete'): boolean =>
  ctx.session.isOwner || ctx.session.permissions.has(p);

export function entryContext(ctx: CompanyCtx, voucherTypeId: number, date: string): VoucherEntryContext {
  const { db } = ctx;
  const vt = loadVoucherType(db, voucherTypeId);
  const company = loadCompanyEssentials(db);
  const features = getFeatures(db);
  const config = getConfig(db);
  const masters = new Masters(db);
  const ledgerId = (code: LedgerCode): number | null => masters.reservedLedgerId(code);
  const heads = (prefix: 'OUTPUT' | 'INPUT' | 'RCM'): Record<GstDutyHead, number | null> => ({
    IGST: ledgerId(`${prefix}_IGST` as LedgerCode),
    CGST: ledgerId(`${prefix}_CGST` as LedgerCode),
    SGST: ledgerId(`${prefix}_SGST` as LedgerCode),
    CESS: ledgerId(`${prefix}_CESS` as LedgerCode),
  });
  const outward = ['sales', 'credit_note', 'sales_order', 'delivery_note', 'rejection_in'].includes(vt.baseType);
  const cfgDefault = typeof vt.config.defaultLedgerId === 'number' && masters.ledgerOrNull(vt.config.defaultLedgerId) ? vt.config.defaultLedgerId : null;
  const modes = [...ALLOWED_MODES[vt.baseType]].filter((m) => features.inventory || (m !== 'item_invoice' && m !== 'inventory'));
  const allowedModes = modes.length > 0 ? modes : [...ALLOWED_MODES[vt.baseType]];
  return {
    voucherType: vt,
    nextNumber: previewNextNumber(db, vt, date, company.fyStartMonth),
    allowedModes,
    defaultMode: allowedModes[0],
    today: ctx.clock.today(),
    company: {
      name: company.name,
      stateCode: company.stateCode,
      gstin: company.gstin,
      gstRegistrationType: company.gstRegistrationType,
      gstEnabled: features.gst && company.gstRegistrationType !== 'unregistered',
      booksFrom: company.booksFrom,
      fyStartMonth: company.fyStartMonth,
      financialYear: financialYear(date, company.fyStartMonth),
    },
    features,
    config: {
      roundOff: config.roundOff,
      guards: config.guards,
      lockedUpTo: config.lockedUpTo,
      gst: config.gst,
      printAfterSave: config.invoice.printAfterSave || vt.printAfterSave,
    },
    ledgers: {
      cash: ledgerId('CASH'),
      sales: ledgerId('SALES'),
      purchase: ledgerId('PURCHASE'),
      roundOff: ledgerId('ROUND_OFF'),
      output: heads('OUTPUT'),
      input: heads('INPUT'),
      rcm: heads('RCM'),
    },
    defaultLedgerId: cfgDefault ?? ledgerId(outward ? 'SALES' : 'PURCHASE'),
    mainGodownId: masters.mainGodownId(),
    permissions: { canAlter: can(ctx, 'vouchers.alter'), canBackdate: can(ctx, 'vouchers.backdate'), canDelete: can(ctx, 'vouchers.delete') },
  };
}

// ───────────────────────────── Party context ─────────────────────────────

export function partyContext(ctx: CompanyCtx, ledgerId: number, date: string, excludeVoucherId?: number | null): PartyContext {
  const { db } = ctx;
  const masters = new Masters(db);
  const features = getFeatures(db);
  masters.setBillWiseFeature(features.billWise);
  const L = masters.ledger(ledgerId);
  const today = ctx.clock.today();
  const r = L.row;
  const reg = r.gst_registration_type && (REGISTRATION_TYPES as readonly string[]).includes(r.gst_registration_type) ? (r.gst_registration_type as RegistrationType) : null;
  return {
    ledgerId: L.id,
    name: L.name,
    mailingName: r.mailing_name,
    address: r.address,
    stateCode: r.state_code ?? (r.gstin && /^\d{2}/.test(r.gstin) ? r.gstin.slice(0, 2) : null),
    pincode: r.pincode,
    gstin: r.gstin,
    registrationType: reg,
    pan: r.pan,
    email: r.email,
    mobile: r.mobile,
    kind: L.isDebtor ? 'debtor' : L.isCreditor ? 'creditor' : L.isCash ? 'cash' : L.isBank ? 'bank' : 'other',
    billWise: L.billWise,
    creditDays: r.default_credit_days,
    creditLimit: r.credit_limit,
    balance: ledgerBalanceAsOf(db, L.id, date, today, excludeVoucherId ?? null),
    pendingBills: L.billWise ? pendingBills(db, L.id, date, today, excludeVoucherId ?? null) : [],
  };
}

// ───────────────────────────── Tracking (notes & orders) ─────────────────────────────

interface SourceLine {
  voucher_id: number;
  voucher_type_name: string;
  number: string | null;
  date: string;
  ref: string;
  item_id: number;
  item_name: string;
  unit: string;
  godown_id: number | null;
  batch_name: string | null;
  qty: number;
  rate: number;
  discount_pct: number;
  ledger_id: number | null;
}

const SOURCE_SQL = (refColumn: 'tracking_ref' | 'order_ref'): string =>
  `SELECT v.id AS voucher_id, vt.name AS voucher_type_name, v.number, v.date, ie.${refColumn} AS ref, ie.item_id,
          si.name AS item_name, u.symbol AS unit, ie.godown_id, ie.batch_name, ABS(ie.qty) AS qty, ie.rate, ie.discount_pct, ie.ledger_id
     FROM inventory_entries ie
     JOIN vouchers v ON v.id = ie.voucher_id
     JOIN voucher_types vt ON vt.id = v.voucher_type_id
     JOIN stock_items si ON si.id = ie.item_id
     JOIN units u ON u.id = si.unit_id
    WHERE v.base_type = :base AND v.party_ledger_id = :party AND v.is_cancelled = 0 AND v.is_optional = 0
      AND ie.${refColumn} IS NOT NULL AND v.id <> :ex
    ORDER BY v.date, v.id, ie.line_no`;

/** Static description of what consumes each kind of tracking document (no user input in SQL text). */
const TRACKING: Record<TrackingKind, { base: VoucherBaseType; column: 'tracking_ref' | 'order_ref'; consumedSql: string }> = {
  delivery: {
    base: 'delivery_note',
    column: 'tracking_ref',
    consumedSql: `SELECT ie.tracking_ref AS ref, ie.item_id, SUM(ABS(ie.qty)) AS qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
                   WHERE v.base_type = 'sales' AND v.party_ledger_id = :party AND v.is_cancelled = 0 AND v.is_optional = 0
                     AND ie.tracking_ref IS NOT NULL AND v.id <> :ex GROUP BY ie.tracking_ref, ie.item_id`,
  },
  receipt: {
    base: 'receipt_note',
    column: 'tracking_ref',
    consumedSql: `SELECT ie.tracking_ref AS ref, ie.item_id, SUM(ABS(ie.qty)) AS qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
                   WHERE v.base_type = 'purchase' AND v.party_ledger_id = :party AND v.is_cancelled = 0 AND v.is_optional = 0
                     AND ie.tracking_ref IS NOT NULL AND v.id <> :ex GROUP BY ie.tracking_ref, ie.item_id`,
  },
  sales_order: {
    base: 'sales_order',
    column: 'order_ref',
    consumedSql: `SELECT ie.order_ref AS ref, ie.item_id, SUM(ABS(ie.qty)) AS qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
                   WHERE v.party_ledger_id = :party AND v.is_cancelled = 0 AND v.is_optional = 0 AND ie.order_ref IS NOT NULL AND v.id <> :ex
                     AND (v.base_type = 'delivery_note' OR (v.base_type = 'sales' AND ie.tracking_ref IS NULL))
                   GROUP BY ie.order_ref, ie.item_id`,
  },
  purchase_order: {
    base: 'purchase_order',
    column: 'order_ref',
    consumedSql: `SELECT ie.order_ref AS ref, ie.item_id, SUM(ABS(ie.qty)) AS qty FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
                   WHERE v.party_ledger_id = :party AND v.is_cancelled = 0 AND v.is_optional = 0 AND ie.order_ref IS NOT NULL AND v.id <> :ex
                     AND (v.base_type = 'receipt_note' OR (v.base_type = 'purchase' AND ie.tracking_ref IS NULL))
                   GROUP BY ie.order_ref, ie.item_id`,
  },
};

/** Open delivery/receipt notes or orders of a party with pending quantities (FIFO over the document's lines). */
export function trackingRefs(db: Db, partyLedgerId: number, kind: TrackingKind, excludeVoucherId?: number | null): TrackingDoc[] {
  const spec = TRACKING[kind];
  const ex = excludeVoucherId ?? 0;
  const lines = db.all<SourceLine>(SOURCE_SQL(spec.column), { base: spec.base, party: partyLedgerId, ex });
  const consumed = new Map<string, number>();
  for (const c of db.all<{ ref: string; item_id: number; qty: number }>(spec.consumedSql, { party: partyLedgerId, ex })) {
    consumed.set(`${c.ref}|${c.item_id}`, c.qty);
  }
  const docs = new Map<number, TrackingDoc>();
  for (const l of lines) {
    const key = `${l.ref}|${l.item_id}`;
    const left = consumed.get(key) ?? 0;
    const take = Math.min(left, l.qty);
    consumed.set(key, left - take);
    const pendingQty = Math.round((l.qty - take) * 1e6) / 1e6;
    let doc = docs.get(l.voucher_id);
    if (!doc) {
      doc = { voucherId: l.voucher_id, voucherTypeName: l.voucher_type_name, number: l.number, date: l.date, ref: l.ref, lines: [] };
      docs.set(l.voucher_id, doc);
    }
    doc.lines.push({
      itemId: l.item_id,
      itemName: l.item_name,
      unit: l.unit,
      godownId: l.godown_id,
      batchName: l.batch_name,
      qty: l.qty,
      pendingQty,
      rate: l.rate,
      discountPct: l.discount_pct,
      ledgerId: l.ledger_id,
    });
  }
  return [...docs.values()].filter((d) => d.lines.some((l) => l.pendingQty > 0));
}
