/**
 * Ledger list filter chips (Parties, Cash & Bank, Sales, …) → `classes` for accounts.ledger.list,
 * and the opening-balance summary explanation. Pure — tested in ledgerFilters.test.ts.
 */
import { formatMoney } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { LedgerClassName, LedgerListRow, OpeningBalanceSummary } from '../../../../shared/types/accounts.ts';

export type LedgerChip = 'all' | 'parties' | 'cash_bank' | 'sales' | 'purchase' | 'duty_tax' | 'income' | 'expense';

export const LEDGER_CHIPS: ReadonlyArray<{ id: LedgerChip; label: string; classes: readonly LedgerClassName[] | null; hint: string }> = [
  { id: 'all', label: 'All', classes: null, hint: 'Every ledger' },
  { id: 'parties', label: 'Parties', classes: ['party'], hint: 'Customers (Sundry Debtors) and suppliers (Sundry Creditors)' },
  { id: 'cash_bank', label: 'Cash & Bank', classes: ['cash_bank'], hint: 'Cash-in-Hand, Bank Accounts and Bank OD' },
  { id: 'sales', label: 'Sales', classes: ['sales'], hint: 'Ledgers under Sales Accounts' },
  { id: 'purchase', label: 'Purchase', classes: ['purchase'], hint: 'Ledgers under Purchase Accounts' },
  { id: 'duty_tax', label: 'Duties & Taxes', classes: ['duty_tax'], hint: 'GST, TDS and other tax ledgers' },
  { id: 'income', label: 'Income', classes: ['income'], hint: 'Sales and other income ledgers' },
  { id: 'expense', label: 'Expense', classes: ['expense'], hint: 'Purchase and expense ledgers' },
];

export function chipClasses(chip: LedgerChip): LedgerClassName[] | undefined {
  const c = LEDGER_CHIPS.find((x) => x.id === chip)?.classes;
  return c ? [...c] : undefined;
}

/** Short type label for a ledger row ("Customer", "Bank", "GST ledger", …). */
export function ledgerKind(r: Pick<LedgerListRow, 'classes'>): string {
  const c = new Set(r.classes);
  if (c.has('debtor') && c.has('creditor')) return 'Party';
  if (c.has('debtor')) return 'Customer';
  if (c.has('creditor')) return 'Supplier';
  if (c.has('cash')) return 'Cash';
  if (c.has('bank')) return 'Bank';
  if (c.has('duty_tax')) return 'Tax';
  if (c.has('sales')) return 'Sales';
  if (c.has('purchase')) return 'Purchase';
  if (c.has('income')) return 'Income';
  if (c.has('expense')) return 'Expense';
  if (c.has('asset')) return 'Asset';
  if (c.has('liability')) return 'Liability';
  return '';
}

export interface OpeningExplanation {
  tone: 'success' | 'warning';
  title: string;
  body: string;
}

/**
 * Plain-English reading of the opening trial balance. difference = Σ Dr − Σ Cr (ledgers only).
 * With integrated inventory the opening stock (a debit) is added by reports, so a credit
 * difference equal to the opening stock is expected.
 */
export function explainOpening(s: OpeningBalanceSummary, openingStock: Paise | null): OpeningExplanation {
  const diff = s.difference;
  const withStock = openingStock !== null ? diff + openingStock : diff;
  if (s.ledgerCount === 0) {
    return { tone: 'success', title: 'No opening balances entered', body: 'Starting fresh? Nothing to do. Moving from another system? Enter each ledger\'s balance as on the day the books begin.' };
  }
  if (withStock === 0) {
    return {
      tone: 'success',
      title: 'Opening balances agree',
      body:
        openingStock !== null && openingStock !== 0
          ? `Debits equal credits once the opening stock of ₹ ${formatMoney(openingStock)} is included.`
          : 'Total debits equal total credits.',
    };
  }
  const side = withStock > 0 ? 'debit' : 'credit';
  const amount = formatMoney(Math.abs(withStock));
  return {
    tone: 'warning',
    title: `Difference in opening balances: ₹ ${amount} ${side === 'debit' ? 'Dr' : 'Cr'}`,
    body:
      `Opening ${side}s exceed ${side === 'debit' ? 'credits' : 'debits'} by ₹ ${amount}. ` +
      'The Balance Sheet will show this as "Difference in opening balances" until it is corrected. ' +
      'Check the ledgers below against your last balance sheet — a balance on the wrong side (Dr/Cr) shows up as twice its amount.',
  };
}
