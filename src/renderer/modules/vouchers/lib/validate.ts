/**
 * Checks the entry screen makes before sending a voucher (pure; tested in validate.test.ts).
 * The server repeats every rule; these only catch the obvious gaps early, next to the right cell,
 * in the same words an accountant would use.
 */
import type { Paise } from '../../../../shared/money.ts';
import type { NumberingMethod } from '../../../../shared/types/vouchers.ts';
import { allocationTotal } from './bills.ts';
import { cellId, headerId } from './errorPaths.ts';
import { formatMoney } from '../../../../shared/format.ts';
import { isBlankItem, isBlankLedger, ledgerDifference } from './formState.ts';
import type { VoucherForm } from './formState.ts';
import { isInvoiceMode, partyRequired, singleEntryAccountSide } from './kinds.ts';

export interface ClientCheckEnv {
  numberingMethod: NumberingMethod;
  /** Purchase from a registered supplier in a GST company: the supplier's invoice number is required. */
  referenceRequired: boolean;
  /** Invoice total the party's bill-wise allocation must add up to (invoice modes with a bill-wise party). */
  invoiceTotal?: Paise;
}

export interface ClientIssues {
  /** DOM id → message. */
  cells: Record<string, string>;
  /** First id in screen order (to focus). */
  first: string | null;
}

export function clientIssues(f: VoucherForm, env: ClientCheckEnv): ClientIssues {
  const cells: Record<string, string> = {};
  let first: string | null = null;
  const add = (id: string, message: string) => {
    if (id in cells) return;
    cells[id] = message;
    first ??= id;
  };

  if (env.numberingMethod === 'manual' && f.number.trim() === '' && !f.numberOverride && f.id === null) add(headerId('number'), 'Enter the voucher number (this voucher type is numbered manually).');
  if (partyRequired(f.baseType, f.mode) && f.mode !== 'ledger' && f.partyLedgerId === null) add(headerId('party'), 'Choose the party — the customer or supplier this voucher is for.');
  if (env.referenceRequired && f.referenceNo.trim() === '') add(headerId('referenceNo'), "Enter the supplier's invoice number — GST input credit is claimed against it.");
  if (f.mode === 'ledger' && f.layout === 'single' && singleEntryAccountSide(f.baseType) !== null && f.accountLedgerId === null) add(headerId('account'), 'Choose the cash or bank account.');
  // Bill-wise details typed earlier no longer match after the lines changed (the server would refuse: bill_mismatch).
  if (isInvoiceMode(f.mode) && env.invoiceTotal !== undefined && f.partyBills && f.partyBills.length > 0) {
    const alloc = allocationTotal(f.partyBills);
    if (alloc !== Math.abs(env.invoiceTotal)) {
      add(headerId('party'), `The bill-wise details add up to ₹ ${formatMoney(alloc)} but the invoice total is ₹ ${formatMoney(Math.abs(env.invoiceTotal))}. Press Alt+B to correct them.`);
    }
  }

  if (f.mode === 'item_invoice' || f.mode === 'inventory') {
    const filled = f.items.filter((r) => !isBlankItem(r));
    if (filled.length === 0 && f.items[0]) add(cellId('items', f.items[0].key, 'item'), 'Enter at least one item.');
    for (const r of filled) {
      const zeroAllowed = f.baseType === 'physical_stock';
      if (r.qty === null || (!zeroAllowed && r.qty <= 0)) add(cellId('items', r.key, 'qty'), 'Enter the quantity.');
      else if (r.qty < 0) add(cellId('items', r.key, 'qty'), 'Quantity cannot be negative.');
    }
  }

  if (f.mode === 'accounting_invoice') {
    const filled = f.ledgers.filter((r) => !isBlankLedger(r));
    if (filled.length === 0 && f.ledgers[0]) add(cellId('ledgers', f.ledgers[0].key, 'ledger'), 'Enter at least one income or expense line.');
  }

  if (isInvoiceMode(f.mode) || f.mode === 'ledger') {
    for (const r of f.ledgers) {
      if (isBlankLedger(r)) continue;
      if (r.amount === null || r.amount === 0) add(cellId('ledgers', r.key, 'amount'), 'Enter the amount.');
      else if (f.mode === 'ledger' && r.bills && r.bills.length > 0 && allocationTotal(r.bills) !== Math.abs(r.amount)) {
        add(cellId('ledgers', r.key, 'amount'), `The bill-wise details add up to ₹ ${formatMoney(allocationTotal(r.bills))}, not ₹ ${formatMoney(Math.abs(r.amount))}. Press Alt+B on this line to correct them.`);
      }
    }
  }

  const filledLedgers = f.ledgers.filter((r) => !isBlankLedger(r));
  if (f.mode === 'ledger' && filledLedgers.length === 0 && f.ledgers[0]) {
    add(cellId('ledgers', f.ledgers[0].key, 'ledger'), 'Enter at least one ledger line.');
  }
  // Dr/Cr layout: the voucher must balance (the single-entry Account line always balances itself).
  const doubleEntry = f.mode === 'ledger' && (f.layout === 'double' || singleEntryAccountSide(f.baseType) === null);
  if (doubleEntry && filledLedgers.length > 0) {
    const diff = ledgerDifference(f);
    if (diff !== 0) {
      const last = filledLedgers[filledLedgers.length - 1];
      add(cellId('ledgers', last.key, 'amount'), `Debit and credit differ by ₹ ${formatMoney(Math.abs(diff))} (${diff > 0 ? 'more debit' : 'more credit'}). Correct an amount or press Ctrl+B to balance on this line.`);
    }
  }
  return { cells, first };
}
