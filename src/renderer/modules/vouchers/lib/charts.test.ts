/**
 * The Day Book's graph (2.1.2): "graph total = table total" — the bars add up to the Debit total +
 * Credit total the table shows (optional and cancelled vouchers not counted); one bar per "Voucher types"
 * entry present; Enter on a bar selects that type; the gates; the kit's rules; speed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import type { VoucherListRow } from '../../../../shared/types/vouchers.ts';
import { drawnTotal, specProblems } from '../../../ui/lib/chartSpec.ts';
import { statTotalAllowed } from '../../../app/lib/chartCatalogue.ts';
import { dayBookChart, dayBookTypes, TOP_TYPES } from './charts.ts';
import { DAYBOOK_CHIPS, baseTypesOf, dayBookTotals, toDayBookRow } from './daybook.ts';
import type { DayBookRow } from './daybook.ts';

/** A listed voucher, through the same mapping the Day Book uses (`toDayBookRow`). */
function row(id: number, baseType: VoucherListRow['baseType'], typeName: string, amount: number, o: Partial<VoucherListRow> = {}): DayBookRow {
  return toDayBookRow({
    id,
    date: '2026-10-11',
    voucherTypeName: typeName,
    baseType,
    number: String(id),
    partyName: 'Asha Retail',
    narration: null,
    amount,
    isCancelled: false,
    isOptional: false,
    isPostDated: false,
    irnStatus: null,
    ...o,
  } as VoucherListRow);
}

/** A day of a hardware shop: two sales ₹43,000, a receipt ₹20,000, a payment ₹5,000, a purchase ₹12,000. */
const day = (): DayBookRow[] => [
  row(1, 'sales', 'Sales', 30_000_00),
  row(2, 'receipt', 'Receipt', 20_000_00),
  row(3, 'sales', 'Sales', 13_000_00),
  row(4, 'payment', 'Payment', 5_000_00),
  row(5, 'purchase', 'Purchase', 12_000_00),
  row(6, 'sales', 'Sales', 9_999_00, { isCancelled: true }),
  row(7, 'journal', 'Journal', 1_000_00, { isOptional: true }),
];

describe('dayBookChart: "What happened this period?" (2.1.2)', () => {
  test('graph total = the table\'s Debit + Credit totals (optional and cancelled not counted); a bar per type present', () => {
    const rows = day();
    const spec = dayBookChart(rows);
    assert.ok(spec);
    assert.deepEqual(specProblems(spec), []);
    const t = dayBookTotals(rows);
    assert.equal(spec.total, t.debit + t.credit);
    assert.equal(drawnTotal(spec), 80_000_00);
    assert.deepEqual(spec.categories, ['Sales', 'Receipt', 'Purchase', 'Payment']);
    assert.deepEqual(spec.series[0].values, [43_000_00, 20_000_00, 12_000_00, 5_000_00]);
    assert.equal(spec.kind, 'bar');
    assert.equal(spec.color ?? 'series', 'series', 'slot 1: no problem pole in a Day Book');
    assert.equal(spec.takeaway, 'Sales ₹43.0 K · Receipt ₹20.0 K');
  });

  test('types are the "Voucher types" menu entries: credit and debit notes are one bar; a type outside the menu keeps its name', () => {
    const rows = [row(1, 'credit_note', 'Credit Note', 2_000_00), row(2, 'debit_note', 'Debit Note', 1_000_00), row(3, 'quotation', 'Quotation', 7_000_00)];
    const types = dayBookTypes(rows);
    assert.deepEqual(
      types.map((t) => [t.label, t.chip, t.amount, t.count]),
      [
        ['Quotation', null, 7_000_00, 1],
        ['Credit / Debit Notes', 'notes', 3_000_00, 2],
      ],
    );
  });

  test('Enter on a bar shows only that voucher type (the menu\'s filter); "Other" and a type outside the menu select nothing', () => {
    const picked: string[] = [];
    const rows = [...day(), row(8, 'quotation', 'Quotation', 1_00_000_00)];
    const spec = dayBookChart(rows, (chip) => picked.push(chip));
    assert.ok(spec);
    spec.activate?.(0); // Quotation: not in the menu
    spec.activate?.(1); // Sales
    assert.deepEqual(picked, ['sales']);
    assert.deepEqual(baseTypesOf(picked), ['sales'], 'the same filter the menu sets');
    assert.ok(DAYBOOK_CHIPS.some((c) => c.id === 'sales'));
  });

  test('a bar whose "Voucher types" entry the menu hides (Orders with order processing off) is drawn but selects nothing', () => {
    // Enter on it would set a filter the menu cannot show or untick ("All vouchers" while filtered).
    const picked: string[] = [];
    const rows = [row(1, 'sales', 'Sales', 10_000_00), row(2, 'sales_order', 'Sales Order', 5_000_00)];
    const menu = DAYBOOK_CHIPS.filter((c) => c.id !== 'orders');
    const spec = dayBookChart(rows, (chip) => picked.push(chip), menu);
    assert.ok(spec);
    assert.deepEqual(spec.categories, ['Sales', 'Orders'], 'still drawn: the table lists it');
    spec.activate?.(1);
    spec.activate?.(0);
    assert.deepEqual(picked, ['sales']);
  });

  test('Enter on a bar keeps the keyboard in the Day Book: the filter leaves one type (no graph), so focus moves to the list', () => {
    // Without it the focused graph is removed and focus falls to <body>, where only global keys work.
    const screen = fs.readFileSync(new URL('../DayBookScreen.tsx', import.meta.url), 'utf8');
    const handler = /const showType = useCallback\(\s*\(chip: string\)(?::\s*void)?\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\[/.exec(screen);
    assert.ok(handler, 'the bar handler is a block (filter, then focus)');
    assert.match(handler[1], /setChips\(\[chip\]\)/);
    assert.match(handler[1], /gridRef\.current\?\.focus\(\)/);
    assert.match(screen, /<VoucherTable[^>]*\bgridRef=\{gridRef\}/);
    const table = fs.readFileSync(new URL('../VoucherTable.tsx', import.meta.url), 'utf8');
    assert.match(table, /<DataTable<DayBookRow>[\s\S]*?\bgridRef=\{gridRef\}[\s\S]*?\/>/, 'VoucherTable hands the ref to the grid');
  });

  test('more than 7 types: Top 6 + Other, Σ kept', () => {
    const kinds: Array<[VoucherListRow['baseType'], string]> = [
      ['sales', 'Sales'],
      ['purchase', 'Purchase'],
      ['receipt', 'Receipt'],
      ['payment', 'Payment'],
      ['contra', 'Contra'],
      ['journal', 'Journal'],
      ['credit_note', 'Credit Note'],
      ['sales_order', 'Sales Order'],
      ['delivery_note', 'Delivery Note'],
    ];
    const rows = kinds.map(([b, n], i) => row(i + 1, b, n, (i + 1) * 1_000_00));
    const spec = dayBookChart(rows);
    assert.ok(spec);
    assert.equal(spec.categories.length, TOP_TYPES + 1);
    assert.equal(spec.categories[TOP_TYPES], 'Other');
    const t = dayBookTotals(rows);
    assert.equal(spec.total, t.debit + t.credit);
  });

  test('gates: one voucher type is a sentence (2.1.1 D2); nothing listed → none', () => {
    assert.equal(dayBookChart([]), null);
    assert.equal(dayBookChart([row(1, 'sales', 'Sales', 1000), row(2, 'sales', 'Sales', 2000)]), null);
    assert.equal(dayBookChart([row(1, 'sales', 'Sales', 1000), row(2, 'receipt', 'Receipt', 2000, { isCancelled: true })]), null);
    assert.ok(dayBookChart([row(1, 'sales', 'Sales', 1000), row(2, 'receipt', 'Receipt', 2000)]));
  });

  test('the stat stays a count (never a total)', () => {
    assert.equal(statTotalAllowed('vouchers.daybook'), false);
  });

  test('10,000 listed vouchers stay under 50 ms', () => {
    const bases: VoucherListRow['baseType'][] = ['sales', 'purchase', 'receipt', 'payment', 'contra', 'journal'];
    const rows = Array.from({ length: 10_000 }, (_, i) => row(i, bases[i % bases.length], bases[i % bases.length], (i % 50) * 100 + 1));
    let ms = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      dayBookChart(rows);
      ms = Math.min(ms, performance.now() - t0);
    }
    assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
    const t = dayBookTotals(rows);
    assert.equal(dayBookChart(rows)?.total, t.debit + t.credit);
  });
});
