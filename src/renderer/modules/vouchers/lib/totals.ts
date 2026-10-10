/**
 * Live voucher totals on the client (pure; tested in totals.test.ts).
 *
 * Invoice modes run the SAME shared GST engine as the server (computeInvoice) on the lines the user
 * has typed, with the line treatment rules of src/core/modules/vouchers/posting.ts (README §3 "How
 * each additional ledger is treated"): apportioned charges, computed lines, and non-GST charges
 * outside the computation (added after tax), then round-off on the whole invoice value. The server
 * recomputes on save; the screen also shows `vouchers.preview` when it is newer than the typing.
 */
import { b2clThresholdOn, computeInvoice } from '../../../../shared/gst/index.ts';
import type { CompanyRegistrationType, InvoiceComputation, InvoiceContext, InvoiceLineInput, RegistrationType, SupplyKind, Taxability } from '../../../../shared/gst/index.ts';
import { roundToUnit } from '../../../../shared/money.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { RoundOffMethod } from '../../../../shared/settings.ts';
import type { LedgerLineGstInput } from '../../../../shared/types/vouchers.ts';
import { ledgerGstOverride } from './buildInput.ts';
import { amountDecimals, isBlankItem, isBlankLedger, itemLineValue } from './formState.ts';
import type { VoucherForm } from './formState.ts';
import { singleEntryAccountSide } from './kinds.ts';

/** What the screen knows about a stock item (from 'inventory.item.picker'). */
export interface ClientItemInfo {
  id: number;
  isService: boolean;
  unitSymbol: string;
  /** GST profile resolved by the picker for the voucher date (item → stock group); null = none set. */
  gst: { rate: number; cessRate: number; cessPerUnit: number; taxability: Taxability; hsnSac: string | null } | null;
}

/** GST history row of a ledger (LedgerDetail.gstRateHistory). */
export interface ClientGstHistoryRow {
  applicableFrom: string;
  hsnSac: string | null;
  taxability: Taxability;
  rate: number;
  cessRate: number;
}

/** What the screen knows about a ledger used on an invoice (LedgerDetail, loaded on demand). */
export interface ClientLedgerTax {
  isSales: boolean;
  isPurchase: boolean;
  /** Income / expense nature, or a fixed asset. */
  plAccount: boolean;
  gstApplicable: boolean;
  taxability: Taxability | null;
  rate: number | null;
  cessRate: number | null;
  hsnSac: string | null;
  supplyType: SupplyKind | null;
  isReverseCharge: boolean;
  includeInAssessable: 'none' | 'goods' | 'services' | null;
  appropriateBy: 'value' | 'quantity' | null;
  /** Oldest first. */
  history: readonly ClientGstHistoryRow[];
}

export interface TotalsEnv {
  direction: 'outward' | 'inward';
  /** features.gst && company registered (entryContext.company.gstEnabled). */
  gstOn: boolean;
  /** GST document (sales, purchase, credit/debit note). Orders/notes compute for printing only. */
  companyStateCode: string;
  companyRegistration: CompanyRegistrationType;
  party: { registrationType: RegistrationType | null; stateCode: string | null; gstin: string | null } | null;
  roundOff: { enabled: boolean; method: RoundOffMethod; unit: number };
  /** F12 threshold when changed from the default (else the statutory one for the date). */
  b2clThresholdPaise?: Paise;
  items: ReadonlyMap<number, ClientItemInfo>;
  ledgerTax: (ledgerId: number) => ClientLedgerTax | undefined;
  /** Sales/purchase ledger of item lines without their own. */
  defaultLedgerId: number | null;
}

export interface LineFigures {
  taxable: Paise;
  tax: Paise;
  rate: number;
  total: Paise;
  taxability: Taxability;
}

export interface ClientTotals {
  computation: InvoiceComputation | null;
  /** Per form row key. */
  lines: Map<string, LineFigures>;
  /** Non-GST charges added after tax (TCS, non-GST discount…). */
  outside: Paise;
  taxable: Paise;
  tax: Paise;
  beforeRound: Paise;
  roundOff: Paise;
  grandTotal: Paise;
  /** Engine notes (shown under the tax breakup). */
  warnings: string[];
}

const EMPTY: ClientTotals = { computation: null, lines: new Map(), outside: 0, taxable: 0, tax: 0, beforeRound: 0, roundOff: 0, grandTotal: 0, warnings: [] };

interface Profile {
  taxability: Taxability;
  rate: number;
  cessRate: number;
  cessPerUnit: number;
  hsnSac: string;
  supplyKind: SupplyKind;
}

const NON_GST: Profile = { taxability: 'taxable', rate: 0, cessRate: 0, cessPerUnit: 0, hsnSac: '', supplyKind: 'goods' };

function historyOn(rows: readonly ClientGstHistoryRow[], date: string): ClientGstHistoryRow | null {
  let found: ClientGstHistoryRow | null = null;
  for (const r of rows) if (r.applicableFrom <= date && (!found || r.applicableFrom >= found.applicableFrom)) found = r;
  return found;
}

function supplyKindOf(explicit: SupplyKind | null, hsn: string): SupplyKind {
  if (explicit === 'goods' || explicit === 'services') return explicit;
  return hsn.startsWith('99') ? 'services' : 'goods';
}

/** Mirror of taxprofile.ts resolveLedgerTaxProfile (history → columns → non-GST; override merged). */
export function ledgerProfile(t: ClientLedgerTax | undefined, date: string, override?: LedgerLineGstInput | null): Profile {
  let base: Omit<Profile, 'supplyKind'>;
  const h = t ? historyOn(t.history, date) : null;
  if (h) {
    const taxable = h.taxability === 'taxable';
    base = { taxability: h.taxability, rate: taxable ? h.rate : 0, cessRate: taxable ? h.cessRate : 0, cessPerUnit: 0, hsnSac: (h.hsnSac || t?.hsnSac || '').trim() };
  } else if (t && t.gstApplicable) {
    const taxability = t.taxability ?? 'taxable';
    const taxable = taxability === 'taxable';
    base = { taxability, rate: taxable ? (t.rate ?? 0) : 0, cessRate: taxable ? (t.cessRate ?? 0) : 0, cessPerUnit: 0, hsnSac: (t.hsnSac ?? '').trim() };
  } else {
    base = { taxability: 'non_gst', rate: 0, cessRate: 0, cessPerUnit: 0, hsnSac: (t?.hsnSac ?? '').trim() };
  }
  const o = override;
  if (o && (o.rate !== undefined || o.taxability !== undefined || o.cessRate !== undefined || o.hsnSac !== undefined || o.supplyKind !== undefined)) {
    const taxability: Taxability = o.taxability ?? (o.rate !== undefined ? 'taxable' : base.taxability);
    const taxable = taxability === 'taxable';
    const hsnSac = (o.hsnSac ?? base.hsnSac).trim();
    return {
      taxability,
      rate: taxable ? (o.rate ?? (base.taxability === 'taxable' ? base.rate : 0)) : 0,
      cessRate: taxable ? (o.cessRate ?? (base.taxability === 'taxable' ? base.cessRate : 0)) : 0,
      cessPerUnit: 0,
      hsnSac,
      supplyKind: o.supplyKind ?? supplyKindOf(t?.supplyType ?? null, hsnSac),
    };
  }
  return { ...base, supplyKind: supplyKindOf(t?.supplyType ?? null, base.hsnSac) };
}

function ledgerIsGstApplicable(t: ClientLedgerTax | undefined, date: string): boolean {
  if (!t) return false;
  return t.gstApplicable || historyOn(t.history, date) !== null;
}

/** Item line profile: override → item/group (picker) → the line's sales/purchase ledger → 0%. */
export function itemProfile(info: ClientItemInfo | undefined, ledger: ClientLedgerTax | undefined, date: string, override: number | null): Profile {
  const supplyKind: SupplyKind = info?.isService ? 'services' : 'goods';
  let found: Omit<Profile, 'supplyKind'> | null = null;
  if (info?.gst) {
    const g = info.gst;
    const taxable = g.taxability === 'taxable';
    found = { taxability: g.taxability, rate: taxable ? g.rate : 0, cessRate: taxable ? g.cessRate : 0, cessPerUnit: taxable ? g.cessPerUnit : 0, hsnSac: (g.hsnSac ?? '').trim() };
  } else if (ledger) {
    const h = historyOn(ledger.history, date);
    if (h) found = { taxability: h.taxability, rate: h.taxability === 'taxable' ? h.rate : 0, cessRate: h.taxability === 'taxable' ? h.cessRate : 0, cessPerUnit: 0, hsnSac: (h.hsnSac ?? '').trim() };
    else if (ledger.gstApplicable && (ledger.taxability !== 'taxable' || ledger.rate !== null)) {
      const taxability = ledger.taxability ?? 'taxable';
      found = { taxability, rate: taxability === 'taxable' ? (ledger.rate ?? 0) : 0, cessRate: taxability === 'taxable' ? (ledger.cessRate ?? 0) : 0, cessPerUnit: 0, hsnSac: (ledger.hsnSac ?? '').trim() };
    }
  }
  if (override !== null && Number.isFinite(override)) {
    return {
      taxability: 'taxable',
      rate: override,
      cessRate: found && found.taxability === 'taxable' ? found.cessRate : 0,
      cessPerUnit: found && found.taxability === 'taxable' ? found.cessPerUnit : 0,
      hsnSac: found?.hsnSac ?? '',
      supplyKind,
    };
  }
  if (found) return { ...found, supplyKind };
  return { taxability: 'taxable', rate: 0, cessRate: 0, cessPerUnit: 0, hsnSac: '', supplyKind };
}

/** Invoice totals for an item / accounting invoice (also orders/notes in item_invoice mode). */
export function computeInvoiceTotals(f: VoucherForm, env: TotalsEnv): ClientTotals {
  if (f.mode !== 'item_invoice' && f.mode !== 'accounting_invoice') return EMPTY;
  const lines: InvoiceLineInput[] = [];
  const keys: string[] = [];
  const outsideKeys: Array<{ key: string; amount: Paise }> = [];
  const gstOn = env.gstOn;

  if (f.mode === 'item_invoice') {
    for (const r of f.items) {
      if (isBlankItem(r)) continue;
      const info = env.items.get(r.itemId as number);
      const ledgerId = r.ledgerId ?? env.defaultLedgerId;
      const ledger = ledgerId !== null ? env.ledgerTax(ledgerId) : undefined;
      const p = gstOn ? itemProfile(info, ledger, f.date, r.gstRateOverride) : { ...NON_GST, supplyKind: info?.isService ? ('services' as const) : ('goods' as const) };
      const valueQty = r.billedQty ?? r.qty ?? 0;
      lines.push({
        key: r.key,
        kind: 'item',
        qty: valueQty,
        rate: r.rate ?? 0,
        discountPct: r.discountPct ?? undefined,
        // (forex) Amounts held in 10^-d units of a currency with d ≠ 2 decimals: the line value is given
        // in those units (the engine's own qty × rate would be in hundredths).
        amount: r.amount ?? (amountDecimals(f) !== 2 ? itemLineValue(r, amountDecimals(f)) : undefined),
        rateInclusiveOfTax: r.rateInclusiveOfTax ?? false,
        taxability: p.taxability,
        gstRate: p.rate,
        cessRate: p.cessRate,
        cessPerUnit: p.cessPerUnit,
        hsnSac: p.hsnSac,
        supplyKind: p.supplyKind,
        uqc: info?.isService ? undefined : info?.unitSymbol,
        reverseCharge: ledger?.isReverseCharge === true,
      });
      keys.push(r.key);
    }
  }

  for (const r of f.ledgers) {
    if (isBlankLedger(r) || r.amount === null || r.amount === 0) continue;
    const t = env.ledgerTax(r.ledgerId as number);
    const override = ledgerGstOverride(r) ?? null;
    let treatment: 'apportion' | 'computed' | 'outside';
    if (t?.includeInAssessable === 'goods') treatment = 'apportion';
    else if (gstOn && (override !== null || ledgerIsGstApplicable(t, f.date))) treatment = 'computed';
    else if (t && (t.isSales || t.isPurchase || (f.mode === 'accounting_invoice' && t.plAccount && r.amount > 0))) treatment = 'computed';
    else if (!t && f.mode === 'accounting_invoice' && r.amount > 0) treatment = 'computed'; // not loaded yet: assume an income/expense line
    else treatment = 'outside';
    if (treatment === 'outside') {
      outsideKeys.push({ key: r.key, amount: r.amount });
      continue;
    }
    const p = gstOn ? ledgerProfile(t, f.date, override) : NON_GST;
    lines.push({
      key: r.key,
      kind: 'ledger',
      amount: r.amount,
      taxability: p.taxability,
      gstRate: p.rate,
      cessRate: p.cessRate,
      hsnSac: p.hsnSac,
      supplyKind: p.supplyKind,
      apportion: treatment === 'apportion' ? (t?.appropriateBy === 'quantity' ? 'quantity' : 'value') : 'none',
      reverseCharge: t?.isReverseCharge === true,
    });
    keys.push(r.key);
  }

  const ctx: InvoiceContext = {
    direction: env.direction,
    invoiceDate: f.date,
    companyStateCode: env.companyStateCode,
    companyRegistration: gstOn ? env.companyRegistration : 'unregistered',
    partyRegistration: env.party?.registrationType ?? (env.party?.gstin ? 'regular' : 'unregistered'),
    partyStateCode: env.party?.stateCode ?? (env.party?.gstin && /^\d{2}/.test(env.party.gstin) ? env.party.gstin.slice(0, 2) : null),
    partyGstin: env.party?.gstin ?? null,
    consigneeStateCode: f.consignee?.stateCode?.trim() || null,
    placeOfSupply: /^\d{2}$/.test(f.placeOfSupply) ? f.placeOfSupply : null,
    exportWithPayment: f.exportDetails?.withPayment === true,
    reverseCharge: f.reverseCharge,
    roundOff: { enabled: false, method: 'nearest', unit: 100 },
  };
  if (env.b2clThresholdPaise !== undefined) ctx.b2clThresholdPaise = env.b2clThresholdPaise;
  const comp = computeInvoice(lines, ctx);
  const outside = outsideKeys.reduce((a, o) => a + o.amount, 0);
  const beforeRound = comp.totals.invoiceValueBeforeRound + outside;
  const ro = env.roundOff;
  const grandTotal = ro.enabled && ro.unit > 1 ? roundToUnit(beforeRound, ro.unit, ro.method) : beforeRound;
  const roundOff = grandTotal - beforeRound;
  let nature = comp.nature;
  if (nature === 'b2cl' || nature === 'b2cs') nature = comp.interState && grandTotal > (env.b2clThresholdPaise ?? b2clThresholdOn(f.date)) ? 'b2cl' : 'b2cs';

  const byKey = new Map<string, LineFigures>();
  comp.lines.forEach((cl, i) => {
    byKey.set(keys[i], { taxable: cl.taxableValue, tax: cl.tax, rate: cl.rate, total: cl.total, taxability: cl.taxability });
  });
  for (const o of outsideKeys) byKey.set(o.key, { taxable: 0, tax: 0, rate: 0, total: o.amount, taxability: 'non_gst' });
  return {
    computation: { ...comp, nature, totals: { ...comp.totals, invoiceValueBeforeRound: beforeRound, roundOff, grandTotal, payableToParty: grandTotal } },
    lines: byKey,
    outside,
    taxable: comp.totals.taxable,
    tax: comp.totals.tax,
    beforeRound,
    roundOff,
    grandTotal,
    warnings: comp.warnings,
  };
}

const sameFigures = (a: LineFigures, b: LineFigures): boolean =>
  a.taxable === b.taxable && a.tax === b.tax && a.rate === b.rate && a.total === b.total && a.taxability === b.taxability;

/**
 * Reuse the previous LineFigures object of every row whose figures did not change, so memoised grid
 * rows (which receive their figures as a prop) re-render only when their own numbers change — not on
 * every recomputation of the invoice (a 500-line voucher would otherwise re-render every row per keystroke).
 */
export function stabilizeLines(prev: ReadonlyMap<string, LineFigures> | null, next: ReadonlyMap<string, LineFigures>): Map<string, LineFigures> {
  const out = new Map<string, LineFigures>();
  for (const [k, v] of next) {
    const p = prev?.get(k);
    out.set(k, p && sameFigures(p, v) ? p : v);
  }
  return out;
}

/** Ledger-mode figures: Σ Dr, Σ Cr and the difference (Dr − Cr; 0 = balanced). */
export interface LedgerTotals {
  debit: Paise;
  credit: Paise;
  difference: Paise;
  /** Single-entry: the Account line's signed amount. */
  account: Paise;
}

export function computeLedgerTotals(f: VoucherForm): LedgerTotals {
  if (f.mode !== 'ledger') return { debit: 0, credit: 0, difference: 0, account: 0 };
  const side = singleEntryAccountSide(f.baseType);
  if (f.layout === 'single' && side !== null) {
    const total = f.ledgers.reduce((a, r) => (isBlankLedger(r) ? a : a + Math.abs(r.amount ?? 0)), 0);
    const account = f.accountLedgerId === null ? 0 : side === 'dr' ? total : -total;
    // Without an Account the particulars are unbalanced by their total.
    const difference = f.accountLedgerId === null ? (side === 'dr' ? -total : total) : 0;
    return { debit: total, credit: f.accountLedgerId === null ? 0 : total, difference, account };
  }
  let debit = 0;
  let credit = 0;
  for (const r of f.ledgers) {
    if (isBlankLedger(r)) continue;
    const a = r.amount ?? 0;
    if (a > 0) debit += a;
    else credit += -a;
  }
  return { debit, credit, difference: debit - credit, account: 0 };
}

/** Inventory mode: Σ line values (stock journal: per side). */
export function computeStockTotals(f: VoucherForm): { total: Paise; consumption: Paise; production: Paise; qty: number } {
  let total = 0;
  let consumption = 0;
  let production = 0;
  let qty = 0;
  for (const r of f.items) {
    if (isBlankItem(r)) continue;
    const v = itemLineValue(r);
    total += v;
    qty += r.qty ?? 0;
    if (r.isConsumption) consumption += v;
    else production += v;
  }
  return { total, consumption, production, qty };
}
