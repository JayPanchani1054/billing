/**
 * Print data: everything a template needs to render one voucher (PrintVoucherData).
 *
 * Invoice layout (sales/purchase/notes in invoice modes, orders/notes entered with prices): the line
 * detail (gross, discount, per-line tax, absorbed charges) is rebuilt by the posting engine from the
 * voucher as entered, with the party snapshot and place of supply pinned to what was saved. The result
 * is checked against the books (header totals and gst_lines). When it does not tie — masters changed
 * since the voucher was saved, or an imported voucher has no entry detail — the document is built from
 * the stored rows instead (fromBooks) and a warning says so. Either way the printed figures are the
 * books' figures.
 *
 * Voucher layout (payment/receipt/journal/contra, ledger-mode documents): the stored ledger entries.
 * Inventory layout (challans/orders/notes entered as quantities, stock journal, physical stock): the
 * stock lines as entered.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { getState, isUtgstState, stateLabel, stateName } from '../../../shared/gst/index.ts';
import { allocate, lineAmount, type Paise } from '../../../shared/money.ts';
import type { CompanyConfig, CompanyFeatures } from '../../../shared/settings.ts';
import type { CompanyProfile } from '../../../shared/types/company.ts';
import type { GstNature, Taxability, TaxMode } from '../../../shared/types/gst.ts';
import type {
  InvoicePrintOptions,
  InvoicePrintOverrides,
  PrintAddress,
  PrintBank,
  PrintCharge,
  PrintCompany,
  PrintEntry,
  PrintHsnRow,
  PrintLayout,
  PrintLine,
  PrintRef,
  PrintTaxRateRow,
  PrintTotals,
  PrintUpi,
  PrintVoucherData,
} from '../../../shared/types/print.ts';
import type {
  BillAllocationView,
  ConsigneeInput,
  DispatchDetailsInput,
  ExportDetailsInput,
  GstLineView,
  InstrumentInput,
  OrderDetailsInput,
  VoucherInput,
} from '../../../shared/types/vouchers.ts';
import { amountInWords } from '../../../shared/words.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound } from '../../lib/errors.ts';
import { getCompanyProfile, getConfig, getFeatures } from '../company/service.ts';
import { Masters } from '../vouchers/masters.ts';
import { loadVoucherType, type VoucherTypeInfo } from '../vouchers/numbering.ts';
import { buildPosting, type PostingEnv, type PostingPlan } from '../vouchers/posting.ts';
import { getVoucher, gstLinesView } from '../vouchers/queries.ts';
import { loadCompanyEssentials, loadVoucherRow, normalizeInput, parseJson, parseMeta, storedInput, modeOfRow, type VoucherRow } from '../vouchers/service.ts';
import { complianceWarnings } from './compliance.ts';
import { baseDirection, copyLabels, documentTitle, isSalesDocument, partyLabels, type CompanyGstStatus } from './titles.ts';

// ───────────────────────────── Shared context (one per request / batch) ─────────────────────────────

export interface PrintEnv {
  ctx: CompanyCtx;
  db: Db;
  profile: CompanyProfile;
  features: CompanyFeatures;
  config: CompanyConfig;
  posting: PostingEnv;
  masters: Masters;
}

export function loadPrintEnv(ctx: CompanyCtx): PrintEnv {
  const { db } = ctx;
  const features = getFeatures(db);
  const config = getConfig(db);
  return {
    ctx,
    db,
    profile: getCompanyProfile(db),
    features,
    config,
    posting: { db, today: ctx.clock.today(), features, config, company: loadCompanyEssentials(db) },
    masters: new Masters(db),
  };
}

// ───────────────────────────── Small helpers ─────────────────────────────

const txt = (s: string | null | undefined): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
};

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

const INWARD_NATURES: ReadonlySet<GstNature> = new Set<GstNature>([
  'inward_b2b',
  'inward_rcm',
  'inward_unregistered',
  'inward_composition',
  'import_goods',
  'import_services',
  'inward_sez',
  'inward_nil_exempt',
]);

const GST_BASES: ReadonlySet<VoucherBaseType> = new Set<VoucherBaseType>(['sales', 'purchase', 'credit_note', 'debit_note']);

export function companyGstStatus(env: PrintEnv): CompanyGstStatus {
  return env.features.gst ? env.profile.gstRegistrationType : 'unregistered';
}

/** Rupees with exactly two decimals from paise, integer arithmetic only: 118050 → '1180.50'. */
export function rupeesText(p: Paise): string {
  const abs = Math.abs(p);
  return `${p < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * UPI deep link (NPCI linking specification): upi://pay?pa=<vpa>&pn=<payee>&am=<amount>&cu=INR&tn=<note>.
 * Every value is percent-encoded; the amount has two decimals.
 */
export function upiUri(p: { id: string; payeeName: string; amount: Paise; note: string }): string {
  const enc = encodeURIComponent;
  const parts = [`pa=${enc(p.id)}`, `pn=${enc(p.payeeName.slice(0, 99))}`];
  if (p.amount > 0) parts.push(`am=${rupeesText(p.amount)}`);
  parts.push('cu=INR');
  if (p.note) parts.push(`tn=${enc(p.note.slice(0, 80))}`);
  return `upi://pay?${parts.join('&')}`;
}

export function placeOfSupply(code: string | null): PrintVoucherData['placeOfSupply'] {
  const c = txt(code);
  if (!c) return null;
  const st = getState(c);
  if (!st) return { code: c, name: c, label: c };
  return { code: st.code, name: st.name, label: stateLabel(st.code) };
}

export function address(a: {
  name?: string | null;
  address?: string | null;
  pincode?: string | null;
  stateCode?: string | null;
  country?: string | null;
  gstin?: string | null;
  pan?: string | null;
  registrationType?: string | null;
  phone?: string | null;
  email?: string | null;
}): PrintAddress {
  const sc = txt(a.stateCode);
  const name = sc ? stateName(sc) : '';
  return {
    name: txt(a.name),
    address: txt(a.address),
    pincode: txt(a.pincode),
    stateCode: sc,
    stateName: name || null,
    country: txt(a.country),
    gstin: txt(a.gstin)?.toUpperCase() ?? null,
    pan: txt(a.pan)?.toUpperCase() ?? null,
    registrationType: txt(a.registrationType),
    phone: txt(a.phone),
    email: txt(a.email),
  };
}

export function printCompany(env: PrintEnv): PrintCompany {
  const p = env.profile;
  const status = companyGstStatus(env);
  const base = address({
    name: p.name,
    address: p.address,
    pincode: p.pincode,
    stateCode: p.stateCode,
    country: p.country,
    gstin: status === 'unregistered' ? null : p.gstin,
    pan: p.pan ?? (p.gstin && p.gstin.length === 15 ? p.gstin.slice(2, 12) : null),
    phone: [p.phone, p.mobile].map(txt).filter((x): x is string => x !== null).join(', ') || null,
    email: p.email,
  });
  return {
    ...base,
    displayName: txt(p.mailingName) ?? p.name,
    website: txt(p.website),
    cin: txt(p.cin),
    gstRegistrationType: status,
    logo: p.logo,
  };
}

export function resolveOptions(env: PrintEnv, vtConfig: Record<string, unknown>, overrides?: InvoicePrintOverrides): InvoicePrintOptions {
  const base: InvoicePrintOptions = { ...env.config.invoice, copies: [...env.config.invoice.copies] };
  const str = (k: string): string | undefined => (typeof vtConfig[k] === 'string' && (vtConfig[k] as string).trim() !== '' ? (vtConfig[k] as string) : undefined);
  const tpl = vtConfig.printTemplate;
  if (tpl === 'modern' || tpl === 'classic' || tpl === 'compact') base.template = tpl;
  const bank = vtConfig.bankLedgerId;
  if (typeof bank === 'number' && Number.isInteger(bank) && bank > 0) base.bankLedgerId = bank;
  base.declaration = str('declaration') ?? base.declaration;
  base.terms = str('terms') ?? base.terms;
  if (!overrides) return base;
  const out = { ...base };
  for (const [k, val] of Object.entries(overrides) as Array<[keyof InvoicePrintOptions, unknown]>) {
    if (val !== undefined) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}

/** Groups under Bank Accounts / Bank OD (nested groups included). */
const BANK_GROUPS_CTE = `WITH RECURSIVE g(id) AS (
    SELECT id FROM groups WHERE reserved_code IN ('BANK_ACCOUNTS', 'BANK_OD')
    UNION SELECT c.id FROM groups c JOIN g ON c.parent_id = g.id)`;

/**
 * Account details of a bank ledger for printing. Only ledgers under Bank Accounts / Bank OD qualify, so
 * a stale or hand-edited bankLedgerId can never print (or disclose) a party's own bank details.
 */
export function bankDetails(db: Db, ledgerId: number | null): PrintBank | null {
  if (ledgerId === null) return null;
  const r = db.get<{
    id: number;
    name: string;
    bank_account_holder: string | null;
    bank_account_no: string | null;
    bank_ifsc: string | null;
    bank_name: string | null;
    bank_branch: string | null;
    bank_upi_id: string | null;
  }>(
    `${BANK_GROUPS_CTE}
     SELECT id, name, bank_account_holder, bank_account_no, bank_ifsc, bank_name, bank_branch, bank_upi_id
       FROM ledgers WHERE id = :id AND group_id IN (SELECT id FROM g)`,
    { id: ledgerId },
  );
  if (!r) return null;
  return {
    ledgerId: r.id,
    ledgerName: r.name,
    accountHolder: txt(r.bank_account_holder),
    accountNo: txt(r.bank_account_no),
    ifsc: txt(r.bank_ifsc)?.toUpperCase() ?? null,
    bankName: txt(r.bank_name) ?? r.name,
    branch: txt(r.bank_branch),
    upiId: txt(r.bank_upi_id),
  };
}

/** Bank ledgers (Bank Accounts / Bank OD, nested groups included) for the print settings picker. */
export function listBankLedgers(db: Db): PrintBank[] {
  const ids = db.all<{ id: number }>(
    `${BANK_GROUPS_CTE}
     SELECT l.id FROM ledgers l WHERE l.group_id IN (SELECT id FROM g) AND l.is_active = 1 ORDER BY l.name COLLATE NOCASE`,
    {},
  );
  return ids.map((r) => bankDetails(db, r.id)).filter((b): b is PrintBank => b !== null);
}

function navigation(db: Db, row: VoucherRow): PrintVoucherData['navigation'] {
  const p = { vt: row.voucher_type_id, d: row.date, seq: row.number_seq ?? 0, id: row.id };
  const prev = db.value<number>(
    `SELECT id FROM vouchers WHERE voucher_type_id = :vt
        AND (date < :d OR (date = :d AND (COALESCE(number_seq, 0) < :seq OR (COALESCE(number_seq, 0) = :seq AND id < :id))))
      ORDER BY date DESC, COALESCE(number_seq, 0) DESC, id DESC LIMIT 1`,
    p,
  );
  const next = db.value<number>(
    `SELECT id FROM vouchers WHERE voucher_type_id = :vt
        AND (date > :d OR (date = :d AND (COALESCE(number_seq, 0) > :seq OR (COALESCE(number_seq, 0) = :seq AND id > :id))))
      ORDER BY date ASC, COALESCE(number_seq, 0) ASC, id ASC LIMIT 1`,
    p,
  );
  return { prevId: prev ?? null, nextId: next ?? null };
}

const REF_LABEL: Record<string, string> = { new: 'New Ref', against: 'Agst Ref', advance: 'Advance', on_account: 'On Account' };

function billText(b: BillAllocationView): string {
  const label = REF_LABEL[b.refType] ?? b.refType;
  const name = b.billName ? ` ${b.billName}` : '';
  const due = b.refType === 'new' && b.dueDate ? ` (due ${formatDate(b.dueDate)})` : '';
  return `${label}${name}: ${formatMoney(Math.abs(b.amount))} ${b.amount >= 0 ? 'Dr' : 'Cr'}${due}`;
}

const INSTRUMENT_LABEL: Record<string, string> = {
  cheque: 'Cheque',
  dd: 'Demand Draft',
  neft: 'NEFT',
  rtgs: 'RTGS',
  imps: 'IMPS',
  upi: 'UPI',
  card: 'Card',
  cash: 'Cash',
  other: 'Ref',
};

export function instrumentText(i: InstrumentInput | null | undefined): string | null {
  if (!i) return null;
  const parts: string[] = [INSTRUMENT_LABEL[i.type] ?? i.type];
  if (txt(i.number)) parts[0] += ` ${txt(i.number)}`;
  if (txt(i.date)) parts[0] += ` dated ${formatDate(i.date)}`;
  if (txt(i.bankName)) parts.push(txt(i.bankName) as string);
  if (txt(i.favouring)) parts.push(`favouring ${txt(i.favouring)}`);
  return parts.join(', ');
}

function references(order: OrderDetailsInput | null, dispatch: DispatchDetailsInput | null, exp: ExportDetailsInput | null, dueDate: string | null): PrintRef[] {
  const out: PrintRef[] = [];
  const add = (label: string, value: string | null | undefined): void => {
    const v = txt(value);
    if (v) out.push({ label, value: v });
  };
  const date = (d: string | null | undefined): string | null => (txt(d) ? formatDate(d) : null);
  if (order) {
    add("Buyer's Order No.", order.buyersOrderNo ?? order.orderNo);
    add('Order Date', date(order.orderDate));
    add('Delivery Note No.', order.deliveryNoteNo);
    add('Other References', order.otherRefs);
    add('Terms of Delivery', order.terms);
  }
  if (dispatch) {
    add('Dispatch Doc No.', dispatch.docNo);
    add('Dispatched through', dispatch.through);
    add('Destination', dispatch.destination);
    add('Mode of Transport', dispatch.mode);
    add('Vehicle No.', dispatch.vehicleNo?.toUpperCase());
    const transporter = [txt(dispatch.transporterName), txt(dispatch.transporterId) ? `ID ${txt(dispatch.transporterId)}` : null].filter(Boolean).join(', ');
    add('Transporter', transporter);
    add('LR / RR No.', [txt(dispatch.lrNo), date(dispatch.lrDate)].filter(Boolean).join(' dated '));
    if (typeof dispatch.distanceKm === 'number' && dispatch.distanceKm > 0) add('Distance', `${dispatch.distanceKm} km`);
  }
  if (exp) {
    add('Shipping Bill No.', [txt(exp.shippingBillNo), date(exp.shippingBillDate)].filter(Boolean).join(' dated '));
    add('Port Code', exp.portCode);
    add('Currency', exp.currency);
  }
  add('Payment Due', date(dueDate));
  return out;
}

// ───────────────────────────── Summaries & totals over print lines ─────────────────────────────

export function summariseByRate(lines: readonly PrintLine[]): PrintTaxRateRow[] {
  const map = new Map<string, PrintTaxRateRow>();
  for (const l of lines) {
    if (l.absorbed || (l.taxableValue === 0 && l.tax === 0)) continue;
    const key = `${l.taxability}|${l.gstRate}|${l.cessRate}|${l.reverseCharge ? 1 : 0}`;
    let r = map.get(key);
    if (!r) {
      r = { taxability: l.taxability, rate: l.gstRate, cessRate: l.cessRate, reverseCharge: l.reverseCharge, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, tax: 0 };
      map.set(key, r);
    }
    r.taxableValue += l.taxableValue;
    r.cgst += l.cgst;
    r.sgst += l.sgst;
    r.igst += l.igst;
    r.cess += l.cess;
    r.tax += l.tax;
  }
  const order: Record<Taxability, number> = { taxable: 0, nil_rated: 1, exempt: 2, non_gst: 3 };
  return [...map.values()].sort((a, b) => order[a.taxability] - order[b.taxability] || a.rate - b.rate || a.cessRate - b.cessRate || Number(a.reverseCharge) - Number(b.reverseCharge));
}

export function summariseByHsn(lines: readonly PrintLine[]): PrintHsnRow[] {
  const map = new Map<string, PrintHsnRow>();
  for (const l of lines) {
    if (l.absorbed || (l.taxableValue === 0 && l.tax === 0)) continue;
    const hsn = l.hsnSac ?? '';
    const key = `${hsn}|${l.gstRate}`;
    let r = map.get(key);
    if (!r) {
      r = { hsnSac: hsn, description: l.name, qty: null, unit: null, rate: l.gstRate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, tax: 0 };
      map.set(key, r);
    }
    if (l.kind === 'item' && l.qty !== null) {
      if (r.qty === null) {
        r.qty = l.qty;
        r.unit = l.unit;
      } else if (r.unit === l.unit) {
        r.qty = Math.round((r.qty + l.qty) * 1e6) / 1e6;
      } else {
        r.unit = null; // mixed units: quantity not meaningful
      }
    }
    r.taxableValue += l.taxableValue;
    r.cgst += l.cgst;
    r.sgst += l.sgst;
    r.igst += l.igst;
    r.cess += l.cess;
    r.tax += l.tax;
  }
  return [...map.values()]
    .map((r) => (r.qty !== null && r.unit === null ? { ...r, qty: null } : r))
    .sort((a, b) => a.hsnSac.localeCompare(b.hsnSac) || a.rate - b.rate);
}

function qtyTotals(lines: readonly PrintLine[]): Pick<PrintTotals, 'qty' | 'unit' | 'qtyDecimals'> {
  const withQty = lines.filter((l) => l.qty !== null && l.kind === 'item');
  if (withQty.length === 0) return { qty: null, unit: null, qtyDecimals: 0 };
  const unit = withQty[0].unit;
  if (!withQty.every((l) => l.unit === unit)) return { qty: null, unit: null, qtyDecimals: 0 };
  return {
    qty: Math.round(sum(withQty.map((l) => l.qty as number)) * 1e6) / 1e6,
    unit,
    qtyDecimals: Math.max(...withQty.map((l) => l.qtyDecimals)),
  };
}

/** Invoice totals from lines + charges + round-off. grandTotal = taxable + tax + charges + roundOff. */
export function invoiceTotals(lines: readonly PrintLine[], charges: readonly PrintCharge[], roundOff: Paise): PrintTotals {
  const payable = lines.filter((l) => l.taxPayable);
  const cgst = sum(payable.map((l) => l.cgst));
  const sgst = sum(payable.map((l) => l.sgst));
  const igst = sum(payable.map((l) => l.igst));
  const cess = sum(payable.map((l) => l.cess));
  const tax = cgst + sgst + igst + cess;
  const taxable = sum(lines.map((l) => l.taxableValue));
  const chargeTotal = sum(charges.map((c) => c.amount));
  return {
    ...qtyTotals(lines),
    discount: sum(lines.map((l) => l.discount)),
    taxable,
    cgst,
    sgst,
    igst,
    cess,
    tax,
    reverseChargeTax: sum(lines.filter((l) => !l.taxPayable).map((l) => l.tax)),
    charges: chargeTotal,
    roundOff,
    grandTotal: taxable + tax + chargeTotal + roundOff,
  };
}

// ───────────────────────────── Invoice layout: from the engine ─────────────────────────────

interface InvoiceBuild {
  lines: PrintLine[];
  charges: PrintCharge[];
  roundOff: Paise;
  taxMode: TaxMode;
  interState: boolean;
  nature: GstNature | null;
  gstLines: GstLineView[] | null;
  header: { taxable: Paise; tax: Paise; total: Paise; roundOff: Paise } | null;
}

function pinnedInput(row: VoucherRow, input: VoucherInput): VoucherInput {
  const party = {
    ...(input.party ?? {}),
    ...(txt(row.party_name) ? { name: row.party_name as string } : {}),
    ...(txt(row.party_address) ? { address: row.party_address as string } : {}),
    ...(txt(row.party_state_code) ? { stateCode: row.party_state_code as string } : {}),
    ...(txt(row.party_gstin) ? { gstin: row.party_gstin as string } : {}),
    ...(txt(row.party_registration_type) ? { registrationType: row.party_registration_type as NonNullable<VoucherInput['party']>['registrationType'] } : {}),
    ...(txt(row.party_pincode) ? { pincode: row.party_pincode as string } : {}),
  };
  return normalizeInput({
    ...input,
    id: row.id,
    party,
    ...(txt(row.place_of_supply) ? { placeOfSupply: row.place_of_supply as string } : {}),
  });
}

function fromEngine(env: PrintEnv, row: VoucherRow, vt: VoucherTypeInfo, input: VoucherInput): { build: InvoiceBuild; plan: PostingPlan } | null {
  const plan = buildPosting(env.posting, pinnedInput(row, input), { voucherType: vt, number: row.number, voucherId: row.id });
  const comp = plan.computation;
  if (!comp) return null;
  const items = plan.normalizedInput.items ?? [];
  const ledgers = plan.normalizedInput.ledgers ?? [];
  const masters = plan.masters;
  const used = new Set<number>();
  const lines: PrintLine[] = [];
  comp.lines.forEach((cl, j) => {
    const m = /^([il])(\d+)$/.exec(cl.key);
    const idx = m ? Number(m[2]) : j;
    const common = {
      sl: lines.length + 1,
      hsnSac: txt(cl.hsnSac),
      discount: cl.discount,
      amount: cl.postingAmount,
      taxableValue: cl.taxableValue,
      taxability: cl.taxability,
      gstRate: cl.taxability === 'taxable' ? cl.rate : 0,
      cessRate: cl.cessRate,
      cgst: cl.cgst,
      sgst: cl.sgst,
      igst: cl.igst,
      cess: cl.cess,
      tax: cl.tax,
      taxPayable: cl.taxPayableToParty || cl.tax === 0,
      absorbed: cl.absorbed,
      reverseCharge: cl.reverseCharge,
      section: null,
    } as const;
    if (m?.[1] === 'i' && items[idx]) {
      const it = items[idx];
      const item = masters.item(it.itemId);
      const inv = plan.inventory.find((l) => l.lineNo === idx + 1);
      lines.push({
        ...common,
        kind: 'item',
        name: item.name,
        description: txt(it.description),
        batch: txt(it.batchName),
        qty: it.billedQty ?? it.qty,
        unit: item.unit_symbol,
        qtyDecimals: item.unit_decimals,
        rate: inv?.rate ?? it.rate ?? 0,
        discountPct: it.discountPct ?? 0,
      });
    } else {
      const ll = ledgers[idx];
      used.add(idx);
      const name = ll ? masters.ledger(ll.ledgerId).name : (cl.description ?? 'Charges');
      lines.push({
        ...common,
        kind: 'ledger',
        name,
        description: txt(ll?.narration),
        batch: null,
        qty: null,
        unit: null,
        qtyDecimals: 0,
        rate: null,
        discountPct: 0,
      });
    }
  });
  const charges: PrintCharge[] = [];
  ledgers.forEach((ll, i) => {
    if (used.has(i) || ll.amount === 0) return;
    charges.push({ name: masters.ledger(ll.ledgerId).name, amount: ll.amount });
  });
  return {
    plan,
    build: {
      lines,
      charges,
      roundOff: comp.totals.roundOff,
      taxMode: comp.taxMode,
      interState: comp.interState,
      nature: plan.header.gstNature,
      gstLines: plan.gstLines.map((g, i) => ({ lineNo: i + 1, ...g })),
      header: { taxable: plan.header.taxableAmount, tax: plan.header.taxAmount, total: plan.header.totalAmount, roundOff: plan.header.roundOff },
    },
  };
}

/** Do the engine's figures equal the books (header and gst_lines)? Returns the first difference, or null. */
function bookDifference(row: VoucherRow, build: InvoiceBuild, storedGst: readonly GstLineView[]): string | null {
  const h = build.header;
  if (!h) return 'no header totals';
  if (h.taxable !== row.taxable_amount) return `taxable value ${formatMoney(h.taxable)} vs ${formatMoney(row.taxable_amount)} in the books`;
  if (h.tax !== row.tax_amount) return `tax ${formatMoney(h.tax)} vs ${formatMoney(row.tax_amount)} in the books`;
  const engineGst = build.gstLines ?? [];
  if (storedGst.length > 0 || engineGst.length > 0) {
    if (storedGst.length !== engineGst.length) return `${engineGst.length} GST lines vs ${storedGst.length} in the books`;
    for (let i = 0; i < storedGst.length; i++) {
      const a = engineGst[i];
      const b = storedGst[i];
      if (a.taxableValue !== b.taxableValue || a.igst !== b.igst || a.cgst !== b.cgst || a.sgst !== b.sgst || a.cess !== b.cess || a.rate !== b.rate) {
        return `GST line ${i + 1} differs from the books`;
      }
    }
  }
  return null;
}

// ───────────────────────────── Invoice layout: from the books ─────────────────────────────

interface StoredInv {
  line_no: number;
  item_id: number;
  item_name: string;
  unit: string;
  unit_decimals: number | null;
  qty: number;
  billed_qty: number | null;
  rate: number;
  discount_pct: number;
  amount: number;
  hsn_sac: string | null;
  gst_rate: number | null;
  batch_name: string | null;
  description: string | null;
}

function fromBooks(env: PrintEnv, row: VoucherRow, base: VoucherBaseType): InvoiceBuild {
  const { db } = env;
  const inv = db.all<StoredInv>(
    `SELECT ie.line_no, ie.item_id, si.name AS item_name, u.symbol AS unit, u.decimal_places AS unit_decimals, ie.qty, ie.billed_qty,
            ie.rate, ie.discount_pct, ie.amount, ie.hsn_sac, ie.gst_rate, ie.batch_name, ie.description
       FROM inventory_entries ie JOIN stock_items si ON si.id = ie.item_id JOIN units u ON u.id = si.unit_id
      WHERE ie.voucher_id = :id ORDER BY ie.line_no, ie.id`,
    { id: row.id },
  );
  const gst = gstLinesView(db, row.id);
  const importGoods = row.gst_nature === 'import_goods';
  // IGST on imported goods — and on goods from an SEZ unit (an import on a bill of entry) — is paid at customs, not to the supplier.
  const atCustoms = (g: GstLineView | null): boolean => importGoods || (row.gst_nature === 'inward_sez' && g?.supplyType === 'goods');
  const lines: PrintLine[] = [];
  const usedInv = new Set<number>();
  const itemLine = (r: StoredInv | null, g: GstLineView | null): void => {
    const qty = r ? Math.abs(r.billed_qty ?? r.qty) : (g?.qty ?? null);
    const rate = r ? r.rate : null;
    const taxable = g ? g.taxableValue : (r?.amount ?? 0);
    const discountPct = r?.discount_pct ?? 0;
    const gross = qty !== null && rate !== null ? lineAmount(qty, rate) : taxable;
    const tax = g ? g.igst + g.cgst + g.sgst + g.cess : 0;
    lines.push({
      sl: lines.length + 1,
      kind: 'item',
      name: r?.item_name ?? g?.description ?? '',
      description: txt(r?.description),
      hsnSac: txt(g?.hsnSac ?? r?.hsn_sac),
      batch: txt(r?.batch_name),
      qty,
      unit: r?.unit ?? g?.uqc ?? null,
      qtyDecimals: r?.unit_decimals ?? 2,
      rate,
      discountPct,
      discount: discountPct > 0 ? Math.max(0, gross - taxable) : 0,
      amount: taxable,
      taxableValue: taxable,
      taxability: g?.taxability ?? 'taxable',
      gstRate: g ? (g.taxability === 'taxable' ? g.rate : 0) : (r?.gst_rate ?? 0),
      cessRate: g?.cessRate ?? 0,
      cgst: g?.cgst ?? 0,
      sgst: g?.sgst ?? 0,
      igst: g?.igst ?? 0,
      cess: g?.cess ?? 0,
      tax,
      taxPayable: tax === 0 || !(g?.isReverseCharge || atCustoms(g)),
      absorbed: false,
      reverseCharge: g?.isReverseCharge ?? false,
      section: null,
    });
  };
  for (const g of gst) {
    if (g.source === 'item') {
      const idx = inv.findIndex((r, i) => !usedInv.has(i) && r.item_id === g.itemId);
      if (idx >= 0) usedInv.add(idx);
      itemLine(idx >= 0 ? inv[idx] : null, g);
    } else {
      const tax = g.igst + g.cgst + g.sgst + g.cess;
      lines.push({
        sl: lines.length + 1,
        kind: 'ledger',
        name: g.description ?? (g.ledgerId !== null ? env.masters.ledger(g.ledgerId).name : 'Charges'),
        description: null,
        hsnSac: txt(g.hsnSac),
        batch: null,
        qty: null,
        unit: null,
        qtyDecimals: 0,
        rate: null,
        discountPct: 0,
        discount: 0,
        amount: g.taxableValue,
        taxableValue: g.taxableValue,
        taxability: g.taxability,
        gstRate: g.taxability === 'taxable' ? g.rate : 0,
        cessRate: g.cessRate,
        cgst: g.cgst,
        sgst: g.sgst,
        igst: g.igst,
        cess: g.cess,
        tax,
        taxPayable: tax === 0 || !(g.isReverseCharge || atCustoms(g)),
        absorbed: false,
        reverseCharge: g.isReverseCharge,
        section: null,
      });
    }
  }
  // Item lines with no GST line (non-GST company): their stored value is the taxable value.
  inv.forEach((r, i) => {
    if (!usedInv.has(i)) itemLine(r, null);
  });

  // Charges: ledger entries of this voucher that are neither the party, tax, round-off, nor a GST line.
  const s = base === 'sales' || base === 'debit_note' ? 1 : -1;
  const gstLedgers = new Set(gst.filter((g) => g.ledgerId !== null).map((g) => g.ledgerId as number));
  const entries = db.all<{ ledger_id: number; name: string; amount: number; role: string }>(
    `SELECT le.ledger_id, l.name, le.amount, le.role FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
      WHERE le.voucher_id = :id ORDER BY le.line_no`,
    { id: row.id },
  );
  // Accounting invoice without GST lines (company not under GST): the sales / purchase ledgers are the lines.
  if (gst.length === 0 && inv.length === 0) {
    for (const e of entries) {
      if (e.role !== 'sales' && e.role !== 'purchase') continue;
      lines.push({
        sl: lines.length + 1,
        kind: 'ledger',
        name: e.name,
        description: null,
        hsnSac: null,
        batch: null,
        qty: null,
        unit: null,
        qtyDecimals: 0,
        rate: null,
        discountPct: 0,
        discount: 0,
        amount: -s * e.amount,
        taxableValue: -s * e.amount,
        taxability: 'non_gst',
        gstRate: 0,
        cessRate: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        cess: 0,
        tax: 0,
        taxPayable: true,
        absorbed: false,
        reverseCharge: false,
        section: null,
      });
    }
  }
  const charges: PrintCharge[] = [];
  const itemTaxable = sum(lines.filter((l) => l.kind === 'item').map((l) => l.taxableValue));
  const itemLedgerPosted = sum(entries.filter((e) => e.role === 'sales' || e.role === 'purchase').filter((e) => !gstLedgers.has(e.ledger_id)).map((e) => -s * e.amount));
  for (const e of entries) {
    if (e.role !== 'charge' || gstLedgers.has(e.ledger_id)) continue;
    charges.push({ name: e.name, amount: -s * e.amount });
  }
  // Absorbed charges (freight included in the goods' taxable value) post to their own ledger with role
  // 'charge'; the sales/purchase ledgers then carry less than the item lines' taxable value. That gap
  // identifies them. Their value is taken back out of the item lines (by value, largest remainder) so
  // the Amount column still adds up to the taxable value.
  let absorbedLeft = itemTaxable - itemLedgerPosted;
  if (charges.length > 0 && absorbedLeft > 0) {
    const absorbedLines: PrintLine[] = [];
    for (const c of charges) {
      if (c.amount <= 0 || c.amount > absorbedLeft) continue;
      absorbedLines.push({
        sl: 0,
        kind: 'ledger',
        name: c.name,
        description: null,
        hsnSac: null,
        batch: null,
        qty: null,
        unit: null,
        qtyDecimals: 0,
        rate: null,
        discountPct: 0,
        discount: 0,
        amount: c.amount,
        taxableValue: 0,
        taxability: 'taxable',
        gstRate: 0,
        cessRate: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        cess: 0,
        tax: 0,
        taxPayable: true,
        absorbed: true,
        reverseCharge: false,
        section: null,
      });
      absorbedLeft -= c.amount;
      c.amount = 0;
    }
    const absorbedTotal = sum(absorbedLines.map((l) => l.amount));
    const goods = lines.filter((l) => l.kind === 'item');
    if (absorbedTotal > 0 && goods.length > 0) {
      const shares = allocate(absorbedTotal, goods.map((l) => Math.max(0, l.taxableValue)));
      goods.forEach((l, i) => {
        l.amount -= shares[i];
      });
      for (const l of absorbedLines) lines.push({ ...l, sl: lines.length + 1 });
    }
  }
  const realCharges = charges.filter((c) => c.amount !== 0);

  const pos = txt(row.place_of_supply);
  const companyState = env.profile.stateCode ?? '';
  const interState = gst.some((g) => g.igst !== 0) || (pos !== null && pos !== companyState);
  const taxMode: TaxMode = companyGstStatus(env) !== 'regular' ? 'none' : interState ? 'igst' : isUtgstState(pos ?? companyState) ? 'cgst_utgst' : 'cgst_sgst';
  return {
    lines,
    charges: realCharges,
    roundOff: row.round_off,
    taxMode,
    interState,
    nature: (row.gst_nature as GstNature | null) ?? null,
    gstLines: gst,
    header: { taxable: row.taxable_amount, tax: row.tax_amount, total: row.total_amount, roundOff: row.round_off },
  };
}

// ───────────────────────────── Inventory layout ─────────────────────────────

function inventoryLines(env: PrintEnv, base: VoucherBaseType, input: VoucherInput): PrintLine[] {
  const masters = env.masters;
  return (input.items ?? []).map((it, i) => {
    const item = masters.item(it.itemId);
    const valueQty = it.billedQty ?? it.qty;
    const amount = it.amount ?? lineAmount(valueQty, it.rate ?? 0, it.discountPct ?? 0);
    const gross = lineAmount(valueQty, it.rate ?? 0);
    const godown = env.features.multipleGodowns && it.godownId ? masters.godown(it.godownId).name : null;
    return {
      sl: i + 1,
      kind: 'item',
      name: item.name,
      description: [txt(it.description), godown ? `Godown: ${godown}` : null].filter(Boolean).join(' · ') || null,
      hsnSac: txt(item.hsn_sac),
      batch: txt(it.batchName),
      qty: valueQty,
      unit: item.unit_symbol,
      qtyDecimals: item.unit_decimals,
      rate: it.rate ?? 0,
      discountPct: it.discountPct ?? 0,
      discount: it.amount === undefined && (it.discountPct ?? 0) > 0 ? gross - amount : 0,
      amount,
      taxableValue: amount,
      taxability: 'taxable',
      gstRate: 0,
      cessRate: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
      tax: 0,
      taxPayable: true,
      absorbed: false,
      reverseCharge: false,
      section: base === 'stock_journal' ? (it.isConsumption ? 'consumption' : 'production') : null,
    } satisfies PrintLine;
  });
}

// ───────────────────────────── Voucher layout ─────────────────────────────

function voucherEntries(env: PrintEnv, id: number, cancelled: boolean, input: VoucherInput): PrintEntry[] {
  const masters = env.masters;
  if (cancelled) {
    return (input.ledgers ?? []).map((l) => {
      const L = masters.ledgerOrNull(l.ledgerId);
      return {
        ledgerName: L?.name ?? `Ledger #${l.ledgerId}`,
        amount: l.amount,
        debit: l.amount > 0 ? l.amount : 0,
        credit: l.amount < 0 ? -l.amount : 0,
        isCashBank: L?.isCashBank ?? false,
        narration: txt(l.narration),
        instrument: instrumentText(l.instrument),
        bills: [],
        costCentres: [],
      };
    });
  }
  const detail = getVoucher(env.db, id);
  return detail.entries.map((e) => ({
    ledgerName: e.ledgerName,
    amount: e.amount,
    debit: e.amount > 0 ? e.amount : 0,
    credit: e.amount < 0 ? -e.amount : 0,
    isCashBank: masters.ledgerOrNull(e.ledgerId)?.isCashBank ?? false,
    narration: txt(e.narration),
    instrument: instrumentText(e.instrument),
    bills: e.billAllocations.map(billText),
    costCentres: e.costAllocations.map((c) => `${c.costCentreName ?? `Cost centre #${c.costCentreId}`}: ${formatMoney(Math.abs(c.amount))}`),
  }));
}

// ───────────────────────────── Main builder ─────────────────────────────

export function buildPrintData(env: PrintEnv, id: number, overrides?: InvoicePrintOverrides): PrintVoucherData {
  const { db } = env;
  const row = loadVoucherRow(db, id);
  if (!row) throw notFound('Voucher', id);
  const base = row.base_type as VoucherBaseType;
  const vt = loadVoucherType(db, row.voucher_type_id);
  const vtConfig = vt.config ?? {};
  const options = resolveOptions(env, vtConfig, overrides);
  const mode = modeOfRow(row);
  const input = storedInput(db, row);
  const meta = parseMeta(row.meta);
  const cancelled = row.is_cancelled === 1;
  const warnings: string[] = [];
  const masters = env.masters;
  const companyGst = companyGstStatus(env);

  const hasStoredGst = db.value<number>('SELECT COUNT(*) FROM gst_lines WHERE voucher_id = :id', { id }) ?? 0;
  let layout: PrintLayout = mode === 'item_invoice' || mode === 'accounting_invoice' ? 'invoice' : mode === 'inventory' ? 'inventory' : 'voucher';
  // Imported vouchers without entry detail: GST documents with gst_lines still print as invoices.
  if (layout === 'voucher' && GST_BASES.has(base) && !meta.input && hasStoredGst > 0) layout = 'invoice';

  // Direction: the GST nature when known, else the base type (a debit note to a customer is outward).
  const partyInfo = row.party_ledger_id !== null ? masters.ledgerOrNull(row.party_ledger_id) : null;
  let direction = baseDirection(base);
  const storedNature = (row.gst_nature as GstNature | null) ?? null;
  if (storedNature) direction = INWARD_NATURES.has(storedNature) ? 'inward' : 'outward';
  else if (base === 'debit_note' && partyInfo?.isDebtor) direction = 'outward';

  // ── Lines ──
  let build: InvoiceBuild | null = null;
  let lines: PrintLine[] = [];
  let charges: PrintCharge[] = [];
  let totals: PrintTotals;
  if (layout === 'invoice') {
    let engine: { build: InvoiceBuild; plan: PostingPlan } | null = null;
    if (meta.input) {
      try {
        engine = fromEngine(env, row, vt, input);
      } catch (err) {
        warnings.push(
          `The invoice lines could not be recalculated (${err instanceof Error ? err.message : 'unknown reason'}); they are printed from the books.`,
        );
      }
    }
    if (engine) {
      build = engine.build;
      if (!cancelled) {
        const diff = bookDifference(row, build, gstLinesView(db, id));
        if (diff) {
          warnings.push(
            `Masters changed after this voucher was saved (${diff}), so it is printed from the books. ` +
              'Open the voucher and save it again to print it with the current GST details.',
          );
          build = fromBooks(env, row, base);
        } else if (build.header && row.round_off !== build.roundOff && build.header.total - build.roundOff + row.round_off === row.total_amount) {
          // Round-off settings changed since saving: keep the voucher's own round-off.
          build = { ...build, roundOff: row.round_off };
        }
      }
    } else {
      build = fromBooks(env, row, base);
    }
    lines = build.lines;
    charges = build.charges;
    totals = invoiceTotals(lines, charges, build.roundOff);
    if (!cancelled && totals.grandTotal !== row.total_amount) {
      warnings.push(
        `The printed total ${formatMoney(totals.grandTotal)} differs from the voucher value ${formatMoney(row.total_amount)} in the books. ` +
          'Check the voucher before sending this document.',
      );
    }
  } else if (layout === 'inventory') {
    lines = inventoryLines(env, base, input);
    const valueLines = base === 'stock_journal' ? lines.filter((l) => l.section !== 'consumption') : lines;
    const total = sum(valueLines.map((l) => l.amount));
    totals = {
      ...qtyTotals(base === 'stock_journal' ? valueLines : lines),
      discount: sum(lines.map((l) => l.discount)),
      taxable: total,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
      tax: 0,
      reverseChargeTax: 0,
      charges: 0,
      roundOff: 0,
      grandTotal: total,
    };
  } else {
    lines = [];
    totals = {
      qty: null,
      unit: null,
      qtyDecimals: 0,
      discount: 0,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
      tax: 0,
      reverseChargeTax: 0,
      charges: 0,
      roundOff: 0,
      grandTotal: 0,
    };
  }
  const entries = layout === 'voucher' ? voucherEntries(env, id, cancelled, input) : [];
  if (layout === 'voucher') totals = { ...totals, grandTotal: sum(entries.map((e) => e.debit)) };

  // ── Title ──
  const counted = lines.filter((l) => !l.absorbed && (l.taxableValue !== 0 || l.tax !== 0));
  const hasTaxedLine = counted.some((l) => l.taxability === 'taxable' && l.gstRate > 0);
  const hasUntaxedLine = counted.some((l) => l.taxability !== 'taxable' || l.gstRate === 0);
  const exportDetails = parseJson<ExportDetailsInput>(row.export_details);
  const nature = build?.nature ?? storedNature;
  const title = documentTitle(
    {
      baseType: base,
      layout,
      companyGst,
      direction,
      nature,
      hasTaxedLine,
      hasUntaxedLine,
      exportWithPayment: exportDetails?.withPayment === true,
      partyRegistration: txt(row.party_registration_type),
    },
    typeof vtConfig.printTitle === 'string' ? vtConfig.printTitle : null,
  );
  const reverseCharge = row.is_reverse_charge === 1 || lines.some((l) => l.reverseCharge);
  const notes = [...title.notes];
  if (reverseCharge && direction === 'outward' && layout === 'invoice' && !notes.includes('Tax on this supply is payable by the recipient under reverse charge')) {
    notes.push('Tax on this supply is payable by the recipient under reverse charge');
  }

  // ── Parties ──
  const labels = partyLabels(base, direction);
  const party: PrintAddress | null =
    row.party_ledger_id !== null || txt(row.party_name)
      ? address({
          name: row.party_name ?? partyInfo?.name ?? null,
          address: row.party_address,
          pincode: row.party_pincode,
          stateCode: row.party_state_code,
          country: partyInfo?.row.country ?? null,
          gstin: row.party_gstin,
          pan: partyInfo?.row.pan ?? null,
          registrationType: row.party_registration_type,
          phone: partyInfo?.row.mobile ?? null,
          email: partyInfo?.row.email ?? null,
        })
      : null;
  const consigneeRaw = parseJson<ConsigneeInput>(row.consignee);
  const hasConsignee = consigneeRaw !== null && Object.values(consigneeRaw).some((v) => typeof v === 'string' && v.trim() !== '');
  let consignee: PrintAddress | null;
  let consigneeSameAsParty = false;
  const company = printCompany(env);
  if (hasConsignee && consigneeRaw) {
    consignee = address({ ...consigneeRaw, country: null });
  } else if (base === 'purchase_order') {
    consignee = { ...company, name: company.displayName, registrationType: null };
  } else if (direction === 'inward') {
    // Goods bought come to the company: the supplier is not a "ship to".
    consignee = null;
  } else {
    consignee = party;
    consigneeSameAsParty = party !== null;
  }
  // A challan names its consignee (Rule 55(1)(d)); when there is no separate ship-to, the party is the consignee.
  const partyLabel = base === 'delivery_note' && consigneeSameAsParty ? labels.consignee : labels.party;

  // ── GST presentation ──
  // Rule 55(1)(g): a challan for inter-State movement shows the place of supply — the state the goods go to.
  const pos =
    placeOfSupply(row.place_of_supply) ??
    (title.kind === 'delivery_challan' ? placeOfSupply(consignee?.stateCode ?? party?.stateCode ?? null) : null);
  const taxMode: TaxMode = build?.taxMode ?? 'none';
  // A bill of supply (Rule 49) carries no tax columns, rates or reverse-charge line.
  const showTax = layout === 'invoice' && companyGst === 'regular' && taxMode !== 'none' && title.kind !== 'bill_of_supply';

  // ── References ──
  const detailParty = layout === 'invoice' && !cancelled && row.party_ledger_id !== null
    ? db.value<string>(
        `SELECT ba.due_date FROM bill_allocations ba JOIN ledger_entries le ON le.id = ba.ledger_entry_id
          WHERE ba.voucher_id = :id AND le.ledger_id = :party AND ba.ref_type = 'new' AND ba.due_date IS NOT NULL
          ORDER BY ba.id LIMIT 1`,
        { id, party: row.party_ledger_id },
      ) ?? null
    : null;
  const refs = references(parseJson<OrderDetailsInput>(row.order_details), parseJson<DispatchDetailsInput>(row.dispatch), exportDetails, isSalesDocument(title.kind) && detailParty !== null && detailParty > row.date ? detailParty : null);
  // Quotation / proforma: the offer's validity (documents module, vouchers.valid_until).
  if (title.kind === 'quotation' || title.kind === 'proforma_invoice') {
    const validUntil = db.value<string | null>('SELECT valid_until FROM vouchers WHERE id = :id', { id });
    if (validUntil) refs.unshift({ label: 'Valid Until', value: formatDate(validUntil) });
  }

  // ── Payment details (documents asking the buyer to pay) ──
  const asksPayment =
    layout === 'invoice' && direction === 'outward' && (isSalesDocument(title.kind) || title.kind === 'debit_note' || title.kind === 'sales_order' || title.kind === 'proforma_invoice');
  const bank = asksPayment && options.showBankDetails ? bankDetails(db, options.bankLedgerId) : null;
  let upi: PrintUpi | null = null;
  const upiId = txt(options.upiId) ?? (asksPayment ? (bankDetails(db, options.bankLedgerId)?.upiId ?? null) : null);
  // UPI collects rupees from Indian accounts: not offered to an overseas buyer on an export invoice.
  if (asksPayment && title.kind !== 'export_invoice' && options.showUpiQr && upiId && !cancelled && totals.grandTotal > 0) {
    const note = row.number ? `${title.title} ${row.number}` : title.title;
    const payeeName = company.displayName;
    upi = { id: upiId, payeeName, amount: totals.grandTotal, note, uri: upiUri({ id: upiId, payeeName, amount: totals.grandTotal, note }) };
  }

  const tax = totals.tax;
  const sellerDoc = layout === 'invoice' && (isSalesDocument(title.kind) || (title.kind === 'debit_note' && direction === 'outward'));
  const data: PrintVoucherData = {
    id: row.id,
    sample: false,
    layout,
    kind: title.kind,
    baseType: base,
    voucherTypeId: vt.id,
    voucherTypeName: vt.name,
    title: title.title,
    endorsement: title.endorsement,
    notes,
    number: row.number,
    date: row.date,
    referenceNo: txt(row.reference_no),
    referenceDate: txt(row.reference_date),
    status: {
      cancelled,
      cancelReason: meta.cancelled?.reason ?? null,
      optional: row.is_optional === 1,
      postDated: row.is_post_dated === 1,
    },
    company,
    partyLabel,
    party,
    consigneeLabel: labels.consignee,
    consignee,
    consigneeSameAsParty,
    placeOfSupply: layout === 'voucher' ? null : pos,
    reverseCharge,
    gst: {
      showTax,
      taxMode,
      interState: build?.interState ?? false,
      sgstLabel: taxMode === 'cgst_utgst' ? 'UTGST' : 'SGST',
      nature,
    },
    lines,
    charges,
    taxByRate: showTax ? summariseByRate(lines) : [],
    taxByHsn: layout === 'invoice' && companyGst !== 'unregistered' ? summariseByHsn(lines) : [],
    totals,
    amountInWords: amountInWords(Math.abs(totals.grandTotal)),
    taxInWords: showTax && tax > 0 ? amountInWords(tax) : null,
    entries,
    narration: txt(row.narration),
    originalInvoice:
      (base === 'credit_note' || base === 'debit_note') && txt(row.original_invoice_no)
        ? { number: row.original_invoice_no as string, date: txt(row.original_invoice_date), reason: txt(row.note_reason) }
        : null,
    references: refs,
    einvoice: txt(row.irn) ? { irn: row.irn as string, ackNo: txt(row.irn_ack_no), ackDate: txt(row.irn_ack_date), signedQr: txt(row.irn_signed_qr) } : null,
    ewayBill: txt(row.eway_bill_no) ? { number: row.eway_bill_no as string, date: txt(row.eway_bill_date), validUpto: txt(row.eway_valid_upto) } : null,
    bank,
    upi,
    declaration: sellerDoc ? txt(options.declaration) : null,
    // Terms of sale belong on what the company sells (invoices, outward debit notes, sales orders) — not on a
    // credit note for returned goods or a challan.
    terms: sellerDoc || ((title.kind === 'sales_order' || title.kind === 'quotation' || title.kind === 'proforma_invoice') && layout !== 'voucher') ? txt(options.terms) : null,
    signatoryLabel: txt(options.signatoryLabel) ?? 'Authorised Signatory',
    copyLabels: copyLabels(title.kind, direction === 'outward', lines.some((l) => l.kind === 'item')),
    options,
    defaultTemplate: options.template,
    navigation: navigation(db, row),
    warnings,
  };
  if (cancelled) data.warnings.unshift(`This voucher was cancelled${data.status.cancelReason ? ` (${data.status.cancelReason})` : ''}; it prints marked CANCELLED.`);
  else if (data.status.optional) data.warnings.unshift('This is an optional voucher (not in the books); it prints marked OPTIONAL.');
  data.warnings.push(
    ...complianceWarnings(data, {
      issuedByCompany: direction === 'outward' || title.kind === 'self_invoice',
      companyGst,
      hsnDigits: env.config.gst.hsnDigits,
      einvoice: env.features.einvoice,
    }),
  );
  return data;
}

export function buildPrintDataFor(ctx: CompanyCtx, id: number, overrides?: InvoicePrintOverrides): PrintVoucherData {
  return buildPrintData(loadPrintEnv(ctx), id, overrides);
}

export function buildBatch(ctx: CompanyCtx, ids: readonly number[]): { documents: PrintVoucherData[]; notFound: number[] } {
  const env = loadPrintEnv(ctx);
  const documents: PrintVoucherData[] = [];
  const missing: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!loadVoucherRow(env.db, id)) {
      missing.push(id);
      continue;
    }
    documents.push(buildPrintData(env, id));
  }
  return { documents, notFound: missing };
}
