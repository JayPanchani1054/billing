/**
 * Test helpers for the banking module (used by *.test.ts only). A GST company in Maharashtra dated
 * 30-Apr-2026 (books from 1-Apr-2026) with an HDFC current account (opening ₹1,00,000.00 Dr), an SBI cash
 * credit (Bank OD, opening ₹2,00,000.00 Cr), parties and expense/income ledgers. Vouchers are posted through
 * the real vouchers service.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { InstrumentInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany, type TestCompanyOptions } from '../../testing/fixtures.ts';
import { saveVoucher } from '../vouchers/service.ts';

export interface BankKit {
  t: TestCompany;
  vt: Record<VoucherBaseType, number>;
  /** hdfc, sbiOd, cash, acme, bharat, supreme, rent, charges, interest */
  L: Record<string, number>;
}

/** Rupees → paise. */
export const rs = (rupees: number): number => Math.round(rupees * 100);

export function setupBank(opts: TestCompanyOptions = {}): BankKit {
  const t = createTestCompany({ today: '2026-04-30', booksFrom: '2026-04-01', ...opts });
  const L: Record<string, number> = { cash: t.ids.ledgers.CASH };
  L.hdfc = t.addLedger({
    name: 'HDFC Bank',
    group: 'BANK_ACCOUNTS',
    openingBalance: rs(1_00_000),
    bank: { accountNo: '50100012345678', ifsc: 'HDFC0000001', bankName: 'HDFC Bank', branch: 'Fort, Mumbai', holder: 'Test Traders Pvt Ltd' },
  });
  L.sbiOd = t.addLedger({ name: 'SBI Cash Credit', group: 'BANK_OD', openingBalance: -rs(2_00_000), bank: { bankName: 'State Bank of India', accountNo: '00000031234567890' } });
  L.acme = t.addLedger({ name: 'Acme Traders', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(1)) });
  L.bharat = t.addLedger({ name: 'Bharat Stores', group: 'SUNDRY_DEBTORS' });
  L.supreme = t.addLedger({ name: 'Supreme Suppliers', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(4)) });
  L.rent = t.addLedger({ name: 'Office Rent', group: 'INDIRECT_EXPENSES' });
  L.charges = t.addLedger({ name: 'Bank Charges', group: 'INDIRECT_EXPENSES' });
  L.interest = t.addLedger({ name: 'Interest Received', group: 'INDIRECT_INCOMES' });
  return { t, vt: t.ids.voucherTypes, L };
}

export interface PostOpts {
  date: string;
  /** Rupees. */
  amount: number;
  /** Party / expense / income ledger id. */
  other: number;
  bank?: number;
  instrument?: InstrumentInput;
  postDated?: boolean;
  optional?: boolean;
  narration?: string;
}

export interface Posted {
  voucherId: number;
  /** The bank ledger entry. */
  entryId: number;
  number: string | null;
}

function post(k: BankKit, base: 'receipt' | 'payment' | 'contra', ledgers: NonNullable<VoucherInput['ledgers']>, o: PostOpts, bankId: number): Posted {
  const res = saveVoucher(k.t.ctx, {
    voucherTypeId: k.vt[base],
    date: o.date,
    mode: 'ledger',
    ledgers,
    isPostDated: o.postDated,
    isOptional: o.optional,
    narration: o.narration,
    acknowledgeWarnings: true,
  });
  return { voucherId: res.id, entryId: bankEntry(k, res.id, bankId), number: res.number };
}

/** Receipt: Dr bank / Cr other. */
export function receipt(k: BankKit, o: PostOpts): Posted {
  const bank = o.bank ?? k.L.hdfc;
  const a = rs(o.amount);
  return post(k, 'receipt', [{ ledgerId: bank, amount: a, instrument: o.instrument }, { ledgerId: o.other, amount: -a }], o, bank);
}

/** Payment: Dr other / Cr bank. */
export function payment(k: BankKit, o: PostOpts): Posted {
  const bank = o.bank ?? k.L.hdfc;
  const a = rs(o.amount);
  return post(k, 'payment', [{ ledgerId: o.other, amount: a }, { ledgerId: bank, amount: -a, instrument: o.instrument }], o, bank);
}

/** Contra: Dr `other` (cash/bank) / Cr bank when amount > 0 … use `deposit: true` to debit the bank instead. */
export function contra(k: BankKit, o: PostOpts & { deposit?: boolean }): Posted {
  const bank = o.bank ?? k.L.hdfc;
  const a = rs(o.amount);
  const ledgers = o.deposit
    ? [{ ledgerId: bank, amount: a, instrument: o.instrument }, { ledgerId: o.other, amount: -a }]
    : [{ ledgerId: o.other, amount: a }, { ledgerId: bank, amount: -a, instrument: o.instrument }];
  return post(k, 'contra', ledgers, o, bank);
}

export function bankEntry(k: BankKit, voucherId: number, bankId: number): number {
  const id = k.t.db.value<number>('SELECT id FROM ledger_entries WHERE voucher_id = :v AND ledger_id = :l ORDER BY line_no LIMIT 1', { v: voucherId, l: bankId });
  if (id === undefined) throw new Error(`no bank entry in voucher ${voucherId}`);
  return id;
}

export function bankDateOf(k: BankKit, entryId: number): string | null {
  return k.t.db.value<string>('SELECT bank_date FROM ledger_entries WHERE id = :id', { id: entryId }) ?? null;
}

export const cheque = (number: string, date?: string, bankName?: string): InstrumentInput => ({ type: 'cheque', number, date, bankName });

/** UTF-8 bytes of a CSV/TSV text. */
export const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Statement line ids of a ledger in chronological order. */
export function lineIds(k: BankKit, ledgerId = k.L.hdfc): number[] {
  return k.t.db.all<{ id: number }>('SELECT id FROM bank_statement_lines WHERE ledger_id = :l ORDER BY txn_date, batch_id, seq', { l: ledgerId }).map((r) => r.id);
}

export function lineStatus(k: BankKit, lineId: number): { status: string; matched_entry_id: number | null; match_method: string | null } {
  return k.t.db.get('SELECT status, matched_entry_id, match_method FROM bank_statement_lines WHERE id = :id', { id: lineId }) as {
    status: string;
    matched_entry_id: number | null;
    match_method: string | null;
  };
}
