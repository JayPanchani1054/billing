/**
 * The voucher posting engine: VoucherInput → PostingPlan (ledger entries, inventory entries, bill & cost
 * allocations, gst_lines, totals, header fields, warnings). ONE code path shared by 'vouchers.preview'
 * and 'vouchers.save'; it reads the database (masters, balances, pending bills) but never writes.
 *
 * Sign convention: Debit +, Credit −; Σ entries = 0 exactly (asserted). Posting tables: README.md.
 */
import {
  ACCOUNTING_BASE_TYPES,
  GST_BASE_TYPES,
  type GstDutyHead,
  type LedgerCode,
  type VoucherBaseType,
} from '../../../shared/constants.ts';
import { addDays, formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { computeInvoice, isRegisteredParty, REGISTRATION_TYPES } from '../../../shared/gst/index.ts';
import { allocate, lineAmount, roundTo, roundToUnit, type Paise } from '../../../shared/money.ts';
import type { CompanyConfig, CompanyFeatures } from '../../../shared/settings.ts';
import type {
  CompanyRegistrationType,
  ComputedLine,
  GstNature,
  InvoiceComputation,
  InvoiceContext,
  InvoiceLineInput,
  RegistrationType,
  SupplyKind,
} from '../../../shared/types/gst.ts';
import type {
  BillAllocationInput,
  BillAllocationView,
  CostAllocationView,
  GstLineView,
  InstrumentInput,
  LedgerEntryRole,
  PreviewEntry,
  PreviewInventoryLine,
  VoucherInput,
  VoucherMode,
  VoucherTotals,
  VoucherWarning,
  VoucherWarningCode,
} from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';
import { AppError, notFound, rule } from '../../lib/errors.ts';
import { PendingBillCache } from './bills.ts';
import { runGuards, stockQtyAsOf } from './guards.ts';
import { Masters, type ItemRow, type LedgerInfo } from './masters.ts';
import type { VoucherTypeInfo } from './numbering.ts';
import { dbTaxLookup, ledgerIsGstApplicable, resolveItemTaxProfile, resolveLedgerTaxProfile, type TaxLookup, type TaxProfile } from './taxprofile.ts';

// ───────────────────────────── Static rules ─────────────────────────────

/** Entry modes each base type accepts (first = default). */
export const ALLOWED_MODES: Readonly<Record<VoucherBaseType, readonly VoucherMode[]>> = {
  sales: ['item_invoice', 'accounting_invoice', 'ledger'],
  purchase: ['item_invoice', 'accounting_invoice', 'ledger'],
  credit_note: ['item_invoice', 'accounting_invoice', 'ledger'],
  debit_note: ['item_invoice', 'accounting_invoice', 'ledger'],
  payment: ['ledger'],
  receipt: ['ledger'],
  contra: ['ledger'],
  journal: ['ledger'],
  memorandum: ['ledger'],
  reversing_journal: ['ledger'],
  sales_order: ['item_invoice', 'inventory'],
  purchase_order: ['item_invoice', 'inventory'],
  delivery_note: ['item_invoice', 'inventory'],
  receipt_note: ['item_invoice', 'inventory'],
  rejection_in: ['item_invoice', 'inventory'],
  rejection_out: ['item_invoice', 'inventory'],
  stock_journal: ['inventory'],
  physical_stock: ['inventory'],
};

/** Base types whose voucher must name a party ledger. */
const PARTY_REQUIRED: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>([
  'sales_order',
  'purchase_order',
  'delivery_note',
  'receipt_note',
  'rejection_in',
  'rejection_out',
]);

/** Stock direction of item lines: +1 inward, −1 outward, 0 = set per line (stock journal / physical stock). */
export const STOCK_DIRECTION: Readonly<Record<VoucherBaseType, number>> = {
  sales: -1,
  purchase: 1,
  credit_note: 1,
  debit_note: -1,
  delivery_note: -1,
  receipt_note: 1,
  rejection_in: 1,
  rejection_out: -1,
  sales_order: -1,
  purchase_order: 1,
  stock_journal: 0,
  physical_stock: 0,
  payment: 0,
  receipt: 0,
  contra: 0,
  journal: 0,
  memorandum: 0,
  reversing_journal: 0,
};

/** Base types whose item lines never move stock. */
const NO_STOCK_MOVEMENT: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['sales_order', 'purchase_order']);

/** Note base types whose own lines carry their number as tracking_ref, and the invoice type that bills them. */
export const TRACKING_NOTE_FOR: Partial<Record<VoucherBaseType, VoucherBaseType>> = {
  sales: 'delivery_note',
  purchase: 'receipt_note',
  credit_note: 'rejection_in',
  debit_note: 'rejection_out',
};
const NOTE_TYPES: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['delivery_note', 'receipt_note', 'rejection_in', 'rejection_out']);
const ORDER_TYPES: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['sales_order', 'purchase_order']);

const OUTWARD: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['sales', 'credit_note', 'sales_order', 'delivery_note', 'rejection_in']);

const HEADS: readonly GstDutyHead[] = ['IGST', 'CGST', 'SGST', 'CESS'];
const OUTPUT_CODE: Record<GstDutyHead, LedgerCode> = { IGST: 'OUTPUT_IGST', CGST: 'OUTPUT_CGST', SGST: 'OUTPUT_SGST', CESS: 'OUTPUT_CESS' };
const INPUT_CODE: Record<GstDutyHead, LedgerCode> = { IGST: 'INPUT_IGST', CGST: 'INPUT_CGST', SGST: 'INPUT_SGST', CESS: 'INPUT_CESS' };
const RCM_CODE: Record<GstDutyHead, LedgerCode> = { IGST: 'RCM_IGST', CGST: 'RCM_CGST', SGST: 'RCM_SGST', CESS: 'RCM_CESS' };

/** Natures where HSN/SAC is mandatory on every line (same list as the GST engine). */
const HSN_REQUIRED: ReadonlySet<GstNature> = new Set<GstNature>(['b2b', 'sez_wpay', 'sez_lut', 'export_wpay', 'export_lut', 'deemed_export']);

/** Engine warnings that duplicate the engine-level checks done here with their own codes. */
const ENGINE_DUPLICATES: readonly RegExp[] = [/has no GSTIN/, /HSN\/SAC code is required/];

export function isAccountingBase(b: VoucherBaseType): boolean {
  return ACCOUNTING_BASE_TYPES.includes(b);
}

const money = (p: Paise): string => formatMoney(p, { symbol: true });

/** Trimmed non-empty text or undefined. */
export function txt(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t === '' ? undefined : t;
}

// ───────────────────────────── Plan types ─────────────────────────────

export interface PlanBill extends BillAllocationView {}
export interface PlanCost {
  costCentreId: number;
  amount: Paise;
}

export type EntrySource =
  | { kind: 'party' }
  | { kind: 'items'; ledgerId: number }
  | { kind: 'ledger'; index: number }
  | { kind: 'tax' }
  | { kind: 'round_off' };

export interface PlanEntry {
  ledgerId: number;
  amount: Paise;
  role: LedgerEntryRole;
  gstDutyHead: GstDutyHead | null;
  narration: string | null;
  instrument: InstrumentInput | null;
  bills: PlanBill[];
  costs: PlanCost[];
  source: EntrySource;
}

export interface PlanInventory {
  lineNo: number;
  itemId: number;
  godownId: number;
  batchName: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  qty: number;
  billedQty: number | null;
  altQty: number | null;
  rate: number;
  discountPct: number;
  amount: Paise;
  ledgerId: number | null;
  description: string | null;
  hsnSac: string | null;
  gstRate: number | null;
  trackingRef: string | null;
  orderRef: string | null;
  isConsumption: boolean;
  affectsStock: boolean;
}

export interface PlanGstLine extends Omit<GstLineView, 'lineNo'> {}

export interface PlanHeader {
  partyLedgerId: number | null;
  partyName: string | null;
  partyAddress: string | null;
  partyStateCode: string | null;
  partyGstin: string | null;
  partyRegistrationType: string | null;
  partyPincode: string | null;
  placeOfSupply: string | null;
  invoiceMode: 'item' | 'accounting' | null;
  isOptional: boolean;
  isPostDated: boolean;
  affectsBooks: boolean;
  affectsStock: boolean;
  isReverseCharge: boolean;
  totalAmount: Paise;
  taxableAmount: Paise;
  taxAmount: Paise;
  roundOff: Paise;
  gstNature: GstNature | null;
}

export interface PostingPlan {
  voucherType: VoucherTypeInfo;
  baseType: VoucherBaseType;
  mode: VoucherMode;
  number: string | null;
  header: PlanHeader;
  computation: InvoiceComputation | null;
  entries: PlanEntry[];
  inventory: PlanInventory[];
  gstLines: PlanGstLine[];
  totals: VoucherTotals;
  warnings: VoucherWarning[];
  /** The voucher as entered (normalised), stored in vouchers.meta for alter/duplicate. */
  normalizedInput: VoucherInput;
  masters: Masters;
}

/** Company fields the engine needs (loaded without the logo). */
export interface CompanyEssentials {
  name: string;
  stateCode: string | null;
  gstin: string | null;
  gstRegistrationType: CompanyRegistrationType;
  fyStartMonth: number;
  booksFrom: string;
}

export interface PostingEnv {
  db: Db;
  today: string;
  features: CompanyFeatures;
  config: CompanyConfig;
  company: CompanyEssentials;
}

export interface PostingOptions {
  voucherType: VoucherTypeInfo;
  number: string | null;
  /** Voucher being altered (excluded from balances, pending bills and duplicate checks). */
  voucherId: number | null;
}

// ───────────────────────────── Helpers ─────────────────────────────

interface PartySnapshot {
  name: string | null;
  address: string | null;
  stateCode: string | null;
  gstin: string | null;
  registrationType: RegistrationType;
  pincode: string | null;
}

function partySnapshot(party: LedgerInfo | null, input: VoucherInput): PartySnapshot {
  const o = input.party ?? {};
  const gstin = txt(o.gstin)?.toUpperCase() ?? txt(party?.row.gstin)?.toUpperCase() ?? null;
  const rawReg = o.registrationType ?? party?.row.gst_registration_type ?? null;
  const registrationType: RegistrationType =
    rawReg && (REGISTRATION_TYPES as readonly string[]).includes(rawReg) ? (rawReg as RegistrationType) : gstin ? 'regular' : 'unregistered';
  const state = txt(o.stateCode) ?? txt(party?.row.state_code) ?? (gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : undefined);
  return {
    name: txt(o.name) ?? txt(party?.row.mailing_name) ?? party?.name ?? null,
    address: txt(o.address) ?? txt(party?.row.address) ?? null,
    stateCode: state ?? null,
    gstin,
    registrationType,
    pincode: txt(o.pincode) ?? txt(party?.row.pincode) ?? null,
  };
}

const NON_GST_PROFILE: TaxProfile = { taxability: 'taxable', rate: 0, cessRate: 0, cessPerUnit: 0, hsnSac: '', source: 'default', missing: false };

function signOf(n: number): 1 | -1 {
  return n < 0 ? -1 : 1;
}

// ───────────────────────────── Builder ─────────────────────────────

export function buildPosting(env: PostingEnv, input: VoucherInput, opts: PostingOptions): PostingPlan {
  return new PostingBuilder(env, input, opts).build();
}

interface InvoiceLineMeta {
  kind: 'item' | 'ledger';
  index: number;
  /** item lines: sales/purchase ledger (null when not posting); ledger lines: the ledger. */
  ledger: LedgerInfo | null;
  item: ItemRow | null;
  treatment: 'item' | 'computed' | 'apportion';
}

class PostingBuilder {
  private readonly env: PostingEnv;
  private readonly db: Db;
  private readonly input: VoucherInput;
  private readonly opts: PostingOptions;
  private readonly vt: VoucherTypeInfo;
  private readonly base: VoucherBaseType;
  private readonly mode: VoucherMode;
  private readonly masters: Masters;
  private readonly lookup: TaxLookup;
  private readonly warnings: VoucherWarning[] = [];
  private readonly date: string;
  private readonly gstOn: boolean;
  private readonly isOptional: boolean;
  private readonly isPostDated: boolean;
  private readonly accounting: boolean;
  private readonly pending: PendingBillCache;
  private party: LedgerInfo | null = null;
  private snap: PartySnapshot | null = null;
  private computation: InvoiceComputation | null = null;
  private grandTotal = 0;
  private roundOffAmount = 0;
  private readonly entries: PlanEntry[] = [];
  private readonly inventory: PlanInventory[] = [];
  private readonly gstLines: PlanGstLine[] = [];

  constructor(env: PostingEnv, input: VoucherInput, opts: PostingOptions) {
    this.env = env;
    this.db = env.db;
    this.input = input;
    this.opts = opts;
    this.vt = opts.voucherType;
    this.base = opts.voucherType.baseType;
    this.mode = input.mode;
    this.masters = new Masters(env.db);
    this.masters.setBillWiseFeature(env.features.billWise);
    this.lookup = dbTaxLookup(env.db);
    this.date = input.date;
    this.gstOn = env.features.gst && env.company.gstRegistrationType !== 'unregistered';
    this.isOptional = input.isOptional ?? opts.voucherType.optionalByDefault;
    this.isPostDated = input.isPostDated === true;
    this.accounting = isAccountingBase(this.base);
    this.pending = new PendingBillCache(env.db, input.date, env.today, opts.voucherId);
  }

  private warn(code: VoucherWarningCode, message: string, blocking = false, path?: string): void {
    const w: VoucherWarning = { code, message, blocking };
    if (path) w.path = path;
    this.warnings.push(w);
  }

  build(): PostingPlan {
    this.validateHeader();
    const items = this.input.items ?? [];
    const ledgers = this.input.ledgers ?? [];
    this.masters.preloadLedgers([
      ...ledgers.map((l) => l.ledgerId),
      ...items.map((i) => i.ledgerId).filter((x): x is number => typeof x === 'number'),
      ...(this.input.partyLedgerId ? [this.input.partyLedgerId] : []),
    ]);
    this.masters.preloadItems(items.map((i) => i.itemId));

    if (this.input.partyLedgerId) this.party = this.masters.ledger(this.input.partyLedgerId);

    if (this.mode === 'item_invoice' || this.mode === 'accounting_invoice') this.buildInvoice();
    else if (this.mode === 'ledger') this.buildLedgerMode();
    else this.buildInventoryMode();

    if (this.party || this.input.party) this.snap = partySnapshot(this.party, this.input);

    if (this.accounting) {
      this.applyBills();
      this.applyCosts();
    }
    // Memorandum / reversing journals post nothing to the books but must still balance.
    if (this.accounting || this.mode === 'ledger') this.checkBalance();
    this.checkTrackingRefs();
    if (!this.isOptional) this.runGuards();
    return this.assemble();
  }

  // ── Header validation ──

  private validateHeader(): void {
    const { vt, base, mode, env } = this;
    if (!vt.isActive && this.opts.voucherId === null) throw rule(`The voucher type ${vt.name} is inactive. Activate it before entering vouchers.`);
    if (!ALLOWED_MODES[base].includes(mode)) {
      throw rule(`${vt.name} vouchers cannot be entered in ${mode.replace('_', ' ')} mode (allowed: ${ALLOWED_MODES[base].map((m) => m.replace('_', ' ')).join(', ')}).`);
    }
    if ((mode === 'item_invoice' || mode === 'inventory') && !env.features.inventory) {
      throw rule('Inventory is turned off for this company (F11 › Features). Use an accounting invoice, or turn on inventory.');
    }
    if (this.date < env.company.booksFrom) {
      throw rule(`The voucher date ${formatDate(this.date)} is before the books beginning date (${formatDate(env.company.booksFrom)}).`);
    }
    const needsParty = mode === 'item_invoice' || mode === 'accounting_invoice' || PARTY_REQUIRED.has(base);
    if (needsParty && !this.input.partyLedgerId) {
      const who =
        base === 'sales' || base === 'credit_note' || base === 'sales_order' || base === 'delivery_note' || base === 'rejection_in'
          ? 'the customer ledger (or Cash for a cash sale)'
          : 'the supplier ledger';
      throw rule(`Select ${who} in "Party A/c name".`);
    }
    if (this.input.priceLevelId !== undefined && this.db.value('SELECT 1 FROM price_levels WHERE id = :id', { id: this.input.priceLevelId }) === undefined) {
      throw notFound('Price level', this.input.priceLevelId);
    }
    if ((mode === 'ledger' || mode === 'accounting_invoice') && (this.input.items?.length ?? 0) > 0) {
      throw rule(`Stock items cannot be entered in ${mode === 'ledger' ? 'a ledger-mode voucher' : 'an accounting invoice'}. Use item invoice mode.`);
    }
    if (mode === 'inventory' && (this.input.ledgers?.length ?? 0) > 0) {
      throw rule(`${vt.name} vouchers do not post ledger entries; remove the ledger lines.`);
    }
  }

  private activeCheck(kind: 'Ledger' | 'Stock item', name: string, active: boolean): void {
    if (!active && this.opts.voucherId === null) throw rule(`${kind} ${name} is inactive. Activate it before using it in a voucher.`);
  }

  // ── Invoice modes ──

  private defaultItemLedgerId(): number | null {
    const cfg = this.vt.config.defaultLedgerId;
    if (typeof cfg === 'number' && this.masters.ledgerOrNull(cfg)) return cfg;
    const outward = OUTWARD.has(this.base);
    return this.masters.reservedLedgerId(outward ? 'SALES' : 'PURCHASE');
  }

  private buildInvoice(): void {
    const { input, base, mode, env, masters, gstOn } = this;
    const items = input.items ?? [];
    const ledgers = input.ledgers ?? [];
    const party = this.party as LedgerInfo;
    this.activeCheck('Ledger', party.name, party.row.is_active === 1);
    const snap = partySnapshot(party, input);
    const outward = OUTWARD.has(base);
    const postEntries = this.accounting;
    const defaultLedger = this.defaultItemLedgerId();

    if (mode === 'item_invoice' && items.length === 0) throw rule('Enter at least one stock item line.');

    const lines: InvoiceLineInput[] = [];
    const meta: InvoiceLineMeta[] = [];

    items.forEach((it, i) => {
      const item = masters.item(it.itemId);
      this.activeCheck('Stock item', item.name, item.is_active === 1);
      const ledgerId = it.ledgerId ?? defaultLedger;
      const ledger = ledgerId ? masters.ledger(ledgerId) : null;
      if (postEntries && !ledger) {
        throw rule(`Line ${i + 1} (${item.name}): select the ${outward ? 'sales' : 'purchase'} ledger (no default ${outward ? 'Sales' : 'Purchase'} ledger exists).`);
      }
      if (ledger && (ledger.isGstDuty || ledger.id === party.id)) {
        throw rule(`Line ${i + 1} (${item.name}): ${ledger.name} cannot be used as the ${outward ? 'sales' : 'purchase'} ledger.`);
      }
      const profile = gstOn
        ? resolveItemTaxProfile(this.lookup, { itemId: item.id, date: this.date, ledgerId: ledger?.id ?? null, gstRateOverride: it.gstRateOverride })
        : NON_GST_PROFILE;
      if (gstOn && profile.missing && GST_BASE_TYPES.includes(base)) {
        this.warn(
          'gst_missing_rate',
          `Line ${i + 1} (${item.name}): no GST rate is set on the item, its stock group or the ${ledger?.name ?? 'sales/purchase'} ledger; it was taxed at 0%.`,
          false,
          `items[${i}]`,
        );
      }
      const valueQty = it.billedQty !== undefined && it.billedQty !== null ? it.billedQty : it.qty;
      lines.push({
        key: `i${i}`,
        kind: 'item',
        description: item.name,
        qty: valueQty,
        rate: it.rate ?? 0,
        discountPct: it.discountPct,
        amount: it.amount,
        rateInclusiveOfTax: it.rateInclusiveOfTax ?? item.rate_inclusive_of_tax === 1,
        taxability: profile.taxability,
        gstRate: profile.rate,
        cessRate: profile.cessRate,
        cessPerUnit: profile.cessPerUnit,
        hsnSac: profile.hsnSac,
        supplyKind: item.is_service === 1 ? 'services' : 'goods',
        // Services are reported with UQC 'NA' (engine default); goods with their unit's UQC.
        uqc: item.is_service === 1 ? undefined : (item.unit_uqc ?? item.unit_symbol),
        reverseCharge: ledger?.row.is_reverse_charge === 1,
      });
      meta.push({ kind: 'item', index: i, ledger: postEntries ? ledger : null, item, treatment: 'item' });
    });

    // Additional ledgers (item mode) / invoice lines (accounting mode).
    const outside: Array<{ index: number; ledger: LedgerInfo; amount: Paise }> = [];
    ledgers.forEach((ll, i) => {
      const L = masters.ledger(ll.ledgerId);
      this.activeCheck('Ledger', L.name, L.row.is_active === 1);
      if (L.isGstDuty) {
        throw rule(`${L.name} is a GST tax ledger. GST on an invoice is calculated automatically — remove this line.`);
      }
      if (L.id === party.id) throw rule(`${L.name} is the party of this invoice and cannot also be an invoice line.`);
      if (ll.amount === 0) return;
      const plAccount = L.nature === 'income' || L.nature === 'expenses' || L.isFixedAsset;
      let treatment: InvoiceLineMeta['treatment'] | 'outside';
      if (L.row.include_in_assessable === 'goods') treatment = 'apportion';
      else if (gstOn && (ll.gst !== undefined || ledgerIsGstApplicable(this.lookup, L.id, this.date))) treatment = 'computed';
      else if (L.isSalesAccount || L.isPurchaseAccount || (mode === 'accounting_invoice' && plAccount)) treatment = 'computed';
      else treatment = 'outside';

      if (treatment === 'outside') {
        outside.push({ index: i, ledger: L, amount: ll.amount });
        return;
      }
      const profile = gstOn ? resolveLedgerTaxProfile(this.lookup, { ledgerId: L.id, date: this.date, override: ll.gst ?? null }) : { ...NON_GST_PROFILE, supplyKind: 'goods' as SupplyKind };
      if (gstOn && profile.missing && treatment === 'computed' && GST_BASE_TYPES.includes(base)) {
        this.warn('gst_missing_rate', `${L.name}: no GST rate is set on the ledger; it was taxed at 0%.`, false, `ledgers[${i}]`);
      }
      lines.push({
        key: `l${i}`,
        kind: 'ledger',
        description: L.name,
        amount: ll.amount,
        taxability: profile.taxability,
        gstRate: profile.rate,
        cessRate: profile.cessRate,
        hsnSac: profile.hsnSac,
        supplyKind: profile.supplyKind,
        apportion: treatment === 'apportion' ? (L.row.appropriate_by === 'quantity' ? 'quantity' : 'value') : 'none',
        reverseCharge: L.row.is_reverse_charge === 1,
      });
      meta.push({ kind: 'ledger', index: i, ledger: L, item: null, treatment });
    });

    if (mode === 'accounting_invoice' && !meta.some((m) => m.treatment === 'computed')) {
      throw rule('Enter at least one income or expense ledger line for the invoice.');
    }

    const companyReg: CompanyRegistrationType = gstOn ? env.company.gstRegistrationType : 'unregistered';
    const ctx: InvoiceContext = {
      direction: outward ? 'outward' : 'inward',
      invoiceDate: this.date,
      companyStateCode: env.company.stateCode ?? '',
      companyRegistration: companyReg,
      partyRegistration: snap.registrationType,
      partyStateCode: snap.stateCode,
      partyGstin: snap.gstin,
      consigneeStateCode: txt(input.consignee?.stateCode) ?? null,
      placeOfSupply: txt(input.placeOfSupply) ?? null,
      exportWithPayment: input.exportDetails?.withPayment === true,
      reverseCharge: input.reverseCharge === true,
      roundOff: { enabled: false, method: 'nearest', unit: 100 },
      b2clThresholdPaise: env.config.gst.b2clThresholdPaise,
    };
    const comp = computeInvoice(lines, ctx);

    // Totals: non-GST charges outside the computation are added after tax; round-off on the whole.
    const outsideTotal = outside.reduce((a, o) => a + o.amount, 0);
    const beforeRound = comp.totals.invoiceValueBeforeRound + outsideTotal;
    const ro = env.config.roundOff;
    const grand = ro.enabled && ro.unit > 1 ? roundToUnit(beforeRound, ro.unit, ro.method) : beforeRound;
    const roundOff = grand - beforeRound;
    let nature = comp.nature;
    if (nature === 'b2cl' || nature === 'b2cs') {
      nature = comp.interState && grand > env.config.gst.b2clThresholdPaise ? 'b2cl' : 'b2cs';
    }
    this.computation = {
      ...comp,
      nature,
      totals: { ...comp.totals, invoiceValueBeforeRound: beforeRound, roundOff, grandTotal: grand, payableToParty: grand },
    };
    this.grandTotal = grand;
    this.roundOffAmount = roundOff;

    // Engine warnings (GST documents only), minus the ones reported with their own codes below.
    if (gstOn && GST_BASE_TYPES.includes(base)) {
      const hasMissingRate = this.warnings.some((w) => w.code === 'gst_missing_rate');
      for (const m of comp.warnings) {
        if (ENGINE_DUPLICATES.some((re) => re.test(m))) continue;
        if (hasMissingRate && /GST rate is 0% on a taxable line/.test(m)) continue;
        this.warn('gst', m);
      }
    }

    // ── Ledger entries ──
    const s = base === 'sales' || base === 'debit_note' ? 1 : -1; // party sign
    const companyClaimsItc = gstOn && env.company.gstRegistrationType === 'regular';
    const itemLedgerAmt = new Map<number, Paise>();
    const ledgerLineAmt = new Map<number, Paise>();
    const capitalised = new Map<string, Paise>(); // line key → tax added to cost (items: inventory value)
    const taxMain: Record<GstDutyHead, Paise> = { IGST: 0, CGST: 0, SGST: 0, CESS: 0 };
    const taxRcm: Record<GstDutyHead, Paise> = { IGST: 0, CGST: 0, SGST: 0, CESS: 0 };
    const addTo = (map: Map<number, Paise>, k: number, v: Paise): void => {
      map.set(k, (map.get(k) ?? 0) + v);
    };
    const headAmounts = (cl: ComputedLine): Record<GstDutyHead, Paise> => ({ IGST: cl.igst, CGST: cl.cgst, SGST: cl.sgst, CESS: cl.cess });
    const itcOf = (m: InvoiceLineMeta, cl: ComputedLine): string | null => {
      if (outward) return null;
      if (!companyClaimsItc) return 'ineligible';
      const L = m.ledger;
      const explicit = L?.row.itc_eligibility;
      if (explicit === 'inputs' || explicit === 'capital_goods' || explicit === 'input_services' || explicit === 'ineligible') return explicit;
      if (L?.isFixedAsset) return 'capital_goods';
      return cl.supplyKind === 'services' ? 'input_services' : 'inputs';
    };

    const computed = this.computation.lines;
    meta.forEach((m, j) => {
      const cl = computed[j];
      if (m.kind === 'item') {
        if (m.ledger) addTo(itemLedgerAmt, m.ledger.id, cl.postingAmount);
      } else {
        addTo(ledgerLineAmt, m.index, cl.postingAmount);
      }
      if (!postEntries || !cl.taxCharged || cl.tax === 0) return;
      const heads = headAmounts(cl);
      const capitalise = (amount: Paise): void => {
        capitalised.set(cl.key, (capitalised.get(cl.key) ?? 0) + amount);
        if (m.kind === 'item') {
          if (m.ledger) addTo(itemLedgerAmt, m.ledger.id, amount);
        } else addTo(ledgerLineAmt, m.index, amount);
      };
      if (outward) {
        if (cl.taxPayableToParty) for (const h of HEADS) taxMain[h] += heads[h];
        return;
      }
      const claimable = itcOf(m, cl) !== 'ineligible';
      if (cl.reverseCharge) {
        for (const h of HEADS) taxRcm[h] += heads[h];
        if (claimable) for (const h of HEADS) taxMain[h] += heads[h];
        else capitalise(cl.tax);
      } else if (cl.taxPayableToParty) {
        if (claimable) for (const h of HEADS) taxMain[h] += heads[h];
        else capitalise(cl.tax);
      }
      // else: import of goods — IGST is paid at customs (bill of entry), not posted here.
    });
    for (const o of outside) ledgerLineAmt.set(o.index, o.amount);

    if (postEntries) {
      const itemRole: LedgerEntryRole = outward ? 'sales' : 'purchase';
      this.push({ ledgerId: party.id, amount: s * grand, role: 'party', source: { kind: 'party' } });
      for (const [ledgerId, amt] of itemLedgerAmt) this.push({ ledgerId, amount: -s * amt, role: itemRole, source: { kind: 'items', ledgerId } });
      const ledgerOrder = [...ledgerLineAmt.keys()].sort((a, b) => a - b);
      for (const idx of ledgerOrder) {
        const L = masters.ledger(ledgers[idx].ledgerId);
        const role: LedgerEntryRole = L.isSalesAccount ? 'sales' : L.isPurchaseAccount ? 'purchase' : 'charge';
        this.push({
          ledgerId: L.id,
          amount: -s * (ledgerLineAmt.get(idx) ?? 0),
          role,
          narration: txt(ledgers[idx].narration) ?? null,
          instrument: ledgers[idx].instrument ?? null,
          source: { kind: 'ledger', index: idx },
        });
      }
      const codes = outward ? OUTPUT_CODE : INPUT_CODE;
      for (const h of HEADS) {
        if (taxMain[h] === 0) continue;
        this.push({ ledgerId: this.taxLedger(codes[h]), amount: -s * taxMain[h], role: 'tax', gstDutyHead: h, source: { kind: 'tax' } });
      }
      for (const h of HEADS) {
        if (taxRcm[h] === 0) continue;
        this.push({ ledgerId: this.taxLedger(RCM_CODE[h]), amount: s * taxRcm[h], role: 'tax', gstDutyHead: h, source: { kind: 'tax' } });
      }
      if (roundOff !== 0) {
        const ro = masters.reservedLedgerId('ROUND_OFF');
        if (ro === null) throw new AppError('INTERNAL', 'The Round Off ledger is missing');
        this.push({ ledgerId: ro, amount: -s * roundOff, role: 'round_off', source: { kind: 'round_off' } });
      }
    }

    // ── Inventory entries ──
    const dir = STOCK_DIRECTION[base];
    meta.forEach((m, j) => {
      if (m.kind !== 'item' || !m.item) return;
      const it = items[m.index];
      const cl = computed[j];
      const item = m.item;
      const loc = this.locate(it, item, m.index);
      const inclusive = cl.inclusive;
      const exclusiveRate = inclusive ? roundTo(((it.rate ?? 0) * 100) / (100 + cl.rate + cl.cessRate), 6) : (it.rate ?? 0);
      const trackingRef = NOTE_TYPES.has(base) ? this.opts.number : (txt(it.trackingRef) ?? null);
      const orderRef = ORDER_TYPES.has(base) ? this.opts.number : (txt(it.orderRef) ?? null);
      this.inventory.push({
        lineNo: m.index + 1,
        itemId: item.id,
        godownId: loc.godownId,
        batchName: loc.batchName,
        mfgDate: loc.mfgDate,
        expiryDate: loc.expiryDate,
        qty: dir * it.qty,
        billedQty: it.billedQty ?? null,
        altQty: it.altQty ?? null,
        rate: exclusiveRate,
        discountPct: it.discountPct ?? 0,
        amount: cl.taxableValue + (capitalised.get(cl.key) ?? 0),
        ledgerId: m.ledger?.id ?? (it.ledgerId ?? null),
        description: txt(it.description) ?? null,
        hsnSac: cl.hsnSac || null,
        gstRate: gstOn ? cl.rate : null,
        trackingRef,
        orderRef,
        isConsumption: false,
        affectsStock: this.lineMovesStock(item, !NOTE_TYPES.has(base) && trackingRef !== null),
      });
    });

    // ── gst_lines (GST invoices only) ──
    if (gstOn && GST_BASE_TYPES.includes(base)) {
      meta.forEach((m, j) => {
        const cl = computed[j];
        if (cl.absorbed || (cl.taxableValue === 0 && cl.tax === 0)) return;
        this.gstLines.push({
          source: m.kind,
          itemId: m.item?.id ?? null,
          ledgerId: m.ledger?.id ?? null,
          description: m.kind === 'item' ? (m.item?.name ?? null) : (m.ledger?.name ?? null),
          hsnSac: cl.hsnSac || null,
          uqc: cl.uqc || null,
          qty: m.kind === 'item' ? cl.qty : null,
          supplyType: cl.supplyKind,
          taxability: cl.taxability,
          rate: cl.rate,
          cessRate: cl.cessRate,
          taxableValue: cl.taxableValue,
          igst: cl.igst,
          cgst: cl.cgst,
          sgst: cl.sgst,
          cess: cl.cess,
          isReverseCharge: cl.reverseCharge,
          itcEligibility: itcOf(m, cl),
        });
      });

      // GST data-quality checks with their own codes.
      const nature = this.computation.nature;
      if (isRegisteredParty(snap.registrationType) && !snap.gstin) {
        this.warn(
          'gst_missing_gstin',
          outward
            ? `${party.name} is GST-registered (${snap.registrationType}) but has no GSTIN. Enter the GSTIN in the party ledger; B2B invoices need it.`
            : `Supplier ${party.name} is GST-registered but has no GSTIN; input tax credit cannot be matched with GSTR-2B.`,
        );
      }
      if (HSN_REQUIRED.has(nature)) {
        meta.forEach((m, j) => {
          const cl = computed[j];
          if (cl.absorbed || cl.taxableValue === 0 || cl.hsnSac) return;
          const label = m.kind === 'item' ? `Line ${m.index + 1} (${m.item?.name ?? ''})` : (m.ledger?.name ?? `Ledger line ${m.index + 1}`);
          this.warn('gst_missing_hsn', `${label}: HSN/SAC code is required on this invoice.`, false, m.kind === 'item' ? `items[${m.index}]` : `ledgers[${m.index}]`);
        });
      }
      if (base === 'purchase' && isRegisteredParty(snap.registrationType) && !txt(input.referenceNo)) {
        this.warn('supplier_invoice_required', 'Supplier invoice number is required for GST purchases. Enter it in "Supplier Invoice No.".', true, 'referenceNo');
      }
    }
  }

  private taxLedger(code: LedgerCode): number {
    const id = this.masters.reservedLedgerId(code);
    if (id === null) {
      throw rule(`The GST ledger for ${code.replace('_', ' ').toLowerCase()} is missing. Turn GST off and on again in F11 › Features to recreate it.`);
    }
    return id;
  }

  private push(e: Omit<PlanEntry, 'bills' | 'costs' | 'narration' | 'instrument' | 'gstDutyHead'> & Partial<Pick<PlanEntry, 'narration' | 'instrument' | 'gstDutyHead'>>): void {
    if (e.amount === 0) return;
    this.entries.push({
      ledgerId: e.ledgerId,
      amount: e.amount,
      role: e.role,
      gstDutyHead: e.gstDutyHead ?? null,
      narration: e.narration ?? null,
      instrument: e.instrument ?? null,
      bills: [],
      costs: [],
      source: e.source,
    });
  }

  /** Does this item line move stock? */
  private lineMovesStock(item: ItemRow, trackedElsewhere: boolean): boolean {
    if (this.isOptional || !this.env.features.inventory) return false;
    if (NO_STOCK_MOVEMENT.has(this.base)) return false;
    if (item.is_service === 1) return false;
    return !trackedElsewhere;
  }

  /** Godown and batch of an item line (validated). */
  private locate(
    it: { godownId?: number; batchName?: string; mfgDate?: string; expiryDate?: string },
    item: ItemRow,
    index: number,
  ): { godownId: number; batchName: string | null; mfgDate: string | null; expiryDate: string | null } {
    const godownId = it.godownId ?? this.masters.mainGodownId();
    this.masters.godown(godownId);
    const batches = this.env.features.batches && item.maintain_batches === 1;
    const batchName = batches ? (txt(it.batchName) ?? null) : null;
    if (batches && !batchName && item.is_service !== 1) {
      throw rule(`Line ${index + 1} (${item.name}): enter the batch — this item maintains batches.`);
    }
    return {
      godownId,
      batchName,
      mfgDate: batches ? (txt(it.mfgDate) ?? null) : null,
      expiryDate: batches ? (txt(it.expiryDate) ?? null) : null,
    };
  }

  // ── Ledger mode ──

  private buildLedgerMode(): void {
    const { input, masters, base } = this;
    const ledgers = input.ledgers ?? [];
    const lines: Array<{ L: LedgerInfo; index: number }> = [];
    ledgers.forEach((ll, i) => {
      const L = masters.ledger(ll.ledgerId);
      this.activeCheck('Ledger', L.name, L.row.is_active === 1);
      if (ll.amount === 0) return;
      lines.push({ L, index: i });
    });

    // Party: explicit, else inferred (payment: first debited non-cash ledger; receipt: first credited one;
    // invoice-type vouchers: first debtor/creditor line).
    if (!this.party) {
      let inferred: LedgerInfo | null = null;
      for (const { L, index } of lines) {
        const amt = ledgers[index].amount;
        if (base === 'payment' && amt > 0 && !L.isCashBank) inferred = L;
        else if (base === 'receipt' && amt < 0 && !L.isCashBank) inferred = L;
        else if (GST_BASE_TYPES.includes(base) && (L.isDebtor || L.isCreditor)) inferred = L;
        if (inferred) break;
      }
      this.party = inferred;
    }

    for (const { L, index } of lines) {
      const ll = ledgers[index];
      const role: LedgerEntryRole = L.isCashBank
        ? 'cash_bank'
        : this.party && L.id === this.party.id
          ? 'party'
          : L.isGstDuty
            ? 'tax'
            : L.isSalesAccount
              ? 'sales'
              : L.isPurchaseAccount
                ? 'purchase'
                : 'other';
      this.push({
        ledgerId: L.id,
        amount: ll.amount,
        role,
        gstDutyHead: L.gstDutyHead,
        narration: txt(ll.narration) ?? null,
        instrument: ll.instrument ?? null,
        source: { kind: 'ledger', index },
      });
    }

    const name = this.vt.name;
    const cashBankDr = this.entries.some((e) => e.amount > 0 && masters.ledger(e.ledgerId).isCashBank);
    const cashBankCr = this.entries.some((e) => e.amount < 0 && masters.ledger(e.ledgerId).isCashBank);
    if (this.entries.length > 0) {
      if (base === 'payment' && !cashBankCr) {
        this.warn('cash_bank_required', `A ${name} voucher must credit at least one Cash or Bank ledger (the account the money is paid from).`, true);
      }
      if (base === 'receipt' && !cashBankDr) {
        this.warn('cash_bank_required', `A ${name} voucher must debit at least one Cash or Bank ledger (the account the money is received into).`, true);
      }
      if (base === 'contra') {
        for (const e of this.entries) {
          const L = masters.ledger(e.ledgerId);
          if (!L.isCashBank) {
            this.warn('contra_ledger', `${L.name} is not a Cash or Bank ledger. A Contra voucher can only move money between Cash, Bank and Bank OD accounts.`, true);
          }
        }
      }
      if (base === 'journal') {
        for (const e of this.entries) {
          const L = masters.ledger(e.ledgerId);
          if (L.isCashBank) {
            this.warn(
              'journal_cash_bank',
              `${L.name} is a Cash/Bank ledger and cannot be used in a Journal. Use a Payment, Receipt or Contra voucher instead.`,
              true,
            );
          }
        }
      }
      if (this.gstOn && GST_BASE_TYPES.includes(base) && this.entries.some((e) => masters.ledger(e.ledgerId).isGstDuty)) {
        this.warn(
          'gst_ledger_lines',
          'GST entered as plain ledger lines is not reported in GST returns. Use item or accounting invoice mode to record GST details.',
        );
      }
    }
  }

  // ── Inventory mode ──

  private buildInventoryMode(): void {
    const { input, masters, base } = this;
    const items = input.items ?? [];
    if (items.length === 0) throw rule('Enter at least one stock item line.');
    if (this.party) this.activeCheck('Ledger', this.party.name, this.party.row.is_active === 1);
    const dir = STOCK_DIRECTION[base];
    items.forEach((it, i) => {
      const item = masters.item(it.itemId);
      this.activeCheck('Stock item', item.name, item.is_active === 1);
      const loc = this.locate(it, item, i);
      const rate = it.rate ?? 0;
      let qty: number;
      let amount: Paise;
      if (base === 'physical_stock') {
        const book = stockQtyAsOf(this.db, {
          itemId: item.id,
          godownId: loc.godownId,
          batchName: loc.batchName,
          date: this.date,
          today: this.env.today,
          excludeVoucherId: this.opts.voucherId,
          byBatch: loc.batchName !== null,
        });
        qty = roundTo(it.qty - book, 6);
        amount = it.amount ?? lineAmount(Math.abs(qty), rate, 0);
      } else {
        const d = base === 'stock_journal' ? (it.isConsumption ? -1 : 1) : dir;
        qty = d * it.qty;
        amount = it.amount ?? lineAmount(it.qty, rate, it.discountPct ?? 0);
      }
      const ledgerId = it.ledgerId ?? null;
      if (ledgerId !== null) masters.ledger(ledgerId);
      const trackingRef = NOTE_TYPES.has(base) ? this.opts.number : null;
      const orderRef = ORDER_TYPES.has(base) ? this.opts.number : (txt(it.orderRef) ?? null);
      this.inventory.push({
        lineNo: i + 1,
        itemId: item.id,
        godownId: loc.godownId,
        batchName: loc.batchName,
        mfgDate: loc.mfgDate,
        expiryDate: loc.expiryDate,
        qty,
        billedQty: it.billedQty ?? null,
        altQty: it.altQty ?? null,
        rate,
        discountPct: it.discountPct ?? 0,
        amount,
        ledgerId,
        description: txt(it.description) ?? null,
        hsnSac: null,
        gstRate: null,
        trackingRef,
        orderRef,
        isConsumption: base === 'stock_journal' && it.isConsumption === true,
        affectsStock: this.lineMovesStock(item, false) && qty !== 0,
      });
    });
  }

  // ── Bill-wise ──

  private applyBills(): void {
    if (!this.env.features.billWise) return;
    const { input, base, masters } = this;
    const isInvoiceBase = GST_BASE_TYPES.includes(base);
    const number = this.opts.number;
    const newName = base === 'purchase' ? (txt(input.referenceNo) ?? number) : number;
    const origNo = txt(input.originalInvoiceNo);

    for (const e of this.entries) {
      const L = masters.ledger(e.ledgerId);
      if (!L.billWise) continue;
      const sign = signOf(e.amount);
      const abs = Math.abs(e.amount);
      const path = e.source.kind === 'party' ? 'partyBillAllocations' : e.source.kind === 'ledger' ? `ledgers[${e.source.index}].billAllocations` : undefined;
      const provided: BillAllocationInput[] | undefined =
        e.source.kind === 'party'
          ? input.partyBillAllocations
          : e.source.kind === 'ledger'
            ? input.ledgers?.[e.source.index]?.billAllocations
            : undefined;
      const creditDaysDefault = L.row.default_credit_days ?? null;
      const dueFor = (days: number | null): string => addDays(this.date, days ?? 0);

      if (provided && provided.length > 0) {
        let sum = 0;
        for (const a of provided) {
          const name = txt(a.billName);
          if (a.refType !== 'on_account' && !name) {
            this.warn('bill_name_required', `Enter the bill name for each ${a.refType === 'new' ? 'new reference' : a.refType === 'against' ? 'against reference' : 'advance'} of ${L.name}.`, true, path);
            continue;
          }
          sum += a.amount;
          if (a.amount === 0) continue;
          const days = a.creditDays ?? (a.refType === 'new' ? creditDaysDefault : null);
          e.bills.push({
            refType: a.refType,
            billName: a.refType === 'on_account' ? null : (name ?? null),
            amount: sign * a.amount,
            creditDays: a.refType === 'new' ? days : (a.creditDays ?? null),
            dueDate: a.refType === 'new' ? (txt(a.dueDate) ?? dueFor(days)) : (txt(a.dueDate) ?? null),
          });
        }
        if (sum !== abs) {
          this.warn('bill_mismatch', `Bill-wise details of ${L.name} total ${money(sum)} but its amount is ${money(abs)}.`, true, path);
        }
      } else {
        const partyLine = e.source.kind === 'party' || (this.mode === 'ledger' && isInvoiceBase && (!this.party || this.party.id === L.id));
        if (isInvoiceBase && partyLine) {
          let remaining = abs;
          if ((base === 'credit_note' || base === 'debit_note') && origNo) {
            const p = this.pending.forLedger(L.id).get(origNo);
            if (p && signOf(p.amount) === -sign) {
              const take = Math.min(remaining, Math.abs(p.amount));
              e.bills.push({ refType: 'against', billName: origNo, amount: sign * take, creditDays: null, dueDate: null });
              remaining -= take;
            }
          }
          if (remaining > 0) {
            if (newName) {
              e.bills.push({ refType: 'new', billName: newName, amount: sign * remaining, creditDays: creditDaysDefault, dueDate: dueFor(creditDaysDefault) });
            } else {
              e.bills.push({ refType: 'on_account', billName: null, amount: sign * remaining, creditDays: null, dueDate: null });
            }
          }
        } else {
          e.bills.push({ refType: 'on_account', billName: null, amount: sign * abs, creditDays: null, dueDate: null });
        }
      }

      // Validate references against the ledger's pending bills.
      const used = new Map<string, Paise>();
      for (const b of e.bills) {
        if (!b.billName) continue;
        const pend = this.pending.forLedger(L.id).get(b.billName);
        if (b.refType === 'against') {
          if (!pend) {
            this.warn('bill_not_found', `Bill ${b.billName} is not pending for ${L.name} on ${formatDate(this.date)}.`, true, path);
            continue;
          }
          const total = (used.get(b.billName) ?? 0) + b.amount;
          used.set(b.billName, total);
          if (signOf(total) !== signOf(pend.amount) && Math.abs(total) > Math.abs(pend.amount)) {
            this.warn(
              'bill_over_settled',
              `Bill ${b.billName} of ${L.name} has ${money(Math.abs(pend.amount))} pending, but ${money(Math.abs(total))} is allocated against it.`,
              false,
              path,
            );
          }
        } else if (b.refType === 'new' && pend && pend.originalAmount !== 0) {
          this.warn(
            'duplicate_bill_ref',
            `${L.name} already has a pending bill named ${b.billName}; the amounts will be combined in outstanding reports.`,
            false,
            path,
          );
        }
      }
    }
  }

  // ── Cost centres ──

  private applyCosts(): void {
    if (!this.env.features.costCentres) return;
    const ledgers = this.input.ledgers ?? [];
    for (const e of this.entries) {
      if (e.source.kind !== 'ledger') continue;
      const L = this.masters.ledger(e.ledgerId);
      if (L.row.cost_centres_applicable !== 1) continue;
      const line = ledgers[e.source.index];
      const provided = line?.costAllocations ?? [];
      if (provided.length === 0) continue;
      const path = `ledgers[${e.source.index}].costAllocations`;
      for (const c of provided) {
        if (this.masters.costCentreName(c.costCentreId) === null) throw rule(`Cost centre ${c.costCentreId} does not exist.`);
      }
      const sum = provided.reduce((a, c) => a + c.amount, 0);
      const abs = Math.abs(e.amount);
      const sign = signOf(e.amount);
      let amounts: Paise[];
      if (sum === abs) amounts = provided.map((c) => c.amount);
      else if (sum === Math.abs(line.amount) && sum > 0) amounts = allocate(abs, provided.map((c) => c.amount)); // tax capitalised into the line
      else {
        this.warn('cost_mismatch', `Cost centre allocations of ${L.name} total ${money(sum)} but its amount is ${money(abs)}.`, true, path);
        continue;
      }
      provided.forEach((c, k) => {
        if (amounts[k] !== 0) e.costs.push({ costCentreId: c.costCentreId, amount: sign * amounts[k] });
      });
    }
  }

  // ── Balance ──

  private checkBalance(): void {
    const sum = this.entries.reduce((a, e) => a + e.amount, 0);
    const dr = this.entries.reduce((a, e) => a + (e.amount > 0 ? e.amount : 0), 0);
    const cr = this.entries.reduce((a, e) => a + (e.amount < 0 ? -e.amount : 0), 0);
    if (this.entries.length === 0) {
      if (!this.vt.allowZeroValue) {
        this.warn('zero_value', 'Enter an amount: a voucher with no value cannot be saved.', true);
      }
      return;
    }
    if (sum !== 0) {
      if (this.mode !== 'ledger') {
        // Invoice postings are derived from the engine and always balance; anything else is a bug.
        throw new AppError('INTERNAL', `Posting engine produced an unbalanced voucher (difference ${sum} paise)`);
      }
      const diff = dr - cr;
      this.warn(
        'unbalanced',
        `Voucher is not balanced: Dr ${money(dr)} ≠ Cr ${money(cr)} (difference ${money(Math.abs(diff))} ${diff > 0 ? 'Dr' : 'Cr'}).`,
        true,
      );
    }
  }

  // ── Tracking references ──

  private checkTrackingRefs(): void {
    const noteBase = TRACKING_NOTE_FOR[this.base];
    if (!noteBase || !this.party) return;
    const items = this.input.items ?? [];
    items.forEach((it, i) => {
      const ref = txt(it.trackingRef);
      if (!ref) return;
      const found = this.db.value(
        `SELECT 1 FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
          WHERE ie.tracking_ref = :ref AND ie.item_id = :item AND v.base_type = :note AND v.party_ledger_id = :party
            AND v.is_cancelled = 0 AND v.id <> :self LIMIT 1`,
        { ref, item: it.itemId, note: noteBase, party: (this.party as LedgerInfo).id, self: this.opts.voucherId ?? 0 },
      );
      if (found === undefined) {
        const item = this.masters.item(it.itemId);
        this.warn(
          'tracking_ref',
          `Line ${i + 1} (${item.name}): no ${noteBase.replace('_', ' ')} ${ref} with this item was found for ${(this.party as LedgerInfo).name}. This line will not change stock.`,
          false,
          `items[${i}]`,
        );
      }
    });
  }

  // ── Guards ──

  private runGuards(): void {
    const { env } = this;
    const out = runGuards({
      db: this.db,
      masters: this.masters,
      policies: env.config.guards,
      date: this.date,
      today: env.today,
      fyStartMonth: env.company.fyStartMonth,
      baseType: this.base,
      excludeVoucherId: this.opts.voucherId,
      partyLedgerId: this.party?.id ?? null,
      referenceNo: txt(this.input.referenceNo) ?? null,
      entries: this.accounting ? this.entries : [],
      stock: this.inventory,
      inventoryOn: env.features.inventory,
    });
    this.warnings.push(...out);
  }

  // ── Assemble ──

  private assemble(): PostingPlan {
    const { input, base, mode } = this;
    const affectsBooks = this.accounting && !this.isOptional;
    const affectsStock = this.inventory.some((l) => l.affectsStock);
    const dr = this.entries.reduce((a, e) => a + (e.amount > 0 ? e.amount : 0), 0);
    const cr = this.entries.reduce((a, e) => a + (e.amount < 0 ? -e.amount : 0), 0);
    const comp = this.computation;
    let grandTotal: Paise;
    if (comp) grandTotal = this.grandTotal;
    else if (mode === 'ledger') grandTotal = dr;
    else {
      const produced = this.inventory.filter((l) => !l.isConsumption);
      grandTotal = (produced.length > 0 ? produced : this.inventory).reduce((a, l) => a + l.amount, 0);
    }
    const totals: VoucherTotals = {
      debit: dr,
      credit: cr,
      taxable: comp?.totals.taxable ?? 0,
      tax: comp?.totals.tax ?? 0,
      roundOff: comp ? this.roundOffAmount : 0,
      grandTotal,
    };
    const snap = this.snap;
    const header: PlanHeader = {
      partyLedgerId: this.party?.id ?? null,
      partyName: snap?.name ?? null,
      partyAddress: snap?.address ?? null,
      partyStateCode: snap?.stateCode ?? null,
      partyGstin: snap?.gstin ?? null,
      partyRegistrationType: snap ? snap.registrationType : null,
      partyPincode: snap?.pincode ?? null,
      placeOfSupply: comp?.placeOfSupply || txt(input.placeOfSupply) || null,
      invoiceMode: mode === 'item_invoice' ? 'item' : mode === 'accounting_invoice' ? 'accounting' : null,
      isOptional: this.isOptional,
      isPostDated: this.isPostDated,
      affectsBooks,
      affectsStock,
      isReverseCharge: comp?.reverseCharge === true || input.reverseCharge === true,
      totalAmount: grandTotal,
      taxableAmount: totals.taxable,
      taxAmount: totals.tax,
      roundOff: totals.roundOff,
      gstNature: comp && this.gstOn && GST_BASE_TYPES.includes(base) ? comp.nature : null,
    };
    const normalizedInput: VoucherInput = { ...input };
    delete normalizedInput.id;
    delete normalizedInput.acknowledgeWarnings;
    delete normalizedInput.expectedUpdatedAt;
    delete normalizedInput.number;
    normalizedInput.isOptional = this.isOptional;
    return {
      voucherType: this.vt,
      baseType: base,
      mode,
      number: this.opts.number,
      header,
      computation: comp,
      entries: this.entries,
      inventory: this.inventory,
      gstLines: this.gstLines,
      totals,
      warnings: this.warnings,
      normalizedInput,
      masters: this.masters,
    };
  }
}

// ───────────────────────────── Views ─────────────────────────────

export function previewEntries(plan: PostingPlan): PreviewEntry[] {
  return plan.entries.map((e) => ({
    ledgerId: e.ledgerId,
    ledgerName: plan.masters.ledger(e.ledgerId).name,
    amount: e.amount,
    role: e.role,
    gstDutyHead: e.gstDutyHead,
    narration: e.narration,
    billAllocations: e.bills.map((b) => ({ ...b })),
    costAllocations: e.costs.map((c): CostAllocationView => {
      const name = plan.masters.costCentreName(c.costCentreId);
      return name === null ? { ...c } : { ...c, costCentreName: name };
    }),
  }));
}

export function previewInventory(plan: PostingPlan): PreviewInventoryLine[] {
  return plan.inventory.map((l) => {
    const item = plan.masters.item(l.itemId);
    return {
      lineNo: l.lineNo,
      itemId: l.itemId,
      itemName: item.name,
      unit: item.unit_symbol,
      godownId: l.godownId,
      godownName: plan.masters.godown(l.godownId).name,
      batchName: l.batchName,
      qty: l.qty,
      billedQty: l.billedQty,
      rate: l.rate,
      discountPct: l.discountPct,
      amount: l.amount,
      ledgerId: l.ledgerId,
      affectsStock: l.affectsStock,
      trackingRef: l.trackingRef,
      orderRef: l.orderRef,
      isConsumption: l.isConsumption,
      hsnSac: l.hsnSac,
      gstRate: l.gstRate,
    };
  });
}

export function previewGstLines(plan: PostingPlan): GstLineView[] {
  return plan.gstLines.map((g, i) => ({ lineNo: i + 1, ...g }));
}
