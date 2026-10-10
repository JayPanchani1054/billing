/**
 * Test helpers of the tds module (used by *.test.ts only): a GST company in Maharashtra (27) with TDS
 * and TCS on, dated 15-Jun-2026 (FY 2026-27), with deductees, TDS-applicable expense ledgers and a
 * TCS sales ledger.
 */
import type { VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { createTestCompany, makeGstin, type TestCompany, type TestCompanyOptions } from '../../testing/fixtures.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { saveLedgerDetails, saveSettings } from './masters.ts';
import { getTdsSettings } from './store.ts';

export interface TdsKit {
  t: TestCompany;
  /** Ledger ids by short name. */
  L: Record<string, number>;
  /** Nature id by section ('194C', '194J(b)', …; TCS: 'scrap', 'vehicle'). */
  N: Record<string, number>;
  vt: TestCompany['ids']['voucherTypes'];
}

export const PAN = {
  contractor: 'ABCFS1234C', // firm
  labour: 'ABCPL5678M', // individual
  prof: 'ABCPK2468P', // individual
  landlord: 'ABCPR1357Q', // individual
  supplier: 'ABCCG9876H', // company
  buyer: 'ABCCB4321K', // company
};

export function setupTds(opts: TestCompanyOptions = {}): TdsKit {
  const t = createTestCompany({ today: '2026-06-15', ...opts, features: { tds: true, tcs: true, ...opts.features } });
  const nature = (kind: string, where: string): number => {
    const id = t.db.value<number>(`SELECT id FROM tds_natures WHERE kind = :kind AND ${where}`, { kind });
    if (id === undefined) throw new Error(`nature ${where} missing`);
    return id;
  };
  const N: Record<string, number> = {
    '194C': nature('tds', "section = '194C'"),
    '194H': nature('tds', "section = '194H'"),
    '194I(b)': nature('tds', "section = '194I(b)'"),
    '194J(b)': nature('tds', "section = '194J(b)'"),
    '194Q': nature('tds', "section = '194Q'"),
    '195': nature('tds', "section = '195'"),
    scrap: nature('tcs', "name = 'Sale of scrap'"),
    vehicle: nature('tcs', "section = '206C(1F)'"),
  };
  const L: Record<string, number> = { bank: 0 };
  L.bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS' });
  L.contractor = t.addLedger({ name: 'Sharma Contractors', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', PAN.contractor), pan: PAN.contractor });
  L.labour = t.addLedger({ name: 'Ramesh Labour', group: 'SUNDRY_CREDITORS', pan: PAN.labour });
  L.noPan = t.addLedger({ name: 'Unknown Carpenter', group: 'SUNDRY_CREDITORS' });
  L.prof = t.addLedger({ name: 'CA Kapoor', group: 'SUNDRY_CREDITORS', pan: PAN.prof });
  L.landlord = t.addLedger({ name: 'Rao Properties', group: 'SUNDRY_CREDITORS', pan: PAN.landlord });
  L.supplier = t.addLedger({ name: 'Grain Corp Ltd', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', PAN.supplier), pan: PAN.supplier });
  L.buyer = t.addLedger({ name: 'Metal Recyclers Ltd', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', PAN.buyer), pan: PAN.buyer });
  L.customer = t.addLedger({ name: 'Acme Buyer Ltd', group: 'SUNDRY_DEBTORS' });
  L.contractExp = t.addLedger({ name: 'Contract Charges', group: 'DIRECT_EXPENSES', gstRate: 18, hsnSac: '995411', supplyType: 'services' });
  L.labourExp = t.addLedger({ name: 'Labour Charges', group: 'DIRECT_EXPENSES' });
  L.profFees = t.addLedger({ name: 'Professional Fees', group: 'INDIRECT_EXPENSES' });
  L.rentExp = t.addLedger({ name: 'Office Rent', group: 'INDIRECT_EXPENSES' });
  L.scrapSales = t.addLedger({ name: 'Sale of Scrap', group: 'SALES_ACCOUNTS', gstRate: 18, hsnSac: '7204', supplyType: 'goods' });
  L.purchase = t.ids.ledgers.PURCHASE;
  L.sales = t.ids.ledgers.SALES;

  const det = (ledgerId: number, x: Partial<Parameters<typeof saveLedgerDetails>[1]>): void => {
    saveLedgerDetails(t.ctx, { ledgerId, applicable: false, ...x });
  };
  det(L.contractExp, { applicable: true, natureId: N['194C'] });
  det(L.labourExp, { applicable: true, natureId: N['194C'] });
  det(L.profFees, { applicable: true, natureId: N['194J(b)'] });
  det(L.rentExp, { applicable: true, natureId: N['194I(b)'] });
  det(L.scrapSales, { applicable: true, natureId: N.scrap });
  det(L.contractor, { applicable: true, deducteeType: 'firm', natureId: N['194C'] });
  det(L.labour, { applicable: true, deducteeType: 'individual' });
  det(L.prof, { applicable: true, deducteeType: 'individual', natureId: N['194J(b)'] });
  det(L.landlord, { applicable: true, deducteeType: 'individual' });
  det(L.supplier, { applicable: true, deducteeType: 'company' });
  det(L.buyer, { applicable: true, deducteeType: 'company' });
  return { t, L, N, vt: t.ids.voucherTypes };
}

export function enable194Q(k: TdsKit): void {
  saveSettings(k.t.ctx, { ...getTdsSettings(k.t.db), buyer194Q: true });
  saveLedgerDetails(k.t.ctx, { ledgerId: k.L.purchase, applicable: true, natureId: k.N['194Q'] });
}

export function save(k: TdsKit, input: VoucherInput): VoucherSaveResult {
  return saveVoucher(k.t.ctx, { acknowledgeWarnings: true, ...input });
}

export function entries(k: TdsKit, voucherId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of k.t.db.all<{ name: string; amount: number }>(
    'SELECT l.name, le.amount FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id WHERE le.voucher_id = :id ORDER BY le.line_no',
    { id: voucherId },
  )) {
    out[r.name] = (out[r.name] ?? 0) + r.amount;
  }
  return out;
}

export interface TdsLineDb {
  kind: string;
  section: string;
  party_ledger_id: number | null;
  assessable: number;
  catch_up: number;
  base: number;
  rate: number;
  computed: number;
  amount: number;
  status: string;
  overridden: number;
  reason: string | null;
  affects_books: number;
  pan_status: string;
}

export function tdsLines(k: TdsKit, voucherId: number): TdsLineDb[] {
  return k.t.db.all<TdsLineDb>('SELECT * FROM tds_lines WHERE voucher_id = :id ORDER BY line_no', { id: voucherId });
}

/** Journal: Dr expense / Cr party (gross). */
export function journal(k: TdsKit, date: string, expense: number, party: number, amount: number, extra: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: k.vt.journal,
    date,
    mode: 'ledger',
    ledgers: [
      { ledgerId: expense, amount },
      { ledgerId: party, amount: -amount },
    ],
    ...extra,
  };
}

/** Purchase in accounting-invoice mode: one expense line. */
export function purchase(k: TdsKit, date: string, party: number, expense: number, amount: number, ref: string, extra: Partial<VoucherInput> = {}): VoucherInput {
  return {
    voucherTypeId: k.vt.purchase,
    date,
    mode: 'accounting_invoice',
    partyLedgerId: party,
    referenceNo: ref,
    ledgers: [{ ledgerId: expense, amount }],
    ...extra,
  };
}
