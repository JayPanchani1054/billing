/**
 * Masters as the voucher screen needs them (pure; tested in masters.test.ts):
 * which ledgers a picker offers in each place, the GST profile of a ledger for live totals, item
 * defaults (rate from the price level / item master), lines filled from a tracking document, and the
 * tax breakup rows of the totals panel.
 */
import type { GroupCode, VoucherBaseType } from '../../../../shared/constants.ts';
import { isUtgstState } from '../../../../shared/gst/index.ts';
import type { InvoiceComputation } from '../../../../shared/gst/index.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { LedgerClassName, LedgerDetail } from '../../../../shared/types/accounts.ts';
import type { ItemPickerRow } from '../../../../shared/types/inventory.ts';
import type { TrackingDoc, TrackingKind } from '../../../../shared/types/vouchers.ts';
import type { ItemRow } from './formState.ts';
import type { ClientItemInfo, ClientLedgerTax } from './totals.ts';

// ───────────────────────────── Ledger pickers ─────────────────────────────

/** Where a ledger picker sits on the voucher screen. */
export type LedgerSlot =
  /** Party of an invoice / order / note. */
  | 'party'
  /** Sales/purchase ledger of an item line. */
  | 'itemLedger'
  /** Additional ledger (freight, discount…) or an accounting-invoice line. */
  | 'invoiceLine'
  /** Single-entry "Account" (cash / bank) of payment, receipt, contra. */
  | 'account'
  /** A line of a ledger-mode voucher. */
  | 'particular';

const has = (classes: readonly LedgerClassName[], c: LedgerClassName): boolean => classes.includes(c);

/**
 * Which ledgers a picker offers. Mirrors the engine's refusals (README §3/§8) so the user is not
 * offered what the server would reject: cash/bank and parties are not invoice lines, contra lines
 * are cash/bank only, a journal does not touch cash/bank, a credit note is not issued to a supplier.
 */
export function ledgerAllowed(slot: LedgerSlot, baseType: VoucherBaseType, classes: readonly LedgerClassName[], direction: 'outward' | 'inward' = 'outward'): boolean {
  switch (slot) {
    case 'party':
      if (baseType === 'sales' || baseType === 'purchase') return has(classes, 'party') || has(classes, 'cash_bank');
      // A Credit Note credits the party: to a supplier it is a Debit Note (README §3).
      if (baseType === 'credit_note') return has(classes, 'debtor') || has(classes, 'cash_bank');
      return has(classes, 'party') || has(classes, 'cash_bank');
    case 'itemLedger':
      return direction === 'outward' ? has(classes, 'sales') : has(classes, 'purchase');
    case 'invoiceLine':
      return !has(classes, 'party') && !has(classes, 'cash_bank');
    case 'account':
      return has(classes, 'cash_bank');
    case 'particular':
      if (baseType === 'contra') return has(classes, 'cash_bank');
      if (baseType === 'journal') return !has(classes, 'cash_bank');
      return true;
    default:
      return true;
  }
}

/** Ledger kinds named in the picker's empty text ("No bank or cash ledger matches"). */
export function slotNoun(slot: LedgerSlot, baseType: VoucherBaseType): string {
  if (slot === 'party') return 'party ledger';
  if (slot === 'itemLedger') return baseType === 'purchase' || baseType === 'debit_note' ? 'purchase ledger' : 'sales ledger';
  if (slot === 'account' || (slot === 'particular' && baseType === 'contra')) return 'cash or bank ledger';
  return 'ledger';
}

/**
 * The group a ledger created with Alt+C from this picker goes under (accounts.ledger.form
 * `groupCode`), so the form opens with that group's defaults (bill-wise, state, GST type): a party
 * of a sales-side document is a customer, of a purchase-side one a supplier; an item line's ledger
 * is a sales / purchase account; the single-entry Account and contra lines are bank accounts. null
 * where no one group fits (additional ledgers, journal / payment particulars).
 */
export function createGroupCode(slot: LedgerSlot, baseType: VoucherBaseType, direction: 'outward' | 'inward' = 'outward'): GroupCode | null {
  switch (slot) {
    case 'party':
      // A Credit Note is only issued to a customer (ledgerAllowed).
      return baseType === 'credit_note' || direction === 'outward' ? 'SUNDRY_DEBTORS' : 'SUNDRY_CREDITORS';
    case 'itemLedger':
      return direction === 'outward' ? 'SALES_ACCOUNTS' : 'PURCHASE_ACCOUNTS';
    case 'account':
      return 'BANK_ACCOUNTS';
    case 'particular':
      return baseType === 'contra' ? 'BANK_ACCOUNTS' : null;
    default:
      return null;
  }
}

/**
 * Why a ledger just created from this picker cannot be used here (null when it can): the user may
 * have changed the group in the form. Shown instead of selecting a ledger the save would refuse.
 */
export function createdLedgerProblem(
  ledger: { name: string; groupName: string; classes: readonly LedgerClassName[] },
  slot: LedgerSlot,
  baseType: VoucherBaseType,
  direction: 'outward' | 'inward' = 'outward',
): string | null {
  if (ledgerAllowed(slot, baseType, ledger.classes, direction)) return null;
  const under = ledger.groupName ? ` under ${ledger.groupName}` : '';
  return `“${ledger.name}” was created${under}, which is not a ${slotNoun(slot, baseType)} for this voucher. Pick a ${slotNoun(slot, baseType)}, or alter the ledger's group (Go To › Ledgers).`;
}

/** GST profile of a ledger for the live totals (mirror of the engine's ledger profile inputs). */
export function toClientLedgerTax(d: LedgerDetail): ClientLedgerTax {
  return {
    isSales: d.classes.includes('sales'),
    isPurchase: d.classes.includes('purchase'),
    plAccount: d.classes.includes('income') || d.classes.includes('expense') || d.primaryGroupCode === 'FIXED_ASSETS',
    gstApplicable: d.gstApplicable,
    taxability: d.gstTaxability,
    rate: d.gstRate,
    cessRate: d.cessRate,
    hsnSac: d.hsnSac,
    supplyType: d.gstSupplyType,
    isReverseCharge: d.isReverseCharge,
    includeInAssessable: d.includeInAssessable,
    appropriateBy: d.appropriateBy,
    history: d.gstRateHistory.map((h) => ({ applicableFrom: h.applicableFrom, hsnSac: h.hsnSac, taxability: h.taxability, rate: h.rate, cessRate: h.cessRate })),
  };
}

// ───────────────────────────── Items ─────────────────────────────

export function toClientItemInfo(r: ItemPickerRow): ClientItemInfo {
  return { id: r.id, isService: r.isService, unitSymbol: r.unitSymbol, gst: r.gst };
}

/** Which price an item line starts from: sales-side documents use the selling price, inward ones the purchase price. */
export function priceSide(baseType: VoucherBaseType, direction: 'outward' | 'inward'): 'sales' | 'purchase' {
  if (baseType === 'stock_journal' || baseType === 'physical_stock') return 'purchase';
  return direction === 'outward' ? 'sales' : 'purchase';
}

/**
 * Rate (rupees per base unit) and discount an item line starts with: the price level's slab for
 * quantity 1 (sales side), else the item's selling / purchase price. null when the master has none.
 */
export function defaultItemRate(r: ItemPickerRow, side: 'sales' | 'purchase'): { rate: number; discountPct: number | null } | null {
  if (side === 'sales' && r.priceLevel) return { rate: r.priceLevel.rate, discountPct: r.priceLevel.discountPct || null };
  const paise = side === 'sales' ? r.sellingPrice : r.purchasePrice;
  if (paise === null || paise === undefined || paise <= 0) return null;
  return { rate: paise / 100, discountPct: null };
}

/** Item lines to add from an open delivery/receipt note or order (only what is still pending). */
export function rowsFromTrackingDoc(doc: TrackingDoc, kind: TrackingKind): Array<Partial<Omit<ItemRow, 'key'>>> {
  const isOrder = kind === 'sales_order' || kind === 'purchase_order';
  const out: Array<Partial<Omit<ItemRow, 'key'>>> = [];
  for (const l of doc.lines) {
    if (!(l.pendingQty > 0)) continue;
    out.push({
      itemId: l.itemId,
      godownId: l.godownId,
      batchName: l.batchName ?? '',
      qty: l.pendingQty,
      rate: l.rate,
      discountPct: l.discountPct ? l.discountPct : null,
      ledgerId: l.ledgerId,
      trackingRef: isOrder ? '' : doc.ref,
      orderRef: isOrder ? doc.ref : '',
    });
  }
  return out;
}

// ───────────────────────────── Tax breakup ─────────────────────────────

export interface TaxBreakupRow {
  key: string;
  label: string;
  amount: Paise;
}

const pct = (n: number): string => `${Number.isInteger(n) ? n : Number(n.toFixed(3))}%`;

/**
 * Tax lines of the totals panel, one per head and rate ("CGST @ 9%", "SGST @ 9%", "IGST @ 18%",
 * "Cess @ 12%"), in bucket order. UTGST replaces SGST for a union territory without legislature.
 * Reverse-charge tax is shown apart (it is not payable to the party).
 */
export function taxBreakup(comp: InvoiceComputation | null, supplierStateCode: string | null): TaxBreakupRow[] {
  if (!comp) return [];
  const rows = new Map<string, TaxBreakupRow>();
  const sgstLabel = isUtgstState(comp.supplierStateCode || supplierStateCode) ? 'UTGST' : 'SGST';
  const add = (key: string, label: string, amount: Paise) => {
    if (amount === 0) return;
    const cur = rows.get(key);
    if (cur) cur.amount += amount;
    else rows.set(key, { key, label, amount });
  };
  for (const b of comp.buckets) {
    const rc = b.reverseCharge ? ' (reverse charge)' : '';
    const k = b.reverseCharge ? 'rc:' : '';
    add(`${k}igst:${b.rate}`, `IGST @ ${pct(b.rate)}${rc}`, b.igst);
    add(`${k}cgst:${b.rate}`, `CGST @ ${pct(b.rate / 2)}${rc}`, b.cgst);
    add(`${k}sgst:${b.rate}`, `${sgstLabel} @ ${pct(b.rate / 2)}${rc}`, b.sgst);
    add(`${k}cess:${b.cessRate}`, b.cessRate > 0 ? `Cess @ ${pct(b.cessRate)}${rc}` : `Cess${rc}`, b.cess);
  }
  return [...rows.values()];
}
