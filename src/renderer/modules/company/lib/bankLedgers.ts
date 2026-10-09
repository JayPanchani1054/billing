/**
 * F12 › Invoice printing › Bank account picker — pure (tested in bankLedgers.test.ts).
 *
 * Asks 'accounts.ledger.list' for bank-class ledgers matching what was typed (the server filters
 * and limits; 'accounts.ledger.picker' takes neither search nor limit and would return every
 * ledger with its balance on each keystroke).
 */
import type { LedgerListInput } from '../../../../shared/types/accounts.ts';

export interface BankOption {
  id: number;
  name: string;
}

export const BANK_PICKER_LIMIT = 20;

export function bankLedgerQuery(search: string): LedgerListInput {
  const q = search.trim();
  return { ...(q ? { search: q } : {}), classes: ['bank'], activeOnly: true, limit: BANK_PICKER_LIMIT };
}

/** Rows of a ledger list answer ({ rows } or an array) as picker options; malformed rows are skipped. */
export function parseBankLedgers(out: unknown): BankOption[] {
  const list = Array.isArray(out) ? out : typeof out === 'object' && out !== null && Array.isArray((out as { rows?: unknown }).rows) ? (out as { rows: unknown[] }).rows : [];
  const res: BankOption[] = [];
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id === 'number' && typeof o.name === 'string') res.push({ id: o.id, name: o.name });
  }
  return res;
}
