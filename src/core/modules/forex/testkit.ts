/**
 * Test helpers of the forex module (used by *.test.ts only): a GST company (Maharashtra) with
 * Multiple currencies on, US Dollar (2 decimals) and Euro rates, a USD customer and supplier
 * (overseas, bill-wise), an EEFC bank account kept in USD, an INR bank and an export sales ledger.
 */
import { saveCurrency, saveExchangeRate } from '../accounts/currencies.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { saveVoucher, previewVoucher } from '../vouchers/service.ts';
import type { VoucherInput, VoucherPreview, VoucherSaveResult } from '../../../shared/types/vouchers.ts';

export interface ForexTest {
  t: TestCompany;
  usd: number;
  eur: number;
  customer: number;
  supplier: number;
  eefc: number;
  bank: number;
  exportSales: number;
  importPurchase: number;
  save(input: Omit<VoucherInput, 'voucherTypeId'> & { voucherTypeId?: number; base?: keyof TestCompany['ids']['voucherTypes'] }): VoucherSaveResult;
  preview(input: Omit<VoucherInput, 'voucherTypeId'> & { voucherTypeId?: number; base?: keyof TestCompany['ids']['voucherTypes'] }): VoucherPreview;
  entries(voucherId: number): Array<{ ledger_id: number; amount: number; forex_amount: number | null; exchange_rate: number | null; currency_id: number | null }>;
  bills(voucherId: number): Array<{ ledger_id: number; ref_type: string; bill_name: string | null; amount: number; forex_amount: number | null }>;
}

export function forexCompany(opts: { today?: string; multiCurrency?: boolean } = {}): ForexTest {
  const t = createTestCompany({ today: opts.today ?? '2026-06-30', features: { multiCurrency: opts.multiCurrency ?? true, billWise: true, inventory: true } });
  const usd = saveCurrency(t.ctx, { symbol: '$', formalName: 'US Dollar', isoCode: 'USD', decimalPlaces: 2 }).id;
  const eur = saveCurrency(t.ctx, { symbol: '€', formalName: 'Euro', isoCode: 'EUR', decimalPlaces: 2 }).id;
  saveExchangeRate(t.ctx, { currencyId: usd, date: '2026-04-01', standard: 83, selling: 83.5, buying: 82.5 });
  saveExchangeRate(t.ctx, { currencyId: usd, date: '2026-06-30', standard: 85, selling: 85.4, buying: 84.6 });
  saveExchangeRate(t.ctx, { currencyId: eur, date: '2026-04-01', standard: 90, selling: 90.5, buying: 89.5 });
  const customer = t.addLedger({
    name: 'Acme Inc (USA)',
    group: 'SUNDRY_DEBTORS',
    registrationType: 'overseas',
    billWise: true,
    creditDays: 60,
    columns: { currency_id: usd, country: 'United States' },
  });
  const supplier = t.addLedger({
    name: 'Globex GmbH',
    group: 'SUNDRY_CREDITORS',
    registrationType: 'overseas',
    billWise: true,
    columns: { currency_id: usd, country: 'Germany' },
  });
  const eefc = t.addLedger({ name: 'EEFC Account (USD)', group: 'BANK_ACCOUNTS', columns: { currency_id: usd } });
  const bank = t.addLedger({ name: 'HDFC Bank', group: 'BANK_ACCOUNTS' });
  const exportSales = t.addLedger({ name: 'Export Sales', group: 'SALES_ACCOUNTS', gstApplicable: true, gstRate: 18, hsnSac: '998314', supplyType: 'services' });
  const importPurchase = t.addLedger({ name: 'Import of Services', group: 'PURCHASE_ACCOUNTS', gstApplicable: true, gstRate: 18, hsnSac: '998314', supplyType: 'services' });
  const typed = (input: Omit<VoucherInput, 'voucherTypeId'> & { voucherTypeId?: number; base?: keyof TestCompany['ids']['voucherTypes'] }): VoucherInput => {
    const { base, ...rest } = input;
    return { ...rest, voucherTypeId: input.voucherTypeId ?? t.ids.voucherTypes[base ?? 'journal'] } as VoucherInput;
  };
  return {
    t,
    usd,
    eur,
    customer,
    supplier,
    eefc,
    bank,
    exportSales,
    importPurchase,
    save: (input) => saveVoucher(t.ctx, { acknowledgeWarnings: true, ...typed(input) }),
    preview: (input) => previewVoucher(t.ctx, typed(input)),
    entries: (voucherId) =>
      t.db.all('SELECT ledger_id, amount, forex_amount, exchange_rate, currency_id FROM ledger_entries WHERE voucher_id = :v ORDER BY line_no', { v: voucherId }),
    bills: (voucherId) => t.db.all('SELECT ledger_id, ref_type, bill_name, amount, forex_amount FROM bill_allocations WHERE voucher_id = :v ORDER BY id', { v: voucherId }),
  };
}
