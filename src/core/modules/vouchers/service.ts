/**
 * Voucher lifecycle: preview, save (create/alter), delete, cancel, optional ↔ regular, duplicate.
 * Every mutation runs inside the route's transaction: header + child rows + numbering + audit commit
 * together or not at all.
 */
import { randomUUID } from 'node:crypto';
import type { Permission } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import type { CompanyRegistrationType } from '../../../shared/types/gst.ts';
import type {
  ItemLineInput,
  LedgerLineInput,
  VoucherInput,
  VoucherMode,
  VoucherPreview,
  VoucherRuleErrorDetails,
  VoucherSaveResult,
  VoucherWarning,
} from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { conflict, forbidden, notFound, rule } from '../../lib/errors.ts';
import { assertDateUnlocked, getConfig, getFeatures } from '../company/service.ts';
import {
  allocateNextNumber,
  decideNumber,
  loadVoucherType,
  previewNextNumber,
  type VoucherTypeInfo,
} from './numbering.ts';
import {
  buildPosting,
  isAccountingBase,
  previewEntries,
  previewGstLines,
  previewInventory,
  txt,
  type CompanyEssentials,
  type PostingEnv,
  type PostingPlan,
} from './posting.ts';

// ───────────────────────────── Rows & helpers ─────────────────────────────

export interface VoucherRow {
  id: number;
  guid: string;
  voucher_type_id: number;
  base_type: string;
  number: string | null;
  number_seq: number | null;
  date: string;
  effective_date: string | null;
  reference_no: string | null;
  reference_date: string | null;
  party_ledger_id: number | null;
  party_name: string | null;
  party_address: string | null;
  party_state_code: string | null;
  party_gstin: string | null;
  party_registration_type: string | null;
  party_pincode: string | null;
  place_of_supply: string | null;
  invoice_mode: string | null;
  price_level_id: number | null;
  is_optional: number;
  is_post_dated: number;
  is_cancelled: number;
  affects_books: number;
  affects_stock: number;
  is_reverse_charge: number;
  narration: string | null;
  total_amount: number;
  taxable_amount: number;
  tax_amount: number;
  round_off: number;
  gst_nature: string | null;
  original_invoice_no: string | null;
  original_invoice_date: string | null;
  note_reason: string | null;
  irn: string | null;
  irn_ack_no: string | null;
  irn_ack_date: string | null;
  irn_signed_qr: string | null;
  irn_status: string | null;
  eway_bill_no: string | null;
  eway_bill_date: string | null;
  eway_valid_upto: string | null;
  consignee: string | null;
  dispatch: string | null;
  order_details: string | null;
  export_details: string | null;
  meta: string | null;
  created_by: number | null;
  created_at: string;
  updated_by: number | null;
  updated_at: string;
}

/** vouchers.meta JSON. */
export interface VoucherMeta {
  v: 1;
  /** The voucher as entered (normalised) — source of truth for alter / duplicate. */
  input?: VoucherInput;
  createdByName?: string | null;
  updatedByName?: string | null;
  cancelled?: { reason: string; at: string; by: number | null; byName: string | null; snapshot: unknown };
}

export function loadVoucherRow(db: Db, id: number): VoucherRow | undefined {
  return db.get<VoucherRow>('SELECT * FROM vouchers WHERE id = :id', { id });
}

export function parseMeta(raw: string | null): VoucherMeta {
  if (!raw) return { v: 1 };
  try {
    const m = JSON.parse(raw) as unknown;
    return m && typeof m === 'object' && !Array.isArray(m) ? ({ v: 1, ...(m as object) } as VoucherMeta) : { v: 1 };
  } catch {
    return { v: 1 };
  }
}

export function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const can = (ctx: CompanyCtx, p: Permission): boolean => ctx.session.isOwner || ctx.session.permissions.has(p);

export function loadCompanyEssentials(db: Db): CompanyEssentials {
  const r = db.get<{
    name: string;
    state_code: string | null;
    gstin: string | null;
    gst_registration_type: string;
    fy_start_month: number;
    books_from: string;
  }>('SELECT name, state_code, gstin, gst_registration_type, fy_start_month, books_from FROM company WHERE id = 1');
  if (!r) throw notFound('Company');
  const reg: CompanyRegistrationType =
    r.gst_registration_type === 'composition' || r.gst_registration_type === 'unregistered' ? r.gst_registration_type : 'regular';
  return { name: r.name, stateCode: r.state_code, gstin: r.gstin, gstRegistrationType: reg, fyStartMonth: r.fy_start_month, booksFrom: r.books_from };
}

export function loadEnv(ctx: CompanyCtx): PostingEnv {
  const { db } = ctx;
  return { db, today: ctx.clock.today(), features: getFeatures(db), config: getConfig(db), company: loadCompanyEssentials(db) };
}

/** Drop empty strings (→ undefined) recursively so '' never reaches the engine or the stored input. */
function stripBlanks<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripBlanks(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
      out[k] = stripBlanks(v);
    }
    return out as T;
  }
  return value;
}

export function normalizeInput(raw: VoucherInput): VoucherInput {
  const input = stripBlanks(raw);
  for (const k of ['party', 'consignee', 'dispatch', 'orderDetails', 'exportDetails'] as const) {
    const o = input[k] as object | undefined;
    if (o && Object.keys(o).length === 0) delete input[k];
  }
  return input;
}

/** Stored input of a voucher; vouchers written without one get a best-effort reconstruction. */
export function storedInput(db: Db, row: VoucherRow): VoucherInput {
  const meta = parseMeta(row.meta);
  if (meta.input) return { ...meta.input, voucherTypeId: row.voucher_type_id, date: row.date };
  const base = row.base_type as Parameters<typeof isAccountingBase>[0];
  if (isAccountingBase(base)) {
    const lines = db.all<{ ledger_id: number; amount: number; narration: string | null }>(
      'SELECT ledger_id, amount, narration FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no',
      { id: row.id },
    );
    return {
      voucherTypeId: row.voucher_type_id,
      date: row.date,
      mode: 'ledger',
      partyLedgerId: row.party_ledger_id ?? undefined,
      narration: row.narration ?? undefined,
      referenceNo: row.reference_no ?? undefined,
      ledgers: lines.map((l) => ({ ledgerId: l.ledger_id, amount: l.amount, narration: l.narration ?? undefined })),
    };
  }
  const items = db.all<{ item_id: number; godown_id: number | null; batch_name: string | null; qty: number; rate: number; amount: number; is_consumption: number }>(
    'SELECT item_id, godown_id, batch_name, qty, rate, amount, is_consumption FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no',
    { id: row.id },
  );
  return {
    voucherTypeId: row.voucher_type_id,
    date: row.date,
    mode: 'inventory',
    partyLedgerId: row.party_ledger_id ?? undefined,
    narration: row.narration ?? undefined,
    items: items.map((i) => ({
      itemId: i.item_id,
      godownId: i.godown_id ?? undefined,
      batchName: i.batch_name ?? undefined,
      qty: Math.abs(i.qty),
      rate: i.rate,
      amount: i.amount,
      isConsumption: i.is_consumption === 1 || undefined,
    })),
  };
}

export function modeOfRow(row: VoucherRow): VoucherMode {
  const meta = parseMeta(row.meta);
  if (meta.input?.mode) return meta.input.mode;
  if (row.invoice_mode === 'item') return 'item_invoice';
  if (row.invoice_mode === 'accounting') return 'accounting_invoice';
  return isAccountingBase(row.base_type as Parameters<typeof isAccountingBase>[0]) ? 'ledger' : 'inventory';
}

/** Throw when save must not proceed: blocking rule violations, or unconfirmed warnings. */
export function enforceWarnings(warnings: readonly VoucherWarning[], acknowledged: boolean): void {
  const blocking = warnings.filter((w) => w.blocking);
  if (blocking.length > 0) {
    const more = blocking.length > 1 ? ` (and ${blocking.length - 1} more problem${blocking.length > 2 ? 's' : ''})` : '';
    const details: VoucherRuleErrorDetails = { warnings: [...warnings] };
    throw rule(`${blocking[0].message}${more}`, details);
  }
  if (warnings.length > 0 && !acknowledged) {
    const msg =
      warnings.length === 1 ? `Please confirm: ${warnings[0].message}` : `Please confirm ${warnings.length} warnings. ${warnings[0].message} …`;
    const details: VoucherRuleErrorDetails = { needsConfirmation: true, warnings: [...warnings] };
    throw rule(msg, details);
  }
}

// ───────────────────────────── Audit snapshots ─────────────────────────────

interface AuditSnapshot {
  type: string;
  number: string | null;
  date: string;
  party: string | null;
  amount: number;
  taxable: number;
  tax: number;
  narration: string | null;
  optional: boolean;
  postDated: boolean;
  cancelled: boolean;
  /** [ledgerId, amount] */
  entries: Array<[number, number]>;
  /** [itemId, qty, amount] */
  items: Array<[number, number, number]>;
}

export function snapshotFromDb(db: Db, row: VoucherRow, typeName: string): AuditSnapshot {
  return {
    type: typeName,
    number: row.number,
    date: row.date,
    party: row.party_name,
    amount: row.total_amount,
    taxable: row.taxable_amount,
    tax: row.tax_amount,
    narration: row.narration,
    optional: row.is_optional === 1,
    postDated: row.is_post_dated === 1,
    cancelled: row.is_cancelled === 1,
    entries: db
      .all<{ ledger_id: number; amount: number }>('SELECT ledger_id, amount FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no', { id: row.id })
      .map((e) => [e.ledger_id, e.amount]),
    items: db
      .all<{ item_id: number; qty: number; amount: number }>('SELECT item_id, qty, amount FROM inventory_entries WHERE voucher_id = :id ORDER BY line_no', { id: row.id })
      .map((i) => [i.item_id, i.qty, i.amount]),
  };
}

function snapshotFromPlan(plan: PostingPlan, input: VoucherInput): AuditSnapshot {
  return {
    type: plan.voucherType.name,
    number: plan.number,
    date: input.date,
    party: plan.header.partyName,
    amount: plan.header.totalAmount,
    taxable: plan.header.taxableAmount,
    tax: plan.header.taxAmount,
    narration: txt(input.narration) ?? null,
    optional: plan.header.isOptional,
    postDated: plan.header.isPostDated,
    cancelled: false,
    entries: plan.entries.map((e) => [e.ledgerId, e.amount]),
    items: plan.inventory.map((l) => [l.itemId, l.qty, l.amount]),
  };
}

const voucherLabel = (typeName: string, number: string | null, date: string): string =>
  `${typeName} ${number ?? '(no number)'} dated ${formatDate(date)}`;

// ───────────────────────────── Preview ─────────────────────────────

export function previewVoucher(ctx: CompanyCtx, raw: VoucherInput): VoucherPreview {
  const { db } = ctx;
  const input = normalizeInput(raw);
  const env = loadEnv(ctx);
  const existing = input.id ? loadVoucherRow(db, input.id) : undefined;
  if (input.id && !existing) throw notFound('Voucher', input.id);
  const vt = loadVoucherType(db, input.voucherTypeId);
  let number: string | null;
  const typed = txt(input.number);
  if (existing) {
    number = typed && (vt.numberingMethod === 'manual' || vt.numberingMethod === 'automatic_override') ? typed : existing.number;
  } else if (vt.numberingMethod === 'manual' || (vt.numberingMethod === 'automatic_override' && typed)) {
    number = typed ?? null;
  } else if (vt.numberingMethod === 'none') {
    number = null;
  } else {
    number = previewNextNumber(db, vt, input.date, env.company.fyStartMonth) || null;
  }
  const plan = buildPosting(env, input, { voucherType: vt, number, voucherId: existing?.id ?? null });
  const locked = env.config.lockedUpTo;
  const warnings = [...plan.warnings];
  if (locked && (input.date <= locked || (existing !== undefined && existing.date <= locked))) {
    warnings.unshift({
      code: 'period_locked',
      message: `Books are locked up to ${formatDate(locked)}. Entries dated on or before this date cannot be created, altered or deleted.`,
      blocking: true,
    });
  }
  return {
    number,
    baseType: plan.baseType,
    mode: plan.mode,
    placeOfSupply: plan.header.placeOfSupply,
    gstNature: plan.header.gstNature,
    computation: plan.computation,
    entries: previewEntries(plan),
    inventory: previewInventory(plan),
    gstLines: previewGstLines(plan),
    totals: plan.totals,
    affectsBooks: plan.header.affectsBooks,
    affectsStock: plan.header.affectsStock,
    warnings,
  };
}

// ───────────────────────────── Save ─────────────────────────────

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return null;
  return JSON.stringify(v);
}

export function saveVoucher(ctx: CompanyCtx, raw: VoucherInput): VoucherSaveResult {
  const { db } = ctx;
  const input = normalizeInput(raw);
  const env = loadEnv(ctx);
  const today = env.today;

  const existing = input.id ? loadVoucherRow(db, input.id) : undefined;
  if (input.id && !existing) throw notFound('Voucher', input.id);
  if (existing && !can(ctx, 'vouchers.alter')) throw forbidden('You do not have permission to alter vouchers.');
  if (!existing && !can(ctx, 'vouchers.create')) throw forbidden('You do not have permission to create vouchers.');
  if (input.date < today && !can(ctx, 'vouchers.backdate')) {
    throw forbidden(`You do not have permission to enter vouchers dated before today (${formatDate(today)}).`);
  }
  if (existing) {
    if (existing.is_cancelled === 1) throw rule('A cancelled voucher cannot be altered.');
    if (input.expectedUpdatedAt && input.expectedUpdatedAt !== existing.updated_at) {
      throw conflict('This voucher was changed by someone else after you opened it. Reopen it to see the latest version.', {
        updatedAt: existing.updated_at,
      });
    }
    if (existing.voucher_type_id !== input.voucherTypeId) {
      throw rule('The voucher type of a saved voucher cannot be changed. Delete it and enter a new voucher instead.');
    }
    if (existing.irn_status === 'generated') {
      throw rule('An e-invoice (IRN) has been generated for this voucher. Cancel the IRN before altering it.');
    }
    assertDateUnlocked(db, existing.date);
  }
  assertDateUnlocked(db, input.date);

  const vt = loadVoucherType(db, input.voucherTypeId);
  const decision = decideNumber(db, vt, {
    date: input.date,
    fyStartMonth: env.company.fyStartMonth,
    typed: input.number,
    existing: existing ? { id: existing.id, number: existing.number, seq: existing.number_seq, date: existing.date } : null,
  });
  const plan = buildPosting(env, input, { voucherType: vt, number: decision.number, voucherId: existing?.id ?? null });
  enforceWarnings(plan.warnings, input.acknowledgeWarnings === true);

  if (decision.consume) {
    const got = allocateNextNumber(db, vt, input.date, env.company.fyStartMonth);
    if (got.number !== decision.number) throw conflict('The voucher number changed while saving. Please save again.');
  }

  const now = ctx.clock.now().toISOString();
  const userId = ctx.session.userId;
  const userName = ctx.session.displayName || ctx.session.username || null;
  const oldMeta = existing ? parseMeta(existing.meta) : null;
  const meta: VoucherMeta = {
    v: 1,
    input: plan.normalizedInput,
    createdByName: existing ? (oldMeta?.createdByName ?? null) : userName,
    updatedByName: userName,
  };
  const h = plan.header;
  const irnStatus = irnStatusFor(env, plan, existing?.irn_status ?? null);
  const exportDetails = input.exportDetails ? { ...input.exportDetails, lut: input.exportDetails.withPayment !== true } : null;
  const params = {
    voucherTypeId: vt.id,
    baseType: vt.baseType,
    number: decision.number,
    numberSeq: decision.seq,
    date: input.date,
    effectiveDate: input.effectiveDate ?? null,
    referenceNo: txt(input.referenceNo) ?? null,
    referenceDate: input.referenceDate ?? null,
    partyLedgerId: h.partyLedgerId,
    partyName: h.partyName,
    partyAddress: h.partyAddress,
    partyStateCode: h.partyStateCode,
    partyGstin: h.partyGstin,
    partyReg: h.partyRegistrationType,
    partyPincode: h.partyPincode,
    pos: h.placeOfSupply,
    invoiceMode: h.invoiceMode,
    priceLevelId: input.priceLevelId ?? null,
    isOptional: h.isOptional,
    isPostDated: h.isPostDated,
    affectsBooks: h.affectsBooks,
    affectsStock: h.affectsStock,
    isRc: h.isReverseCharge,
    narration: txt(input.narration) ?? null,
    total: h.totalAmount,
    taxable: h.taxableAmount,
    tax: h.taxAmount,
    roundOff: h.roundOff,
    nature: h.gstNature,
    origNo: txt(input.originalInvoiceNo) ?? null,
    origDate: input.originalInvoiceDate ?? null,
    noteReason: txt(input.noteReason) ?? null,
    irnStatus,
    consignee: jsonOrNull(input.consignee),
    dispatch: jsonOrNull(input.dispatch),
    orderDetails: jsonOrNull(input.orderDetails),
    exportDetails: jsonOrNull(exportDetails),
    meta: JSON.stringify(meta),
    userId,
    now,
  };

  const { voucherTypeId: _vt, baseType: _bt, ...common } = params;
  let id: number;
  let before: AuditSnapshot | null = null;
  let bankKeep: BankKeep | null = null;
  if (existing) {
    id = existing.id;
    before = snapshotFromDb(db, existing, vt.name);
    bankKeep = captureBankLinks(db, id);
    deleteChildren(db, id);
    db.run(
      `UPDATE vouchers SET number = :number, number_seq = :numberSeq, date = :date, effective_date = :effectiveDate,
              reference_no = :referenceNo, reference_date = :referenceDate, party_ledger_id = :partyLedgerId,
              party_name = :partyName, party_address = :partyAddress, party_state_code = :partyStateCode,
              party_gstin = :partyGstin, party_registration_type = :partyReg, party_pincode = :partyPincode,
              place_of_supply = :pos, invoice_mode = :invoiceMode, price_level_id = :priceLevelId,
              is_optional = :isOptional, is_post_dated = :isPostDated, affects_books = :affectsBooks,
              affects_stock = :affectsStock, is_reverse_charge = :isRc, narration = :narration,
              total_amount = :total, taxable_amount = :taxable, tax_amount = :tax, round_off = :roundOff,
              gst_nature = :nature, original_invoice_no = :origNo, original_invoice_date = :origDate,
              note_reason = :noteReason, irn_status = :irnStatus, consignee = :consignee, dispatch = :dispatch,
              order_details = :orderDetails, export_details = :exportDetails, meta = :meta,
              updated_by = :userId, updated_at = :now
        WHERE id = :id`,
      { ...common, id },
    );
  } else {
    id = db.run(
      `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, number_seq, date, effective_date, reference_no,
              reference_date, party_ledger_id, party_name, party_address, party_state_code, party_gstin,
              party_registration_type, party_pincode, place_of_supply, invoice_mode, price_level_id, is_optional,
              is_post_dated, is_cancelled, affects_books, affects_stock, is_reverse_charge, narration, total_amount,
              taxable_amount, tax_amount, round_off, gst_nature, original_invoice_no, original_invoice_date,
              note_reason, irn_status, consignee, dispatch, order_details, export_details, meta, created_by,
              created_at, updated_by, updated_at)
       VALUES (:guid, :voucherTypeId, :baseType, :number, :numberSeq, :date, :effectiveDate, :referenceNo,
              :referenceDate, :partyLedgerId, :partyName, :partyAddress, :partyStateCode, :partyGstin,
              :partyReg, :partyPincode, :pos, :invoiceMode, :priceLevelId, :isOptional,
              :isPostDated, 0, :affectsBooks, :affectsStock, :isRc, :narration, :total,
              :taxable, :tax, :roundOff, :nature, :origNo, :origDate,
              :noteReason, :irnStatus, :consignee, :dispatch, :orderDetails, :exportDetails, :meta, :userId,
              :now, :userId, :now)`,
      { ...params, guid: randomUUID() },
    ).lastInsertRowid;
  }

  writeChildren(db, id, plan, input.date);
  if (bankKeep) restoreBankLinks(db, id, bankKeep);

  const guid = existing?.guid ?? db.value<string>('SELECT guid FROM vouchers WHERE id = :id', { id }) ?? '';
  ctx.audit({
    action: existing ? 'alter' : 'create',
    entityType: 'voucher',
    entityId: id,
    entityGuid: guid,
    entityLabel: voucherLabel(vt.name, decision.number, input.date),
    before: before ?? undefined,
    after: snapshotFromPlan(plan, input),
  });
  return { id, number: decision.number, warnings: plan.warnings, totals: plan.totals, updatedAt: now };
}

const IRN_NATURES: ReadonlySet<string> = new Set(['b2b', 'export_wpay', 'export_lut', 'sez_wpay', 'sez_lut', 'deemed_export']);

function irnStatusFor(env: PostingEnv, plan: PostingPlan, current: string | null): string | null {
  if (current === 'generated' || current === 'cancelled') return current;
  const eligible =
    env.features.einvoice &&
    (plan.baseType === 'sales' || plan.baseType === 'credit_note') &&
    plan.header.affectsBooks &&
    plan.header.gstNature !== null &&
    IRN_NATURES.has(plan.header.gstNature);
  return eligible ? 'pending' : null;
}

function deleteChildren(db: Db, id: number): void {
  db.run('DELETE FROM bill_allocations WHERE voucher_id = :id', { id });
  db.run('DELETE FROM cost_allocations WHERE voucher_id = :id', { id });
  db.run('DELETE FROM ledger_entries WHERE voucher_id = :id', { id });
  db.run('DELETE FROM inventory_entries WHERE voucher_id = :id', { id });
  db.run('DELETE FROM gst_lines WHERE voucher_id = :id', { id });
}

function writeChildren(db: Db, id: number, plan: PostingPlan, date: string): void {
  const books = plan.header.affectsBooks;
  const pdc = plan.header.isPostDated;
  plan.entries.forEach((e, i) => {
    const entryId = db.run(
      `INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, role, gst_duty_head, narration, instrument_type,
              instrument_no, instrument_date, bank_name, favouring, date, affects_books, is_post_dated)
       VALUES (:id, :lineNo, :ledgerId, :amount, :role, :head, :narration, :iType, :iNo, :iDate, :iBank, :iFav, :date, :books, :pdc)`,
      {
        id,
        lineNo: i + 1,
        ledgerId: e.ledgerId,
        amount: e.amount,
        role: e.role,
        head: e.gstDutyHead,
        narration: e.narration,
        iType: e.instrument?.type ?? null,
        iNo: txt(e.instrument?.number) ?? null,
        iDate: e.instrument?.date ?? null,
        iBank: txt(e.instrument?.bankName) ?? null,
        iFav: txt(e.instrument?.favouring) ?? null,
        date,
        books,
        pdc,
      },
    ).lastInsertRowid;
    for (const b of e.bills) {
      db.run(
        `INSERT INTO bill_allocations (voucher_id, ledger_entry_id, ledger_id, ref_type, bill_name, amount, credit_days, due_date,
                date, affects_books, is_post_dated)
         VALUES (:id, :entryId, :ledgerId, :refType, :billName, :amount, :days, :due, :date, :books, :pdc)`,
        { id, entryId, ledgerId: e.ledgerId, refType: b.refType, billName: b.billName, amount: b.amount, days: b.creditDays, due: b.dueDate, date, books, pdc },
      );
    }
    for (const c of e.costs) {
      db.run(
        `INSERT INTO cost_allocations (voucher_id, ledger_entry_id, ledger_id, cost_centre_id, amount, date, affects_books, is_post_dated)
         VALUES (:id, :entryId, :ledgerId, :centre, :amount, :date, :books, :pdc)`,
        { id, entryId, ledgerId: e.ledgerId, centre: c.costCentreId, amount: c.amount, date, books, pdc },
      );
    }
  });
  for (const l of plan.inventory) {
    db.run(
      `INSERT INTO inventory_entries (voucher_id, line_no, item_id, godown_id, batch_name, mfg_date, expiry_date, qty, billed_qty,
              alt_qty, rate, discount_pct, amount, ledger_id, description, hsn_sac, gst_rate, tracking_ref, order_ref,
              is_consumption, date, affects_stock, is_post_dated)
       VALUES (:id, :lineNo, :itemId, :godownId, :batch, :mfg, :expiry, :qty, :billedQty, :altQty, :rate, :disc, :amount,
              :ledgerId, :description, :hsn, :gstRate, :trackingRef, :orderRef, :consumption, :date, :stock, :pdc)`,
      {
        id,
        lineNo: l.lineNo,
        itemId: l.itemId,
        godownId: l.godownId,
        batch: l.batchName,
        mfg: l.mfgDate,
        expiry: l.expiryDate,
        qty: l.qty,
        billedQty: l.billedQty,
        altQty: l.altQty,
        rate: l.rate,
        disc: l.discountPct,
        amount: l.amount,
        ledgerId: l.ledgerId,
        description: l.description,
        hsn: l.hsnSac,
        gstRate: l.gstRate,
        trackingRef: l.trackingRef,
        orderRef: l.orderRef,
        consumption: l.isConsumption,
        date,
        stock: l.affectsStock,
        pdc,
      },
    );
  }
  plan.gstLines.forEach((g, i) => {
    db.run(
      `INSERT INTO gst_lines (voucher_id, line_no, source, item_id, ledger_id, description, hsn_sac, uqc, qty, supply_type,
              taxability, rate, cess_rate, taxable_value, igst, cgst, sgst, cess, is_reverse_charge, itc_eligibility, date,
              affects_books, is_post_dated)
       VALUES (:id, :lineNo, :source, :itemId, :ledgerId, :description, :hsn, :uqc, :qty, :supply, :taxability, :rate, :cessRate,
              :taxable, :igst, :cgst, :sgst, :cess, :rc, :itc, :date, :books, :pdc)`,
      {
        id,
        lineNo: i + 1,
        source: g.source,
        itemId: g.itemId,
        ledgerId: g.ledgerId,
        description: g.description,
        hsn: g.hsnSac,
        uqc: g.uqc,
        qty: g.qty,
        supply: g.supplyType,
        taxability: g.taxability,
        rate: g.rate,
        cessRate: g.cessRate,
        taxable: g.taxableValue,
        igst: g.igst,
        cgst: g.cgst,
        sgst: g.sgst,
        cess: g.cess,
        rc: g.isReverseCharge,
        itc: g.itcEligibility,
        date,
        books,
        pdc,
      },
    );
  });
}

// ── Bank reconciliation links survive an alter (entries are rewritten) ──

interface BankKeep {
  entries: Array<{ id: number; ledgerId: number; amount: number; bankDate: string | null }>;
  statementLines: Array<{ id: number; entryId: number }>;
}

function captureBankLinks(db: Db, voucherId: number): BankKeep {
  const entries = db
    .all<{ id: number; ledger_id: number; amount: number; bank_date: string | null }>(
      'SELECT id, ledger_id, amount, bank_date FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no',
      { id: voucherId },
    )
    .map((e) => ({ id: e.id, ledgerId: e.ledger_id, amount: e.amount, bankDate: e.bank_date }));
  const statementLines = db
    .all<{ id: number; matched_entry_id: number }>(
      `SELECT id, matched_entry_id FROM bank_statement_lines
        WHERE matched_entry_id IN (SELECT id FROM ledger_entries WHERE voucher_id = :id)`,
      { id: voucherId },
    )
    .map((s) => ({ id: s.id, entryId: s.matched_entry_id }));
  return { entries, statementLines };
}

function restoreBankLinks(db: Db, voucherId: number, keep: BankKeep): void {
  const relevant = keep.entries.filter((e) => e.bankDate !== null || keep.statementLines.some((s) => s.entryId === e.id));
  if (relevant.length === 0) return;
  const fresh = db.all<{ id: number; ledger_id: number; amount: number }>(
    'SELECT id, ledger_id, amount FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no',
    { id: voucherId },
  );
  const used = new Set<number>();
  const mapping = new Map<number, number>();
  for (const old of relevant) {
    const match = fresh.find((f) => !used.has(f.id) && f.ledger_id === old.ledgerId && f.amount === old.amount);
    if (!match) continue;
    used.add(match.id);
    mapping.set(old.id, match.id);
    if (old.bankDate) db.run('UPDATE ledger_entries SET bank_date = :d WHERE id = :id', { d: old.bankDate, id: match.id });
  }
  for (const s of keep.statementLines) {
    const target = mapping.get(s.entryId);
    if (target !== undefined) db.run('UPDATE bank_statement_lines SET matched_entry_id = :e WHERE id = :id', { e: target, id: s.id });
    else db.run(`UPDATE bank_statement_lines SET matched_entry_id = NULL, status = 'unmatched' WHERE id = :id`, { id: s.id });
  }
}

function unmatchBankLines(db: Db, voucherId: number): void {
  db.run(
    `UPDATE bank_statement_lines SET matched_entry_id = NULL, status = 'unmatched'
      WHERE matched_entry_id IN (SELECT id FROM ledger_entries WHERE voucher_id = :id)`,
    { id: voucherId },
  );
}

// ───────────────────────────── Delete / cancel ─────────────────────────────

/** Refuse when another voucher settles a bill this voucher created. */
function assertBillsNotSettled(db: Db, voucherId: number): void {
  const hit = db.get<{ bill_name: string; number: string | null; type_name: string; date: string }>(
    `SELECT ba.bill_name, v2.number, vt.name AS type_name, v2.date
       FROM bill_allocations ba
       JOIN bill_allocations ba2 ON ba2.ledger_id = ba.ledger_id AND ba2.bill_name = ba.bill_name
                                AND ba2.voucher_id <> ba.voucher_id AND ba2.ref_type = 'against'
       JOIN vouchers v2 ON v2.id = ba2.voucher_id
       JOIN voucher_types vt ON vt.id = v2.voucher_type_id
      WHERE ba.voucher_id = :id AND ba.ref_type IN ('new', 'advance')
      LIMIT 1`,
    { id: voucherId },
  );
  if (hit) {
    throw rule(
      `Bill ${hit.bill_name} of this voucher is settled by ${hit.type_name} ${hit.number ?? ''} dated ${formatDate(hit.date)}. Remove that bill allocation first.`,
    );
  }
}

/** Note base type → the invoice base type that bills it (via inventory_entries.tracking_ref). */
const BILLED_BY: Record<string, string> = {
  delivery_note: 'sales',
  receipt_note: 'purchase',
  rejection_in: 'credit_note',
  rejection_out: 'debit_note',
};

/** Refuse when invoices are tracked against this note: removing it would leave their stock unmoved. */
function assertNoteNotBilled(db: Db, row: VoucherRow): void {
  const billBase = BILLED_BY[row.base_type];
  if (!billBase || !row.number) return;
  const hit = db.get<{ number: string | null; type_name: string; date: string }>(
    `SELECT v.number, vt.name AS type_name, v.date
       FROM inventory_entries ie
       JOIN vouchers v ON v.id = ie.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE ie.tracking_ref = :ref AND v.base_type = :billBase AND v.party_ledger_id IS :party AND v.id <> :id
      LIMIT 1`,
    { ref: row.number, billBase, party: row.party_ledger_id, id: row.id },
  );
  if (hit) {
    throw rule(
      `This note has been billed in ${hit.type_name} ${hit.number ?? ''} dated ${formatDate(hit.date)}. Remove the tracking reference there first.`,
    );
  }
}

function loadForChange(ctx: CompanyCtx, id: number): { row: VoucherRow; vt: VoucherTypeInfo } {
  const row = loadVoucherRow(ctx.db, id);
  if (!row) throw notFound('Voucher', id);
  return { row, vt: loadVoucherType(ctx.db, row.voucher_type_id) };
}

export function deleteVoucher(ctx: CompanyCtx, id: number, reason?: string): { id: number; number: string | null } {
  const { db } = ctx;
  if (!can(ctx, 'vouchers.delete')) throw forbidden('You do not have permission to delete vouchers.');
  const { row, vt } = loadForChange(ctx, id);
  assertDateUnlocked(db, row.date);
  if (row.irn_status === 'generated') throw rule('An e-invoice (IRN) has been generated for this voucher. Cancel the IRN before deleting it.');
  assertBillsNotSettled(db, id);
  assertNoteNotBilled(db, row);
  const before = snapshotFromDb(db, row, vt.name);
  unmatchBankLines(db, id);
  db.run('DELETE FROM vouchers WHERE id = :id', { id });
  ctx.audit({
    action: 'delete',
    entityType: 'voucher',
    entityId: id,
    entityGuid: row.guid,
    entityLabel: voucherLabel(vt.name, row.number, row.date),
    before: { ...before, reason: txt(reason) ?? null },
  });
  return { id, number: row.number };
}

export function cancelVoucher(ctx: CompanyCtx, id: number, reason: string): { id: number; number: string | null; updatedAt: string } {
  const { db } = ctx;
  if (!can(ctx, 'vouchers.alter')) throw forbidden('You do not have permission to cancel vouchers.');
  const { row, vt } = loadForChange(ctx, id);
  if (row.is_cancelled === 1) throw rule('This voucher is already cancelled.');
  assertDateUnlocked(db, row.date);
  assertBillsNotSettled(db, id);
  assertNoteNotBilled(db, row);
  const before = snapshotFromDb(db, row, vt.name);
  const now = ctx.clock.now().toISOString();
  const meta = parseMeta(row.meta);
  meta.cancelled = {
    reason: reason.trim(),
    at: now,
    by: ctx.session.userId,
    byName: ctx.session.displayName || ctx.session.username || null,
    snapshot: before,
  };
  meta.updatedByName = ctx.session.displayName || ctx.session.username || null;
  unmatchBankLines(db, id);
  deleteChildren(db, id);
  db.run(
    `UPDATE vouchers SET is_cancelled = 1, affects_books = 0, affects_stock = 0, total_amount = 0, taxable_amount = 0,
            tax_amount = 0, round_off = 0, irn_status = CASE WHEN irn_status = 'pending' THEN NULL ELSE irn_status END,
            meta = :meta, updated_by = :userId, updated_at = :now
      WHERE id = :id`,
    { meta: JSON.stringify(meta), userId: ctx.session.userId, now, id },
  );
  const after = loadVoucherRow(db, id) as VoucherRow;
  ctx.audit({
    action: 'cancel',
    entityType: 'voucher',
    entityId: id,
    entityGuid: row.guid,
    entityLabel: voucherLabel(vt.name, row.number, row.date),
    before,
    after: { ...snapshotFromDb(db, after, vt.name), reason: reason.trim() },
  });
  return { id, number: row.number, updatedAt: now };
}

// ───────────────────────────── Optional / duplicate / number ─────────────────────────────

export function setVoucherOptional(ctx: CompanyCtx, id: number, optional: boolean, acknowledgeWarnings = false): VoucherSaveResult {
  const { row } = loadForChange(ctx, id);
  if (row.is_cancelled === 1) throw rule('A cancelled voucher cannot be changed.');
  const input = storedInput(ctx.db, row);
  return saveVoucher(ctx, {
    ...input,
    id,
    number: row.number ?? undefined,
    isOptional: optional,
    acknowledgeWarnings,
  });
}

export function duplicateVoucher(ctx: CompanyCtx, id: number): VoucherInput {
  const { row } = loadForChange(ctx, id);
  const src = storedInput(ctx.db, row);
  const out: VoucherInput = { ...src, date: ctx.clock.today() };
  delete out.id;
  delete out.number;
  delete out.expectedUpdatedAt;
  delete out.acknowledgeWarnings;
  delete out.effectiveDate;
  delete out.partyBillAllocations;
  if (row.base_type === 'purchase') {
    delete out.referenceNo;
    delete out.referenceDate;
  }
  if (out.ledgers) {
    out.ledgers = out.ledgers.map((l): LedgerLineInput => {
      const copy = { ...l };
      delete copy.billAllocations;
      return copy;
    });
  }
  if (out.items) {
    out.items = out.items.map((it): ItemLineInput => {
      const copy = { ...it };
      delete copy.trackingRef;
      delete copy.orderRef;
      return copy;
    });
  }
  return out;
}

export function nextVoucherNumber(ctx: CompanyCtx, voucherTypeId: number, date: string): string {
  const vt = loadVoucherType(ctx.db, voucherTypeId);
  const fyStartMonth = loadCompanyEssentials(ctx.db).fyStartMonth;
  return previewNextNumber(ctx.db, vt, date, fyStartMonth);
}
