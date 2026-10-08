/**
 * Form state ⇄ VoucherInput (pure; tested in buildInput.test.ts).
 *
 * buildVoucherInput also returns where each input line came from (row keys), so server paths like
 * `items[2].qty` / `ledgers[0].ledgerId` can be mapped back to grid cells (errorPaths.ts).
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import type {
  BillAllocationInput,
  ItemLineInput,
  LedgerLineInput,
  VoucherInput,
  VoucherMode,
} from '../../../../shared/types/vouchers.ts';
import { blankItem, blankLedger, isBlankItem, isBlankLedger, newForm, normalize, splitForSingle } from './formState.ts';
import type { ItemRow, LedgerLayout, LedgerRow, VoucherForm } from './formState.ts';
import { isInvoiceMode, showsParty, singleEntryAccountSide } from './kinds.ts';

/** Key used in `ledgerKeys` for the single-entry Account line. */
export const ACCOUNT_ROW = 'account';

export interface BuiltInput {
  input: VoucherInput;
  /** items[i] came from the item row with this key. */
  itemKeys: string[];
  /** ledgers[i] came from this ledger row key (or ACCOUNT_ROW). */
  ledgerKeys: string[];
}

const txt = (s: string | null | undefined): string | undefined => {
  const t = (s ?? '').trim();
  return t === '' ? undefined : t;
};

function hasValues(o: object | null | undefined): boolean {
  if (!o) return false;
  return Object.values(o).some((v) => v !== undefined && v !== null && v !== '');
}

/** Drop empty strings / nulls from a details object (the server schema takes optional strings). */
function clean<T extends object>(o: T | null): T | undefined {
  if (!o || !hasValues(o)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t !== '') out[k] = t;
    } else out[k] = v;
  }
  return out as T;
}

function itemLine(r: ItemRow, f: VoucherForm): ItemLineInput {
  const line: ItemLineInput = { itemId: r.itemId as number, qty: r.qty ?? 0, rate: r.rate ?? 0 };
  if (r.godownId !== null) line.godownId = r.godownId;
  if (txt(r.batchName)) line.batchName = txt(r.batchName);
  if (r.mfgDate) line.mfgDate = r.mfgDate;
  if (r.expiryDate) line.expiryDate = r.expiryDate;
  if (r.billedQty !== null) line.billedQty = r.billedQty;
  if (r.discountPct !== null && r.discountPct !== 0) line.discountPct = r.discountPct;
  if (r.amount !== null) line.amount = r.amount;
  if (r.ledgerId !== null && f.mode === 'item_invoice') line.ledgerId = r.ledgerId;
  if (txt(r.description)) line.description = txt(r.description);
  if (r.gstRateOverride !== null && f.mode === 'item_invoice') line.gstRateOverride = r.gstRateOverride;
  if (txt(r.trackingRef)) line.trackingRef = txt(r.trackingRef);
  if (txt(r.orderRef)) line.orderRef = txt(r.orderRef);
  if (f.baseType === 'stock_journal') line.isConsumption = r.isConsumption;
  if (r.rateInclusiveOfTax !== null) line.rateInclusiveOfTax = r.rateInclusiveOfTax;
  return line;
}

function withAllocations(line: LedgerLineInput, r: LedgerRow): LedgerLineInput {
  if (r.bills && r.bills.length > 0) line.billAllocations = r.bills.map((b) => ({ ...b }));
  if (r.costs && r.costs.length > 0) line.costAllocations = r.costs.map((c) => ({ ...c }));
  if (r.instrument && hasValues(r.instrument)) line.instrument = clean(r.instrument);
  if (txt(r.narration)) line.narration = txt(r.narration);
  return line;
}

/** Turn the form into the VoucherInput sent to vouchers.preview / vouchers.save. */
export function buildVoucherInput(f: VoucherForm): BuiltInput {
  const input: VoucherInput = { voucherTypeId: f.voucherTypeId, date: f.date, mode: f.mode };
  if (f.id !== null) input.id = f.id;
  if (f.expectedUpdatedAt) input.expectedUpdatedAt = f.expectedUpdatedAt;
  if (f.effectiveDate) input.effectiveDate = f.effectiveDate;
  if (txt(f.number)) input.number = txt(f.number);
  if (txt(f.referenceNo)) input.referenceNo = txt(f.referenceNo);
  if (f.referenceDate) input.referenceDate = f.referenceDate;
  if (txt(f.narration)) input.narration = txt(f.narration);
  input.isOptional = f.isOptional;
  if (f.isPostDated) input.isPostDated = true;
  if (showsParty(f.baseType, f.mode) && f.partyLedgerId !== null) input.partyLedgerId = f.partyLedgerId;
  if (isInvoiceMode(f.mode) || f.mode === 'inventory') {
    const party = clean(f.party);
    if (party) input.party = party;
    const consignee = clean(f.consignee);
    if (consignee) input.consignee = consignee;
    const dispatch = clean(f.dispatch);
    if (dispatch) input.dispatch = dispatch;
    const order = clean(f.orderDetails);
    if (order) input.orderDetails = order;
    const exp = clean(f.exportDetails);
    if (exp) input.exportDetails = exp;
  }
  if (isInvoiceMode(f.mode) || f.mode === 'inventory') {
    if (/^\d{2}$/.test(f.placeOfSupply)) input.placeOfSupply = f.placeOfSupply;
    if (f.reverseCharge) input.reverseCharge = true;
    if (f.priceLevelId !== null) input.priceLevelId = f.priceLevelId;
  }
  if (f.baseType === 'credit_note' || f.baseType === 'debit_note') {
    if (txt(f.originalInvoiceNo)) input.originalInvoiceNo = txt(f.originalInvoiceNo);
    if (f.originalInvoiceDate) input.originalInvoiceDate = f.originalInvoiceDate;
    if (txt(f.noteReason)) input.noteReason = txt(f.noteReason);
  }
  if (isInvoiceMode(f.mode) && f.partyBills && f.partyBills.length > 0) input.partyBillAllocations = f.partyBills.map((b) => ({ ...b }));

  const itemKeys: string[] = [];
  const ledgerKeys: string[] = [];

  if (f.mode === 'item_invoice' || f.mode === 'inventory') {
    const items: ItemLineInput[] = [];
    // Stock journal: the source (consumption) side first, then the destination — as on screen.
    const rows = f.baseType === 'stock_journal' ? [...f.items.filter((r) => r.isConsumption), ...f.items.filter((r) => !r.isConsumption)] : f.items;
    for (const r of rows) {
      if (isBlankItem(r)) continue;
      items.push(itemLine(r, f));
      itemKeys.push(r.key);
    }
    input.items = items;
  }

  if (f.mode === 'item_invoice' || f.mode === 'accounting_invoice') {
    const ledgers: LedgerLineInput[] = [];
    for (const r of f.ledgers) {
      if (isBlankLedger(r) || r.amount === null) continue;
      const line: LedgerLineInput = { ledgerId: r.ledgerId as number, amount: r.amount };
      if (txt(r.narration)) line.narration = txt(r.narration);
      if (r.costs && r.costs.length > 0) line.costAllocations = r.costs.map((c) => ({ ...c }));
      if (f.mode === 'accounting_invoice' && (r.gstRate !== null || txt(r.hsnSac))) {
        line.gst = {};
        if (r.gstRate !== null) line.gst.rate = r.gstRate;
        if (txt(r.hsnSac)) line.gst.hsnSac = txt(r.hsnSac);
      }
      ledgers.push(line);
      ledgerKeys.push(r.key);
    }
    input.ledgers = ledgers;
  } else if (f.mode === 'ledger') {
    const ledgers: LedgerLineInput[] = [];
    const side = singleEntryAccountSide(f.baseType);
    if (f.layout === 'single' && side !== null) {
      const accSign = side === 'dr' ? 1 : -1;
      const parts = f.ledgers.filter((r) => !isBlankLedger(r));
      const total = parts.reduce((a, r) => a + Math.abs(r.amount ?? 0), 0);
      if (f.accountLedgerId !== null) {
        const acc: LedgerLineInput = { ledgerId: f.accountLedgerId, amount: accSign * total };
        if (f.accountInstrument && hasValues(f.accountInstrument)) acc.instrument = clean(f.accountInstrument);
        ledgers.push(acc);
        ledgerKeys.push(ACCOUNT_ROW);
      }
      for (const r of parts) {
        ledgers.push(withAllocations({ ledgerId: r.ledgerId as number, amount: -accSign * Math.abs(r.amount ?? 0) }, r));
        ledgerKeys.push(r.key);
      }
    } else {
      for (const r of f.ledgers) {
        if (isBlankLedger(r)) continue;
        ledgers.push(withAllocations({ ledgerId: r.ledgerId as number, amount: r.amount ?? 0 }, r));
        ledgerKeys.push(r.key);
      }
    }
    input.ledgers = ledgers;
  }
  return { input, itemKeys, ledgerKeys };
}

// ───────────────────────────── VoucherInput → form ─────────────────────────────

export interface FormFromInputOptions {
  baseType: VoucherBaseType;
  /** Keep id/expectedUpdatedAt (alter) — false for a duplicate. */
  alter: boolean;
  /** Override the date (duplicate: the working date). */
  date?: string;
  /** Preferred layout for payment / receipt / contra (default single when it fits). */
  preferLayout?: LedgerLayout;
}

function billsCopy(b: BillAllocationInput[] | undefined): BillAllocationInput[] | null {
  return b && b.length > 0 ? b.map((x) => ({ ...x })) : null;
}

/** Load a saved (or duplicated) VoucherInput into the form. */
export function formFromInput(input: VoucherInput, o: FormFromInputOptions): VoucherForm {
  const mode: VoucherMode = input.mode;
  const f = newForm({ voucherTypeId: input.voucherTypeId, baseType: o.baseType, mode, date: o.date ?? input.date, layout: 'double' });
  let seq = f.seq;
  const key = (p: string): string => {
    seq += 1;
    return `${p}${seq}`;
  };
  const items: ItemRow[] = (input.items ?? []).map((it) => ({
    ...blankItem(key('i'), it.isConsumption === true),
    itemId: it.itemId,
    godownId: it.godownId ?? null,
    batchName: it.batchName ?? '',
    mfgDate: it.mfgDate ?? null,
    expiryDate: it.expiryDate ?? null,
    qty: it.qty,
    billedQty: it.billedQty ?? null,
    rate: it.rate ?? null,
    discountPct: it.discountPct ?? null,
    amount: it.amount ?? null,
    gstRateOverride: it.gstRateOverride ?? null,
    ledgerId: it.ledgerId ?? null,
    description: it.description ?? '',
    trackingRef: it.trackingRef ?? '',
    orderRef: it.orderRef ?? '',
    rateInclusiveOfTax: it.rateInclusiveOfTax ?? null,
  }));
  let ledgers: LedgerRow[] = (input.ledgers ?? []).map((l) => ({
    ...blankLedger(key('l'), l.amount < 0 ? 'cr' : 'dr'),
    ledgerId: l.ledgerId,
    amount: l.amount,
    narration: l.narration ?? '',
    bills: billsCopy(l.billAllocations),
    costs: l.costAllocations && l.costAllocations.length > 0 ? l.costAllocations.map((c) => ({ ...c })) : null,
    instrument: l.instrument ? { ...l.instrument } : null,
    gstRate: l.gst?.rate ?? null,
    hsnSac: l.gst?.hsnSac ?? '',
  }));
  let layout: LedgerLayout = 'double';
  let accountLedgerId: number | null = null;
  let accountInstrument = null as VoucherForm['accountInstrument'];
  const side = singleEntryAccountSide(o.baseType);
  if (mode === 'ledger' && side !== null && o.preferLayout !== 'double') {
    const split = splitForSingle(ledgers, side);
    if (split && split.account) {
      layout = 'single';
      accountLedgerId = split.account.ledgerId;
      accountInstrument = split.account.instrument;
      ledgers = split.particulars.map((r) => ({ ...r, amount: r.amount === null ? null : Math.abs(r.amount) }));
    }
  }
  const out: VoucherForm = {
    ...f,
    id: o.alter ? (input.id ?? null) : null,
    expectedUpdatedAt: o.alter ? (input.expectedUpdatedAt ?? null) : null,
    layout,
    accountLedgerId,
    accountInstrument,
    effectiveDate: input.effectiveDate ?? null,
    number: o.alter ? (input.number ?? '') : '',
    referenceNo: input.referenceNo ?? '',
    referenceDate: input.referenceDate ?? null,
    partyLedgerId: input.partyLedgerId ?? null,
    placeOfSupply: input.placeOfSupply ?? '',
    priceLevelId: input.priceLevelId ?? null,
    reverseCharge: input.reverseCharge === true,
    isOptional: input.isOptional === true,
    isPostDated: input.isPostDated === true,
    narration: input.narration ?? '',
    items,
    ledgers,
    partyBills: billsCopy(input.partyBillAllocations),
    party: input.party ? { ...input.party } : null,
    consignee: input.consignee ? { ...input.consignee } : null,
    dispatch: input.dispatch ? { ...input.dispatch } : null,
    orderDetails: input.orderDetails ? { ...input.orderDetails } : null,
    exportDetails: input.exportDetails ? { ...input.exportDetails } : null,
    originalInvoiceNo: input.originalInvoiceNo ?? '',
    originalInvoiceDate: input.originalInvoiceDate ?? null,
    noteReason: input.noteReason ?? '',
    touched: false,
    seq,
  };
  return normalize(out);
}
