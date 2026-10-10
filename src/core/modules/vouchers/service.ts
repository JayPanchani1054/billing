/**
 * Voucher lifecycle: preview, save (create/alter), delete, cancel, optional ↔ regular, duplicate.
 * Every mutation runs inside the route's transaction: header + child rows + numbering + audit commit
 * together or not at all.
 */
import { randomUUID } from 'node:crypto';
import type { Permission } from '../../../shared/constants.ts';
import { addDays, diffDays, formatDate } from '../../../shared/dates.ts';
import { formatQty } from '../../../shared/format.ts';
import type { CompanyRegistrationType } from '../../../shared/types/gst.ts';
import { voucherNumberProblems } from '../../../shared/numbering.ts';
import type {
  BillAllocationInput,
  ItemLineInput,
  LedgerLineInput,
  VoucherInput,
  VoucherMode,
  VoucherNumberCheckInput,
  VoucherNumberCheckResult,
  VoucherPreview,
  VoucherRenumberInput,
  VoucherRuleErrorDetails,
  VoucherSaveResult,
  VoucherWarning,
} from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, conflict, forbidden, notFound, rule } from '../../lib/errors.ts';
import { assertDateUnlocked, getConfig, getFeatures } from '../company/service.ts';
import { composeVoucherInput, voucherHooks } from './hooks.ts';
import {
  commitNumber,
  decideNumber,
  fyRange,
  isGstNumberedType,
  isGstOutwardDocument,
  isGstSeriesOutward,
  loadVoucherType,
  numberClash,
  parseVoucherSeq,
  periodKey,
  periodKeyLabel,
  previewNextNumber,
  type NumberDecision,
  type VoucherTypeInfo,
} from './numbering.ts';
import {
  buildPosting,
  fieldError,
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

/** vouchers.backdate: needed to enter, alter, cancel or delete a voucher dated before today. */
function assertMayTouchDate(ctx: CompanyCtx, date: string, today: string, action: 'enter' | 'alter' | 'cancel' | 'delete'): void {
  if (date >= today || can(ctx, 'vouchers.backdate')) return;
  throw forbidden(
    action === 'enter'
      ? `You do not have permission to enter vouchers dated before today (${formatDate(today)}).`
      : `You do not have permission to ${action} vouchers dated before today (${formatDate(today)}); this voucher is dated ${formatDate(date)}.`,
  );
}

/** Optimistic concurrency: the caller saw `expected` (VoucherDetail.updatedAt); someone else changed it since. */
function assertFresh(row: VoucherRow, expected: string | undefined): void {
  if (expected && expected !== row.updated_at) {
    throw conflict('This voucher was changed by someone else after you opened it. Reopen it to see the latest version.', {
      updatedAt: row.updated_at,
    });
  }
}

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

/**
 * Throw when save must not proceed: blocking rule violations ('block'), or material warnings
 * ('confirm') the user has not acknowledged. Informational warnings ('info') never stop a save; they
 * come back in the save result.
 */
export function enforceWarnings(warnings: readonly VoucherWarning[], acknowledged: boolean): void {
  const blocking = warnings.filter((w) => w.level === 'block' || w.blocking);
  if (blocking.length > 0) {
    const more = blocking.length > 1 ? ` (and ${blocking.length - 1} more problem${blocking.length > 2 ? 's' : ''})` : '';
    const details: VoucherRuleErrorDetails = { warnings: [...warnings] };
    throw rule(`${blocking[0].message}${more}`, details);
  }
  const material = warnings.filter((w) => w.level === 'confirm');
  if (material.length > 0 && !acknowledged) {
    const msg =
      material.length === 1 ? `Please confirm: ${material[0].message}` : `Please confirm ${material.length} warnings. ${material[0].message} …`;
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
  partyLedgerId: number | null;
  /** Supplier invoice / reference no. */
  reference: string | null;
  gstNature: string | null;
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
  /** 2.0: an alter that changed the number (edit history "Number changed A → B — reason"). */
  numberChange?: { from: string | null; to: string | null; reason: string | null };
  /** 2.0: a voucher created with an authorised user's own number instead of the series' next one. */
  numberOverride?: { to: string | null; next: string | null; reason: string | null };
}

export function snapshotFromDb(db: Db, row: VoucherRow, typeName: string): AuditSnapshot {
  return {
    type: typeName,
    number: row.number,
    date: row.date,
    party: row.party_name,
    partyLedgerId: row.party_ledger_id,
    reference: row.reference_no,
    gstNature: row.gst_nature,
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
    partyLedgerId: plan.header.partyLedgerId,
    reference: txt(input.referenceNo) ?? null,
    gstNature: plan.header.gstNature,
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
  let input = normalizeInput(raw);
  const env = loadEnv(ctx);
  const existing = input.id ? loadVoucherRow(db, input.id) : undefined;
  if (input.id && !existing) throw notFound('Voucher', input.id);
  const vt = loadVoucherType(db, input.voucherTypeId);
  // 2.0: an authorised user's own number (checked on save) is what the preview shows.
  const override = txt(input.numberOverride?.number);
  delete input.numberOverride;
  // Extension point (hooks.ts › compose): lines derived from a module's own block (mfg journals).
  input = composeVoucherInput(env, input, vt, existing?.id ?? null);
  let number: string | null;
  const typed = txt(input.number);
  if (override && vt.numberingMethod !== 'none') {
    number = override;
  } else if (existing) {
    number = typed && (vt.numberingMethod === 'manual' || vt.numberingMethod === 'automatic_override') ? typed : existing.number;
  } else if (vt.numberingMethod === 'manual' || (vt.numberingMethod === 'automatic_override' && typed)) {
    number = typed ?? null;
  } else if (vt.numberingMethod === 'none') {
    number = null;
  } else {
    number = previewNextNumber(db, vt, input.date, env.company.fyStartMonth, isGstOutwardDocument(db, vt, env.features.gst, input)) || null;
  }
  const plan = buildPosting(env, input, { voucherType: vt, number, voucherId: existing?.id ?? null });
  runValidateHooks(ctx, input, existing ?? null, vt.baseType, plan.header.partyLedgerId);
  const locked = env.config.lockedUpTo;
  const warnings = [...plan.warnings];
  const earliest = existing !== undefined && existing.date < input.date ? existing.date : input.date;
  if (earliest < env.today && !can(ctx, 'vouchers.backdate')) {
    warnings.unshift({
      code: 'backdate_not_allowed',
      message: `You do not have permission to enter or alter vouchers dated before today (${formatDate(env.today)}). Ask an administrator, or date the voucher today.`,
      blocking: true,
      level: 'block',
      path: 'date',
    });
  }
  if (locked && (input.date <= locked || (existing !== undefined && existing.date <= locked))) {
    warnings.unshift({
      code: 'period_locked',
      message: `Books are locked up to ${formatDate(locked)}. Entries dated on or before this date cannot be created, altered or deleted.`,
      blocking: true,
      level: 'block',
      path: 'date',
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
    ...hookPreviewFields(plan),
  };
}

/** Extension point (hooks.ts › preview): extra VoucherPreview fields of other modules (e.g. `tds`). */
function hookPreviewFields(plan: PostingPlan): Partial<VoucherPreview> {
  const out: Partial<VoucherPreview> = {};
  for (const hook of voucherHooks()) if (hook.preview) Object.assign(out, hook.preview(plan.hookData.get(hook)));
  return out;
}

/** Extension point (hooks.ts › validate): hard field checks of other modules' voucher fields, before any write. */
function runValidateHooks(ctx: CompanyCtx, input: VoucherInput, existing: VoucherRow | null, baseType: VoucherRow['base_type'], partyLedgerId: number | null): void {
  for (const hook of voucherHooks()) hook.validate?.(ctx, { input, existing, baseType: baseType as Parameters<typeof isAccountingBase>[0], partyLedgerId });
}

// ───────────────────────────── Save ─────────────────────────────

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object' && Object.keys(v as object).length === 0) return null;
  return JSON.stringify(v);
}

export function saveVoucher(ctx: CompanyCtx, raw: VoucherInput): VoucherSaveResult {
  const { db } = ctx;
  let input = normalizeInput(raw);
  const env = loadEnv(ctx);
  const today = env.today;

  const existing = input.id ? loadVoucherRow(db, input.id) : undefined;
  if (input.id && !existing) throw notFound('Voucher', input.id);
  if (existing && !can(ctx, 'vouchers.alter')) throw forbidden('You do not have permission to alter vouchers.');
  if (!existing && !can(ctx, 'vouchers.create')) throw forbidden('You do not have permission to create vouchers.');
  assertMayTouchDate(ctx, input.date, today, existing ? 'alter' : 'enter');
  if (existing) {
    // Altering an earlier voucher is back-dated work even when it is moved to today.
    assertMayTouchDate(ctx, existing.date, today, 'alter');
    if (existing.is_cancelled === 1) throw rule('A cancelled voucher cannot be altered.');
    assertFresh(existing, input.expectedUpdatedAt);
    if (existing.voucher_type_id !== input.voucherTypeId) {
      throw fieldError('voucherTypeId', 'The voucher type of a saved voucher cannot be changed. Delete it and enter a new voucher instead.');
    }
    if (existing.irn_status === 'generated') {
      throw rule('An e-invoice (IRN) has been generated for this voucher. Cancel the IRN before altering it.');
    }
    assertDateUnlocked(db, existing.date);
  }
  assertDateUnlocked(db, input.date);

  const vt = loadVoucherType(db, input.voucherTypeId);
  // 2.0: an authorised user's own number. Taken out of the input: it is never stored in vouchers.meta
  // (a later alter must not apply it again) and never seen by the posting engine or the hooks.
  const numberOverride = input.numberOverride;
  delete input.numberOverride;
  // Extension point (hooks.ts › compose): lines derived from a module's own block (mfg journals).
  input = composeVoucherInput(env, input, vt, existing?.id ?? null);
  const decision = decideNumber(db, vt, {
    date: input.date,
    fyStartMonth: env.company.fyStartMonth,
    typed: input.number,
    existing: existing ? { id: existing.id, number: existing.number, seq: existing.number_seq, date: existing.date } : null,
    override: numberOverride ? { ...numberOverride, number: typeof numberOverride.number === 'string' ? numberOverride.number : '' } : undefined,
    canRenumber: can(ctx, 'vouchers.renumber'),
    gstOutward: isGstOutwardDocument(db, vt, env.features.gst, input),
    gstDoc: isGstNumberedType(vt, env.features.gst),
  });
  const notes: VoucherWarning[] = [];
  if (existing && decision.override && decision.number !== existing.number) input = keepSettledBillNames(db, existing, input, notes);
  // Extension point (hooks.ts › prepare): masters the posting needs, created in this transaction.
  for (const hook of voucherHooks()) hook.prepare?.(ctx, { env, input, voucherType: vt });
  const plan = buildPosting(env, input, { voucherType: vt, number: decision.number, voucherId: existing?.id ?? null });
  if (existing) assertAlterKeepsLinks(db, existing, plan);
  runValidateHooks(ctx, input, existing ?? null, vt.baseType, plan.header.partyLedgerId);
  enforceWarnings(plan.warnings, input.acknowledgeWarnings === true);

  // The number was found free by decideNumber inside this same (synchronous) transaction: nothing can
  // take it in between, so the counter is advanced to it without probing the series again.
  if (decision.consume && decision.seq !== null) commitNumber(db, vt, input.date, env.company.fyStartMonth, decision.seq);
  // 2.0: "Continue the series from here" — the counter moves up to the typed number (never down).
  if (decision.continueSeq !== undefined && decision.continueSeq !== null) commitNumber(db, vt, input.date, env.company.fyStartMonth, decision.continueSeq);

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
  if (bankKeep) restoreBankLinks(ctx, id, bankKeep, plan.header.affectsBooks);
  // Extension point (hooks.ts › afterSave): links / state of other modules that depend on this voucher.
  for (const hook of voucherHooks()) {
    hook.afterSave?.(ctx, {
      input: plan.normalizedInput,
      existing: existing ?? null,
      baseType: vt.baseType,
      partyLedgerId: plan.header.partyLedgerId,
      id,
      isNew: !existing,
      number: decision.number,
      affectsBooks: plan.header.affectsBooks,
      isOptional: plan.header.isOptional,
      isPostDated: plan.header.isPostDated,
    });
  }

  const guid = existing?.guid ?? db.value<string>('SELECT guid FROM vouchers WHERE id = :id', { id }) ?? '';
  ctx.audit({
    action: existing ? 'alter' : 'create',
    entityType: 'voucher',
    entityId: id,
    entityGuid: guid,
    entityLabel: voucherLabel(vt.name, decision.number, input.date),
    before: before ?? undefined,
    after: numberAudit(snapshotFromPlan(plan, input), existing ?? null, decision),
  });
  return { id, number: decision.number, warnings: notes.length > 0 ? [...plan.warnings, ...notes] : plan.warnings, totals: plan.totals, updatedAt: now };
}

/** 2.0: the edit-log image of a save records a changed number (alter) or an override (create). */
function numberAudit(after: AuditSnapshot, existing: VoucherRow | null, decision: NumberDecision): AuditSnapshot {
  if (existing && decision.number !== existing.number) {
    after.numberChange = { from: existing.number, to: decision.number, reason: decision.override?.reason ?? null };
  } else if (!existing && decision.override) {
    after.numberOverride = { to: decision.number, next: decision.override.next, reason: decision.override.reason };
  }
  return after;
}

/**
 * 2.0: an invoice's party bill is named after its number. When another voucher already settles that
 * bill ('against'), renumbering keeps the bill's name (the receipt stays matched): the party's current
 * bill-wise split is carried into the input, and an info note says so. Invoice modes only, and only when
 * the input does not give the party's bill-wise split itself.
 */
function keepSettledBillNames(db: Db, existing: VoucherRow, input: VoucherInput, notes: VoucherWarning[]): VoucherInput {
  if ((input.mode !== 'item_invoice' && input.mode !== 'accounting_invoice') || existing.party_ledger_id === null) return input;
  if (input.partyBillAllocations && input.partyBillAllocations.length > 0) return input;
  if (input.partyLedgerId !== undefined && input.partyLedgerId !== existing.party_ledger_id) return input;
  const party = existing.party_ledger_id;
  const settled = db.get<{ bill_name: string; number: string | null; type_name: string }>(
    `SELECT ba.bill_name, v2.number, vt.name AS type_name
       FROM bill_allocations ba
       JOIN bill_allocations ba2 ON ba2.ledger_id = ba.ledger_id AND ba2.bill_name = ba.bill_name
                                AND ba2.voucher_id <> ba.voucher_id AND ba2.ref_type = 'against'
       JOIN vouchers v2 ON v2.id = ba2.voucher_id
       JOIN voucher_types vt ON vt.id = v2.voucher_type_id
      WHERE ba.voucher_id = :id AND ba.ledger_id = :party AND ba.ref_type IN ('new', 'advance') AND ba.bill_name IS NOT NULL
      LIMIT 1`,
    { id: existing.id, party },
  );
  if (!settled) return input;
  const rows = db.all<{ ref_type: BillAllocationInput['refType']; bill_name: string | null; amount: number; credit_days: number | null; due_date: string | null; forex_amount: number | null }>(
    'SELECT ref_type, bill_name, amount, credit_days, due_date, forex_amount FROM bill_allocations WHERE voucher_id = :id AND ledger_id = :party ORDER BY id',
    { id: existing.id, party },
  );
  if (rows.length === 0) return input;
  const partyBillAllocations = rows.map((r): BillAllocationInput => {
    const a: BillAllocationInput = { refType: r.ref_type, amount: Math.abs(r.amount) };
    if (r.bill_name !== null) a.billName = r.bill_name;
    if (r.credit_days !== null) a.creditDays = r.credit_days;
    if (r.due_date !== null) a.dueDate = r.due_date;
    if (r.forex_amount !== null) a.forexAmount = Math.abs(r.forex_amount);
    return a;
  });
  notes.push({
    code: 'numbering',
    level: 'info',
    blocking: false,
    message: `Bill ${settled.bill_name} keeps its name because ${settled.type_name} ${settled.number ?? ''} settles it.`,
  });
  return { ...input, partyBillAllocations };
}

const IRN_NATURES: ReadonlySet<string> = new Set(['b2b', 'export_wpay', 'export_lut', 'sez_wpay', 'sez_lut', 'deemed_export']);

function irnStatusFor(env: PostingEnv, plan: PostingPlan, current: string | null): string | null {
  if (current === 'generated' || current === 'cancelled') return current;
  // IRN_NATURES are outward natures only, so a Debit Note qualifies only as a supplementary invoice
  // to a customer (a purchase return is inward).
  const eligible =
    env.features.einvoice &&
    (plan.baseType === 'sales' || plan.baseType === 'credit_note' || plan.baseType === 'debit_note') &&
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
  // Extension point (hooks.ts › clear): derived rows of other modules (rebuilt by write() on save).
  for (const hook of voucherHooks()) hook.clear?.(db, id);
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
  // Extension point (hooks.ts › write): derived per-voucher rows of other modules, same transaction.
  for (const hook of voucherHooks()) {
    hook.write?.({ db, voucherId: id, plan, date, affectsBooks: books, isPostDated: pdc, data: plan.hookData.get(hook) });
  }
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

/**
 * Re-attach bank dates and statement matches to the rewritten entries (same ledger and amount). A
 * voucher that no longer counts in the books (made optional) keeps its bank dates but its statement
 * lines go back to unmatched: a matched line must point at an entry that is in the books.
 */
function restoreBankLinks(ctx: CompanyCtx, voucherId: number, keep: BankKeep, inBooks: boolean): void {
  const { db } = ctx;
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
  // A bank date that is not carried over is cleared: one in the locked period needs period.lock.
  assertLockedBankDatesKept(
    ctx,
    relevant.filter((e) => !mapping.has(e.id)).map((e) => e.bankDate),
    'Changing the bank ledger or amount of this voucher',
  );
  for (const s of keep.statementLines) {
    const target = inBooks ? mapping.get(s.entryId) : undefined;
    if (target !== undefined) db.run('UPDATE bank_statement_lines SET matched_entry_id = :e WHERE id = :id', { e: target, id: s.id });
    else db.run(`UPDATE bank_statement_lines SET matched_entry_id = NULL, status = 'unmatched' WHERE id = :id`, { id: s.id });
  }
}

/**
 * Bank dates in the locked period (on or before F12 lockedUpTo) belong to a closed reconciliation
 * (banking/common.ts assertBankDateChangeAllowed): clearing one needs the right to lock and unlock the
 * books (period.lock; Owners always), else LOCKED. The voucher itself is then in the open period — its
 * bank date is earlier only within the early-clearing tolerance or for a cheque dated before it — so
 * the voucher lock alone does not cover it.
 */
function assertLockedBankDatesKept(ctx: CompanyCtx, cleared: ReadonlyArray<string | null>, what: string): void {
  const locked = getConfig(ctx.db).lockedUpTo;
  if (!locked || can(ctx, 'period.lock')) return;
  const hit = cleared.filter((d): d is string => d !== null && d <= locked).sort()[0];
  if (hit === undefined) return;
  throw new AppError(
    'LOCKED',
    `Books are locked up to ${formatDate(locked)}. ${what} would clear the bank date ${formatDate(hit)}, which is in the locked period (a closed reconciliation). ` +
      'Ask a user who may lock and unlock the books to do it, or unlock the period first.',
    { lockedUpTo: locked },
  );
}

/** The voucher's bank dates (cleared when it is deleted or cancelled). */
function bankDatesOf(db: Db, voucherId: number): Array<string | null> {
  return db.all<{ bank_date: string | null }>('SELECT bank_date FROM ledger_entries WHERE voucher_id = :id AND bank_date IS NOT NULL', { id: voucherId }).map((r) => r.bank_date);
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

/**
 * An alter must not orphan documents that depend on this voucher:
 *  - a bill this voucher created ('new'/'advance') that another voucher settles must still be created,
 *    with the same name, on the same ledger, by a voucher that stays in the books;
 *  - a delivery/receipt note or rejection already billed must keep its number, party and the billed
 *    items and stay regular (the invoices tracked against it do not move stock themselves).
 */
function assertAlterKeepsLinks(db: Db, existing: VoucherRow, plan: PostingPlan): void {
  const settled = db.all<{ ledger_id: number; ledger_name: string; bill_name: string; number: string | null; type_name: string; date: string }>(
    `SELECT DISTINCT ba.ledger_id, l.name AS ledger_name, ba.bill_name, v2.number, vt.name AS type_name, v2.date
       FROM bill_allocations ba
       JOIN bill_allocations ba2 ON ba2.ledger_id = ba.ledger_id AND ba2.bill_name = ba.bill_name
                                AND ba2.voucher_id <> ba.voucher_id AND ba2.ref_type = 'against'
       JOIN ledgers l ON l.id = ba.ledger_id
       JOIN vouchers v2 ON v2.id = ba2.voucher_id
       JOIN voucher_types vt ON vt.id = v2.voucher_type_id
      WHERE ba.voucher_id = :id AND ba.ref_type IN ('new', 'advance') AND ba.bill_name IS NOT NULL`,
    { id: existing.id },
  );
  for (const b of settled) {
    const kept =
      plan.header.affectsBooks &&
      plan.entries.some((e) => e.ledgerId === b.ledger_id && e.bills.some((x) => (x.refType === 'new' || x.refType === 'advance') && x.billName === b.bill_name));
    if (!kept) {
      throw rule(
        `Bill ${b.bill_name} of ${b.ledger_name} is settled by ${b.type_name} ${b.number ?? ''} dated ${formatDate(b.date)}. ` +
          'Keep the party, the bill name and the voucher regular, or remove that bill allocation first.',
      );
    }
  }

  const billBase = BILLED_BY[existing.base_type];
  if (!billBase || !existing.number) return;
  const billed = db.all<{ item_id: number; item_name: string; number: string | null; type_name: string; date: string }>(
    `SELECT ie.item_id, si.name AS item_name, v.number, vt.name AS type_name, v.date
       FROM inventory_entries ie
       JOIN vouchers v ON v.id = ie.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN stock_items si ON si.id = ie.item_id
      WHERE ie.tracking_ref = :ref AND v.base_type = :billBase AND v.party_ledger_id IS :party AND v.id <> :id AND v.is_cancelled = 0
      ORDER BY v.date, v.id`,
    { ref: existing.number, billBase, party: existing.party_ledger_id, id: existing.id },
  );
  if (billed.length === 0) return;
  const first = billed[0];
  const by = `${first.type_name} ${first.number ?? ''} dated ${formatDate(first.date)}`;
  if (plan.number !== existing.number || plan.header.partyLedgerId !== existing.party_ledger_id) {
    throw rule(`This note has been billed in ${by}. Its number and party cannot change; remove the tracking reference there first.`);
  }
  if (plan.header.isOptional) {
    throw rule(`This note has been billed in ${by} and must stay a regular voucher (the invoice does not move the stock itself).`);
  }
  const items = new Set(plan.inventory.map((l) => l.itemId));
  const missing = billed.find((b) => !items.has(b.item_id));
  if (missing) {
    throw rule(`${missing.item_name} of this note has been billed in ${missing.type_name} ${missing.number ?? ''} dated ${formatDate(missing.date)}; it cannot be removed from the note.`);
  }
  // The invoices tracked against the note do not move stock themselves: the note must still carry at
  // least the quantity they bill, or the difference would never leave (or enter) stock.
  const billedQty = db.all<{ item_id: number; item_name: string; unit: string; decimals: number; qty: number }>(
    `SELECT ie.item_id, si.name AS item_name, u.symbol AS unit, u.decimal_places AS decimals, SUM(ABS(ie.qty)) AS qty
       FROM inventory_entries ie
       JOIN vouchers v ON v.id = ie.voucher_id
       JOIN stock_items si ON si.id = ie.item_id
       JOIN units u ON u.id = si.unit_id
      WHERE ie.tracking_ref = :ref AND v.base_type = :billBase AND v.party_ledger_id IS :party AND v.id <> :id
        AND v.is_cancelled = 0 AND v.is_optional = 0
      GROUP BY ie.item_id, si.name, u.symbol, u.decimal_places`,
    { ref: existing.number, billBase, party: existing.party_ledger_id, id: existing.id },
  );
  for (const b of billedQty) {
    const onNote = plan.inventory.filter((l) => l.itemId === b.item_id).reduce((a, l) => a + Math.abs(l.qty), 0);
    if (Math.round((onNote - b.qty) * 1e6) < 0) {
      const dp = Math.max(0, Math.min(6, b.decimals | 0));
      throw rule(
        `${formatQty(b.qty, dp, b.unit)} of ${b.item_name} on this note has been billed (first in ${by}); ` +
          `the note cannot be reduced to ${formatQty(onNote, dp, b.unit)}. Reduce the tracked invoice lines first.`,
      );
    }
  }
}

function loadForChange(ctx: CompanyCtx, id: number): { row: VoucherRow; vt: VoucherTypeInfo } {
  const row = loadVoucherRow(ctx.db, id);
  if (!row) throw notFound('Voucher', id);
  return { row, vt: loadVoucherType(ctx.db, row.voucher_type_id) };
}

export function deleteVoucher(ctx: CompanyCtx, id: number, reason?: string, expectedUpdatedAt?: string): { id: number; number: string | null } {
  const { db } = ctx;
  if (!can(ctx, 'vouchers.delete')) throw forbidden('You do not have permission to delete vouchers.');
  const { row, vt } = loadForChange(ctx, id);
  assertMayTouchDate(ctx, row.date, ctx.clock.today(), 'delete');
  assertFresh(row, expectedUpdatedAt);
  assertDateUnlocked(db, row.date);
  if (row.irn_status === 'generated') throw rule('An e-invoice (IRN) has been generated for this voucher. Cancel the IRN before deleting it.');
  assertBillsNotSettled(db, id);
  assertNoteNotBilled(db, row);
  // Extension point (hooks.ts › beforeRemove): a module may refuse (e.g. a document in a filed GSTR-1).
  for (const hook of voucherHooks()) hook.beforeRemove?.(ctx, row, 'delete');
  assertLockedBankDatesKept(ctx, bankDatesOf(db, id), 'Deleting this voucher');
  const before = snapshotFromDb(db, row, vt.name);
  unmatchBankLines(db, id);
  for (const hook of voucherHooks()) hook.clear?.(db, id);
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

export function cancelVoucher(
  ctx: CompanyCtx,
  id: number,
  reason: string,
  expectedUpdatedAt?: string,
): { id: number; number: string | null; updatedAt: string } {
  const { db } = ctx;
  if (!can(ctx, 'vouchers.alter')) throw forbidden('You do not have permission to cancel vouchers.');
  const { row, vt } = loadForChange(ctx, id);
  assertMayTouchDate(ctx, row.date, ctx.clock.today(), 'cancel');
  assertFresh(row, expectedUpdatedAt);
  if (row.is_cancelled === 1) throw rule('This voucher is already cancelled.');
  assertDateUnlocked(db, row.date);
  assertBillsNotSettled(db, id);
  assertNoteNotBilled(db, row);
  for (const hook of voucherHooks()) hook.beforeRemove?.(ctx, row, 'cancel');
  assertLockedBankDatesKept(ctx, bankDatesOf(db, id), 'Cancelling this voucher');
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

export function setVoucherOptional(
  ctx: CompanyCtx,
  id: number,
  optional: boolean,
  acknowledgeWarnings = false,
  expectedUpdatedAt?: string,
): VoucherSaveResult {
  const { row } = loadForChange(ctx, id);
  if (row.is_cancelled === 1) throw rule('A cancelled voucher cannot be changed.');
  const input = storedInput(ctx.db, row);
  return saveVoucher(ctx, {
    ...input,
    id,
    number: row.number ?? undefined,
    isOptional: optional,
    acknowledgeWarnings,
    expectedUpdatedAt: expectedUpdatedAt ?? row.updated_at,
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
  // The copy is dated today, so it is not post-dated.
  delete out.isPostDated;
  if (row.base_type === 'purchase') {
    delete out.referenceNo;
    delete out.referenceDate;
  }
  // A note's original invoice is specific to that note (a copy would settle the same bill again).
  delete out.originalInvoiceNo;
  delete out.originalInvoiceDate;
  // A TDS/TCS challan is one deposit: a copy keeps the TDS choices but not the challan details.
  if (out.tds?.challan) {
    const { challan: _challan, ...rest } = out.tds;
    if (rest.natureId !== undefined || rest.overrides) out.tds = rest;
    else delete out.tds;
  }
  // A copy is a new document: not a conversion of the source's quotation, not a recurring occurrence.
  delete out.convertedFromId;
  delete out.recurring;
  // POS (pos module): a copy is a fresh bill — the tenders are paid again at the counter (exchange credit
  // and card / UPI references belong to the source), and a return copy is not tied to the source's bill.
  if (out.posBill) delete out.posBill;
  // A job work challan's return-date extension (s.143, granted by the Commissioner) belongs to that
  // challan; a copy starts without it (as the mfg screen's own duplicate does).
  if (out.stockJournal) out.stockJournal = { ...out.stockJournal, lines: out.stockJournal.lines.map(({ extendedTo: _ext, ...l }) => l) };
  // Validity (quotation / proforma) and "applicable up to" (reversing journal) keep their length from the
  // new date: a 15-day offer copied today is valid for 15 days from today (documents module).
  if (out.validUntil) out.validUntil = addDays(out.date, Math.max(0, diffDays(row.date, out.validUntil)));
  if (out.applicableUpto) out.applicableUpto = addDays(out.date, Math.max(0, diffDays(row.date, out.applicableUpto)));
  // GST details (gst module): a challan (one CPIN), a set-off, a bill of entry and the advances adjusted /
  // refunded belong to the source only; an advance's rate and a stat-adjustment nature are kept.
  if (out.gstDetails) {
    const { advance, adjustment } = out.gstDetails;
    // A Rule 37 journal's invoices belong to the source too (a copy would reverse their credit twice).
    const adj = adjustment ? (({ rule37: _rule37, ...rest }) => rest)(adjustment) : undefined;
    if (advance || adj) out.gstDetails = { ...(advance ? { advance: { ...advance } } : {}), ...(adj ? { adjustment: adj } : {}) };
    else delete out.gstDetails;
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
  return previewNextNumber(ctx.db, vt, date, fyStartMonth, isGstSeriesOutward(vt, getFeatures(ctx.db).gst));
}

// ───────────────────────────── 2.0: renumber, number check ─────────────────────────────

/**
 * 'vouchers.renumber': give a saved voucher another number from Voucher View. Re-runs the normal alter
 * (saveVoucher) with the voucher as entered (vouchers.meta) and a numberOverride, so every guard applies
 * (lock date, freshness, IRN, cancelled, back-dating, the GST filed-period confirm) and the postings are
 * rebuilt from the same input — entries, stock and GST rows are unchanged; only the number (and, unless a
 * receipt settles it, the party bill named after it) changes. Needs vouchers.alter + vouchers.renumber.
 */
export function renumberVoucher(ctx: CompanyCtx, input: VoucherRenumberInput): VoucherSaveResult {
  const { row } = loadForChange(ctx, input.id);
  if (!can(ctx, 'vouchers.renumber')) throw forbidden('Changing a voucher number needs "Change voucher numbers and the next number" (Users & Roles).');
  const meta = parseMeta(row.meta);
  if (!meta.input) {
    throw rule('This voucher was saved without its entry details (an older import). Alter the voucher (Alt+A) and change the number there.');
  }
  return saveVoucher(ctx, {
    ...storedInput(ctx.db, row),
    id: row.id,
    expectedUpdatedAt: input.expectedUpdatedAt,
    acknowledgeWarnings: input.acknowledgeWarnings === true,
    numberOverride: {
      number: input.number,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.continueSeries !== undefined ? { continueSeries: input.continueSeries } : {}),
    },
  });
}

/**
 * 'vouchers.numberCheck': can `number` be used for a voucher of the type dated `date`? The format rule of
 * a typed number (voucherNumberProblems) and the uniqueness rule the save applies to an override
 * (numbering.ts › numberClash): the financial year for an outward GST document, else the numbering
 * period. A debit note is outward only to a customer: its party comes from the input, else from the
 * voucher being altered (`excludeId`); when it is unknown both rules apply (the stricter answer).
 */
export function checkVoucherNumber(ctx: CompanyCtx, input: VoucherNumberCheckInput): VoucherNumberCheckResult {
  const { db } = ctx;
  const vt = loadVoucherType(db, input.voucherTypeId);
  const fyStartMonth = loadCompanyEssentials(db).fyStartMonth;
  const gst = getFeatures(db).gst;
  const gstDoc = isGstNumberedType(vt, gst);
  const number = input.number.trim();
  const problems = voucherNumberProblems(number, gstDoc);
  const exclude = input.excludeId ?? null;
  let outward: boolean[];
  if (!gstDoc) outward = [false];
  else if (vt.baseType !== 'debit_note') outward = [true];
  else {
    const own = exclude !== null ? loadVoucherRow(db, exclude) : undefined;
    const partyLedgerId = input.partyLedgerId ?? own?.party_ledger_id ?? undefined;
    const mode = input.mode ?? (own ? modeOfRow(own) : undefined);
    outward = partyLedgerId !== undefined && mode !== undefined ? [isGstOutwardDocument(db, vt, gst, { mode, partyLedgerId })] : [true, false];
  }
  const periodLabel = periodKeyLabel(vt.numberingRestart, periodKey(vt, input.date, fyStartMonth));
  let scopeLabel = outward[0] ? `FY ${fyRange(input.date, fyStartMonth).label}` : periodLabel;
  let taken = false;
  for (const gstOutward of number === '' ? [] : outward) {
    const clash = numberClash(db, vt, number, input.date, fyStartMonth, exclude, { gstOutward, always: true });
    if (clash) {
      taken = true;
      scopeLabel = clash.scope === 'fy' ? `FY ${clash.fyLabel}` : periodLabel;
      break;
    }
  }
  return {
    ok: problems.length === 0 && !taken,
    taken,
    problems,
    seq: number === '' ? null : parseVoucherSeq(vt, number, input.date, fyStartMonth),
    scopeLabel,
  };
}
