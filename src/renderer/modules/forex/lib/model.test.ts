import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMoney } from '../../../../shared/format.ts';
import type { ForexCurrency, ForexOutstandingResult, ForexRevaluationResult, ForexVoucherPreview } from '../../../../shared/types/forex.ts';
import { entrySummary, fxDrCr, gainLossText, outstandingExport, outstandingRows, rateText, revaluationExport, revaluationJournalPreview, unrealisedText } from './model.ts';

const usd: ForexCurrency = { id: 2, symbol: '$', formalName: 'US Dollar', isoCode: 'USD', decimalPlaces: 2, isBase: false };
const money = (p: number): string => formatMoney(p);

test('labels', () => {
  assert.equal(fxDrCr(-1250, usd), '$ 1,250.00 Cr');
  assert.equal(fxDrCr(0, usd), '');
  assert.equal(rateText(83.25), '₹83.25');
  assert.equal(gainLossText(-45_000, money), 'Exchange gain ₹ 450.00');
  assert.equal(gainLossText(30_000, money), 'Exchange loss ₹ 300.00');
  assert.equal(unrealisedText(null, money), 'No closing rate');
  assert.equal(unrealisedText(160_000, money), 'Gain ₹ 1,600.00');
});

const out: ForexOutstandingResult = {
  asOf: '2026-06-30',
  rateType: 'standard',
  currencies: [usd],
  parties: [
    {
      ledgerId: 7,
      ledgerName: 'Pacific Retail LLC',
      currencyId: 2,
      forexBalance: 800,
      inrBalance: 6_640_000,
      revaluedBalance: 6_800_000,
      difference: 160_000,
      bills: [
        {
          billName: '1',
          billDate: '2026-05-20',
          dueDate: '2026-07-19',
          amount: 6_640_000,
          forexAmount: 800,
          bookedRate: 83,
          source: 'voucher',
          voucherId: 3,
          ledgerId: 7,
          ledgerName: 'Pacific Retail LLC',
          currencyId: 2,
          overdueDays: null,
          closingRate: 85,
          revaluedAmount: 6_800_000,
          difference: 160_000,
        },
      ],
    },
  ],
  totals: [{ currencyId: 2, forex: 800, inr: 6_640_000, revalued: 6_800_000, difference: 160_000 }],
};

test('outstanding: party row then its bills; export carries both currencies', () => {
  const rows = outstandingRows(out);
  assert.deepEqual(rows.map((r) => [r.level, r.name, r.forex, r.inr, r.bookedRate, r.closingRate, r.difference]), [
    [0, 'Pacific Retail LLC', 800, 6_640_000, 83, 85, 160_000],
    [1, '1', 800, 6_640_000, 83, 85, 160_000],
  ]);
  const x = outstandingExport(out);
  assert.equal(x.rows.length, 2);
  assert.deepEqual(x.rows[1].slice(4, 11), ['USD', 800, 83, 6_640_000, 85, 6_800_000, 160_000]);
});

test('revaluation export and journal preview', () => {
  const r: ForexRevaluationResult = {
    asOf: '2026-06-30',
    rateType: 'standard',
    rates: [{ currencyId: 2, symbol: '$', formalName: 'US Dollar', rate: 85, rateDate: '2026-06-30', overridden: false }],
    missingRates: [],
    lines: [
      { ledgerId: 7, ledgerName: 'Pacific Retail LLC', billName: '1', currencyId: 2, forexAmount: 800, bookedAmount: 6_640_000, closingRate: 85, revaluedAmount: 6_800_000, adjustment: 160_000 },
      { ledgerId: 9, ledgerName: 'Globex GmbH', billName: null, currencyId: 2, forexAmount: -300, bookedAmount: -2_520_000, closingRate: 85, revaluedAmount: -2_550_000, adjustment: -30_000 },
    ],
    net: 130_000,
    posted: [],
  };
  const x = revaluationExport(r);
  assert.deepEqual(x.totals?.[7], 130_000);
  assert.match(x.notes ?? '', /\$ 85\.00/);
  assert.deepEqual(revaluationJournalPreview(r), [
    { ledgerName: 'Pacific Retail LLC', amount: 160_000 },
    { ledgerName: 'Globex GmbH', amount: -30_000 },
    { ledgerName: 'Forex gain/loss (unrealised)', amount: -130_000 },
  ]);
});

test('entry summary from the server preview', () => {
  const p: ForexVoucherPreview = {
    currency: null,
    rate: null,
    documentForex: null,
    itemForex: [],
    ledgerForex: [],
    entries: [{ source: 'line', lineIndex: 1, ledgerId: 7, ledgerName: 'Acme', currencyId: 2, forexAmount: -600, rate: 84, amount: -4_995_000, bills: [] }],
    realised: [{ ledgerId: 7, ledgerName: 'Acme', billName: '1', forexAmount: 600, bookedAmount: 4_995_000, settledAmount: 5_040_000, difference: -45_000 }],
    gainLoss: -45_000,
    gainLossLedger: { id: 30, name: 'Forex Gain/Loss' },
  };
  assert.deepEqual(entrySummary(p, () => usd, money).map((l) => `${l.label}: ${l.value}`), [
    'Acme: $ 600.00 Cr → ₹ 49,950.00',
    'Bill 1: booked ₹ 49,950.00, now ₹ 50,400.00',
    'Forex Gain/Loss: Exchange gain ₹ 450.00',
  ]);
});
