/**
 * Opening bills of a bill-wise ledger: the live "bills total vs opening balance" check and row
 * validation (mirrors core validateBills). Amounts are signed paise (Dr +, Cr −).
 * Pure — tested in openingBills.test.ts.
 */
import { formatDate } from '../../../../shared/dates.ts';
import { formatDrCr } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { OpeningBill, OpeningBillInput } from '../../../../shared/types/accounts.ts';

export interface BillDraft {
  /** Stable React key. */
  key: string;
  billName: string;
  billDate: string | null;
  dueDate: string | null;
  /** Signed paise; null while empty. */
  amount: Paise | null;
}

let seq = 0;
export function newBillKey(): string {
  seq += 1;
  return `bill-${seq}`;
}

export function emptyBill(booksFrom: string): BillDraft {
  return { key: newBillKey(), billName: '', billDate: booksFrom, dueDate: null, amount: null };
}

export function billDraftFrom(b: OpeningBill): BillDraft {
  return { key: `saved-${b.id}`, billName: b.billName, billDate: b.billDate, dueDate: b.dueDate, amount: b.amount };
}

/** A row the user has not started (ignored on save). */
export function isBlankBill(b: BillDraft): boolean {
  return b.billName.trim() === '' && (b.amount === null || b.amount === 0) && b.dueDate === null;
}

export interface BillsCheck {
  /** Σ amounts of the non-blank rows (signed). */
  total: Paise;
  /** opening − total (signed): what is still to be allocated to bills. */
  difference: Paise;
  /** Rows entered (non-blank). */
  count: number;
  /** true when no bills are entered (the whole opening stays on account) or they add up exactly. */
  balanced: boolean;
  /** Plain-English status line for the grid footer. */
  message: string;
}

const money = (p: Paise): string => (p === 0 ? '0.00' : formatDrCr(p));

/**
 * Live check of the bills against the opening balance.
 * Example: opening 1,18,000.00 Dr, bills 1,00,000 Dr + 15,000 Dr → total 1,15,000 Dr, difference
 * 3,000 Dr still to allocate.
 */
export function checkBills(opening: Paise, bills: readonly BillDraft[]): BillsCheck {
  const rows = bills.filter((b) => !isBlankBill(b));
  const total = rows.reduce((s, b) => s + (b.amount ?? 0), 0);
  const difference = opening - total;
  if (rows.length === 0) {
    return {
      total: 0,
      difference: opening,
      count: 0,
      balanced: true,
      message: opening === 0 ? 'No opening bills.' : `No bills entered — the whole opening balance of ₹ ${money(opening)} will be kept on account.`,
    };
  }
  if (difference === 0) {
    return { total, difference, count: rows.length, balanced: true, message: `Bills total ₹ ${money(total)} — matches the opening balance.` };
  }
  return {
    total,
    difference,
    count: rows.length,
    balanced: false,
    message: `Bills total ₹ ${money(total)} but the opening balance is ₹ ${money(opening)}: ₹ ${money(difference)} is not yet allocated to a bill.`,
  };
}

/** Per-row problems keyed `openingBills[i].<field>` (i = index in the full list, blanks included). */
export function validateBills(bills: readonly BillDraft[], booksFrom: string): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  bills.forEach((b, i) => {
    if (isBlankBill(b)) return;
    const p = `openingBills[${i}]`;
    const name = b.billName.trim();
    if (name === '') out[`${p}.billName`] = 'Enter the bill number';
    else if (seen.has(name.toLowerCase())) out[`${p}.billName`] = `Bill '${name}' is entered twice`;
    if (name) seen.add(name.toLowerCase());
    if (!b.billDate) out[`${p}.billDate`] = 'Enter the bill date';
    else if (b.billDate > booksFrom) out[`${p}.billDate`] = `Opening bills must be dated on or before ${formatDate(booksFrom)}, when the books begin`;
    if (b.dueDate && b.billDate && b.dueDate < b.billDate) out[`${p}.dueDate`] = 'Due date is before the bill date';
    if (b.amount === null || b.amount === 0) out[`${p}.amount`] = 'Enter the amount still outstanding';
  });
  return out;
}

/**
 * Bills for the save input (blank rows dropped). Server errors use the index in this list, so
 * `serverIndexMap` maps it back to the row index in the grid.
 */
export function billsForSave(bills: readonly BillDraft[]): { input: OpeningBillInput[]; serverIndexMap: number[] } {
  const input: OpeningBillInput[] = [];
  const serverIndexMap: number[] = [];
  bills.forEach((b, i) => {
    if (isBlankBill(b)) return;
    input.push({ billName: b.billName.trim(), billDate: b.billDate ?? '', dueDate: b.dueDate, amount: b.amount ?? 0 });
    serverIndexMap.push(i);
  });
  return { input, serverIndexMap };
}

/** Rewrite server paths `openingBills[k].x` (k in the save list) to grid row indices. */
export function remapBillErrors(errors: Readonly<Record<string, string>>, serverIndexMap: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, msg] of Object.entries(errors)) {
    const m = /^openingBills\[(\d+)\](.*)$/.exec(path);
    if (m) {
      const row = serverIndexMap[Number(m[1])];
      out[`openingBills[${row ?? m[1]}]${m[2]}`] = msg;
    } else out[path] = msg;
  }
  return out;
}

/** Same bills as the saved list (order and values)? */
export function sameBills(a: readonly OpeningBillInput[], b: readonly OpeningBill[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.billName === b[i].billName && x.billDate === b[i].billDate && (x.dueDate ?? null) === b[i].dueDate && x.amount === b[i].amount);
}

/** Fill the last row with the unallocated difference (Tally-style quick balance). */
export function fillDifference(bills: readonly BillDraft[], opening: Paise, booksFrom: string): BillDraft[] {
  const check = checkBills(opening, bills);
  if (check.difference === 0) return bills.slice();
  const out = bills.slice();
  const lastBlank = out.length > 0 && isBlankBill(out[out.length - 1]) ? out.length - 1 : -1;
  if (lastBlank >= 0) out[lastBlank] = { ...out[lastBlank], amount: check.difference };
  else out.push({ ...emptyBill(booksFrom), amount: check.difference });
  return out;
}
