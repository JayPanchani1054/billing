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
    { ledgerName: 'Forex Gain/Loss', amount: -130_000 },
  ]);
  // The configured unrealised gain/loss ledger is named in the preview.
  assert.equal(revaluationJournalPreview(r, 'Exchange Fluctuation').at(-1)?.ledgerName, 'Exchange Fluctuation');
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

// ───────────────────────────── Ledger note, revaluation inputs, opening ─────────────────────────────

import { forexAtRate, impliedRate, ledgerExport, ledgerFooterNote, openingIssues, rateOverrides, revaluationBlocker, revaluationNarration, revaluationRateRows } from './model.ts';
import type { ForexLedgerStatement } from '../../../../shared/types/forex.ts';

const stmt = (over: Partial<ForexLedgerStatement>): ForexLedgerStatement => ({
  ledgerId: 7,
  ledgerName: 'Pacific Retail LLC',
  currency: usd,
  from: '2026-04-01',
  to: '2026-06-30',
  openingForex: 0,
  openingInr: 0,
  rows: [],
  totals: { forexDr: 0, forexCr: 0, inrDr: 0, inrCr: 0 },
  closingForex: 800,
  closingInr: 6_640_000,
  closingRate: 85,
  revaluedInr: 6_800_000,
  unrealised: 160_000,
  ...over,
});

test('ledger footer note: closing balance at the closing rate', () => {
  // $800 carried at ₹66,400.00 (₹83 / $); at ₹85: ₹68,000.00 → unrealised gain ₹1,600.00.
  assert.equal(ledgerFooterNote(stmt({}), money), 'At the closing rate ₹85.00 per USD the balance is worth ₹ 68,000.00 Dr: unrealised gain ₹ 1,600.00.');
  // A payable of $800 carried at ₹66,400 Cr, worth ₹68,000 Cr at ₹85: the liability grew → loss.
  assert.equal(
    ledgerFooterNote(stmt({ closingForex: -800, closingInr: -6_640_000, revaluedInr: -6_800_000, unrealised: -160_000 }), money),
    'At the closing rate ₹85.00 per USD the balance is worth ₹ 68,000.00 Cr: unrealised loss ₹ 1,600.00.',
  );
  assert.match(ledgerFooterNote(stmt({ closingRate: null, revaluedInr: null, unrealised: null }), money), /No closing rate for USD/);
  assert.equal(ledgerFooterNote(stmt({ closingForex: 0, closingInr: 0 }), money), 'Nothing is outstanding at the end of the period.');
  assert.match(ledgerFooterNote(stmt({ unrealised: 0, revaluedInr: 6_640_000, closingRate: 83 }), money), /the same as in the books\.$/);
});

test('ledger export note: Indian grouping and Dr / Cr like the screen, never a bare minus', () => {
  // A payable of $8,000 carried at ₹6,64,000 Cr, worth ₹6,80,000 Cr at ₹85 → unrealised loss ₹16,000.
  const x = ledgerExport(stmt({ closingForex: -8000, closingInr: -66_400_000, revaluedInr: -68_000_000, unrealised: -1_600_000 }));
  assert.equal(x.notes, 'At the closing rate ₹85.00 per USD the balance is worth ₹ 6,80,000.00 Cr: unrealised loss ₹ 16,000.00.');
  assert.doesNotMatch(x.notes ?? '', /-\d/);
  assert.match(ledgerExport(stmt({ closingRate: null, revaluedInr: null, unrealised: null })).notes ?? '', /No closing rate for USD/);
});

const reval: ForexRevaluationResult = {
  asOf: '2027-03-31',
  rateType: 'standard',
  rates: [
    { currencyId: 2, symbol: '$', formalName: 'US Dollar', rate: 85, rateDate: '2027-03-31', overridden: false },
    { currencyId: 3, symbol: '€', formalName: 'Euro', rate: null, rateDate: null, overridden: false },
  ],
  missingRates: [3],
  lines: [{ ledgerId: 7, ledgerName: 'Pacific Retail LLC', billName: 'EXP/1', currencyId: 2, forexAmount: 800, bookedAmount: 6_640_000, closingRate: 85, revaluedAmount: 6_800_000, adjustment: 160_000 }],
  net: 160_000,
  posted: [],
};

test('revaluation inputs: typed rates, blockers and narration', () => {
  const typed = new Map<number, number>([
    [3, 92.5],
    [2, 0],
  ]);
  // Only positive rates go to the server, ordered by currency.
  assert.deepEqual(rateOverrides(typed), [{ currencyId: 3, rate: 92.5 }]);
  const rows = revaluationRateRows(reval, typed);
  assert.deepEqual(
    rows.map((r) => [r.symbol, r.masterRate, r.typed]),
    [
      ['$', 85, 0],
      ['€', null, 92.5],
    ],
  );
  // Typed over the master: the master rate stays visible (the core reports it with masterRate).
  const over = revaluationRateRows(
    { ...reval, rates: [{ currencyId: 2, symbol: '$', formalName: 'US Dollar', rate: 86, rateDate: '2027-03-31', overridden: true, masterRate: 85, masterDate: '2027-03-30' }] },
    new Map([[2, 86]]),
  );
  assert.deepEqual([over[0].masterRate, over[0].masterDate, over[0].typed], [85, '2027-03-30', 86]);
  // A currency without a rate blocks posting until a rate is typed (the core refuses the same).
  assert.match(revaluationBlocker(reval, 0) ?? '', /No closing rate for Euro/);
  // A rate typed for one currency does not excuse another that still has none.
  assert.match(revaluationBlocker(reval, 1) ?? '', /No closing rate for Euro/);
  assert.equal(revaluationBlocker({ ...reval, missingRates: [] }, 1), null);
  assert.match(revaluationBlocker({ ...reval, missingRates: [], lines: [] }, 0) ?? '', /Nothing to revalue/);
  assert.equal(revaluationBlocker(undefined, 0), 'Loading…');
  assert.equal(
    revaluationNarration(reval, (iso) => iso),
    'Forex adjustment: foreign-currency balances restated at the closing standard rate as on 2027-03-31 ($ ₹85.00).',
  );
});

test('opening in currency: implied rate, fill at a rate, issues', () => {
  // ₹66,400.00 for $800 → ₹83 per $.
  assert.equal(impliedRate(6_640_000, 800), 83);
  assert.equal(impliedRate(-6_640_000, -800), 83);
  assert.equal(impliedRate(0, 800), null);
  // ₹66,400.00 Cr at ₹83 → $800 Cr (signed like the rupees); 0 rate → 0.
  assert.equal(forexAtRate(-6_640_000, 83, 2), -800);
  assert.equal(forexAtRate(6_640_000, 0, 2), 0);
  const bills = [
    { billName: 'EXP/1', amount: 4_150_000, forexAmount: 500 },
    { billName: 'EXP/2', amount: 2_490_000, forexAmount: 300 },
  ];
  assert.deepEqual(openingIssues(6_640_000, 800, bills, 2), []);
  assert.deepEqual(openingIssues(6_640_000, 800, [bills[0] as (typeof bills)[0], { ...(bills[1] as (typeof bills)[0]), forexAmount: 250 }], 2), ['The opening bills total 750 but the opening balance in the currency is 800.']);
  assert.match(openingIssues(6_640_000, -800, [], 2)[0] ?? '', /same side/);
  assert.match(openingIssues(0, 800, [], 2)[0] ?? '', /rupee opening balance on the ledger first/);
  // No bill split typed: only the balance is checked (bills are not sent).
  assert.deepEqual(openingIssues(6_640_000, 800, bills.map((b) => ({ ...b, forexAmount: null })), 2), []);
  assert.match(openingIssues(6_640_000, 800, [{ billName: 'EXP/1', amount: 4_150_000, forexAmount: -500 }], 2).join(' '), /Bill EXP\/1: the foreign amount must be on the same side/);
});
