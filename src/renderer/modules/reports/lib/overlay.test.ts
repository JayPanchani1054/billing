import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StatementLine } from '../../../../shared/types/reports.ts';
import { statementExport, tbExport } from './model.ts';
import { overlayText, rowBudget, sideBudget, tbVariance, withScenario, withTbBudget } from './overlay.ts';

const line = (key: string, name: string, amount: number, level = 0): StatementLine => ({ key, kind: key.startsWith('g:') ? 'group' : 'ledger', id: 1, name, level, parentKey: null, hasChildren: false, amount, compare: null });

describe('reports scenario / budget overlay', () => {
  // Budget: Rent (l:5) ₹50,000 Dr; Sales (g:2) ₹2,00,000 Cr; Debtors target (g:7) ₹30,000 Dr.
  const byKey = { 'l:5': 5000000, 'g:2': -20000000, 'g:7': 3000000 };

  it('budget per row, side-natural on statements', () => {
    assert.equal(rowBudget(byKey, 'l:5'), 5000000);
    assert.equal(rowBudget(byKey, 'l:6'), null);
    assert.equal(rowBudget(null, 'l:5'), null);
    // P&L: expenses (left) are Dr-natural, income (right) Cr-natural → both shown positive.
    assert.equal(sideBudget(byKey, 'l:5', true), 5000000);
    assert.equal(sideBudget(byKey, 'g:2', false), 20000000);
    // A Dr budget shown on a Cr-natural side reads negative (a contra figure), like the amounts there.
    assert.equal(sideBudget(byKey, 'g:7', false), -3000000);
  });

  it('Trial Balance variance = closing − budget; export gains Budget and Variance columns', () => {
    // Rent closing ₹55,000 Dr vs ₹50,000 Dr budget → ₹5,000 Dr over.
    assert.equal(tbVariance(byKey, { key: 'l:5', closing: 5500000, debit: 5500000, credit: 0 }), 500000);
    // Sales closing ₹1,80,000 Cr vs ₹2,00,000 Cr budget → ₹20,000 Dr (short of target).
    assert.equal(tbVariance(byKey, { key: 'g:2', closing: -18000000, debit: 0, credit: 18000000 }), 2000000);
    assert.equal(tbVariance(byKey, { key: 'l:9', closing: 100, debit: 100, credit: 0 }), null);
    const rows = [
      { key: 'g:2', kind: 'group' as const, id: 2, name: 'Sales Accounts', level: 0, parentKey: null, hasChildren: false, opening: 0, debit: 0, credit: 18000000, closing: -18000000 },
      { key: 'l:5', kind: 'ledger' as const, id: 5, name: 'Rent', level: 0, parentKey: null, hasChildren: false, opening: 0, debit: 5500000, credit: 0, closing: 5500000 },
    ];
    const plain = tbExport(rows, { opening: false, transactions: false });
    const t = withTbBudget(plain, rows, byKey, 'FY 2026-27');
    assert.deepEqual(t.columns.slice(-2).map((c) => c.header), ['Budget (FY 2026-27)', 'Variance']);
    assert.deepEqual(t.rows[0].slice(-2), [-20000000, 2000000]);
    assert.deepEqual(t.rows[1].slice(-2), [5000000, 500000]);
    assert.equal(t.totals?.length, t.columns.length);
    assert.equal(withTbBudget(plain, rows, null, 'x'), plain, 'no budget: unchanged');
  });

  it('Trial Balance variance compares like with like: nett budgets with the period, closing budgets with the closing balance', () => {
    // Fixed assets (l:11): opening ₹5,00,000 Dr, bought ₹80,000 in the period → closing ₹5,80,000 Dr.
    // Capex budget ₹1,00,000 Dr on nett transactions → variance = 80,000 − 1,00,000 = ₹20,000 Cr (not 4,80,000 Dr).
    const b = { 'l:11': 10000000, 'g:7': 3000000, 'g:9': 100 };
    const basis = { 'l:11': 'net_transactions', 'g:7': 'closing_balance', 'g:9': 'mixed' };
    const fa = { opening: 50000000, debit: 8000000, credit: 0, closing: 58000000 };
    assert.equal(tbVariance(b, { key: 'l:11', ...fa }, basis), -2000000);
    assert.equal(tbVariance(b, { key: 'l:11', ...fa }), 48000000, 'without the basis (older data) the closing balance is used');
    // Debtors target ₹30,000 Dr on closing balance; closing ₹36,000 Dr after ₹50,000 Dr / ₹44,000 Cr → ₹6,000 Dr over.
    assert.equal(tbVariance(b, { key: 'g:7', debit: 5000000, credit: 4400000, closing: 600000 + 3000000 }, basis), 600000);
    // A group rolling up nett and closing budgets has no single figure to compare.
    assert.equal(tbVariance(b, { key: 'g:9', debit: 1, credit: 0, closing: 1 }, basis), null);
    const rows = [{ key: 'l:11', kind: 'ledger' as const, id: 11, name: 'Plant', level: 0, parentKey: null, hasChildren: false, ...fa }];
    assert.deepEqual(withTbBudget(tbExport(rows, { opening: false, transactions: false }), rows, b, 'Capex', basis).rows[0].slice(-2), [10000000, -2000000]);
  });

  it('statement export puts a budget column on each side', () => {
    const t = statementExport(
      { left: 'Expenses', right: 'Income' },
      [{ left: [line('l:5', 'Rent', 5500000)], right: [line('g:2', 'Sales Accounts', 18000000)], total: 18000000, compareTotal: null }],
      null,
      { byKey, leftDrNatural: true, name: 'FY' },
    );
    assert.deepEqual(t.columns.map((c) => c.header), ['Expenses', 'Amount', 'Budget (FY)', 'Income', 'Amount', 'Budget (FY)']);
    assert.deepEqual(t.rows[0], ['Rent', 5500000, 5000000, 'Sales Accounts', 18000000, 20000000]);
    assert.deepEqual(t.rows[1], ['Total', 18000000, null, 'Total', 18000000, null]);
    // Without a budget the export is what it always was.
    const plain = statementExport({ left: 'Expenses', right: 'Income' }, [{ left: [line('l:5', 'Rent', 1)], right: [], total: 1, compareTotal: null }], null);
    assert.equal(plain.columns.length, 4);
  });

  it('carries the scenario into Group Summary drill-downs only; describes the overlay', () => {
    assert.deepEqual(withScenario({ screen: 'reports.groupSummary', params: { groupId: 2 } }, 3), { screen: 'reports.groupSummary', params: { groupId: 2, scenarioId: 3 } });
    const ledger = { screen: 'reports.ledger', params: { ledgerId: 5 } };
    assert.equal(withScenario(ledger, 3), ledger);
    assert.equal(withScenario(null, 3), null);
    assert.equal(overlayText(null, null), null);
    assert.equal(overlayText('Provisional', { name: 'FY 2026-27', proRata: 0.5 }), 'Scenario: Provisional · Budget: FY 2026-27 (nett budgets × 50.00%)');
    assert.equal(overlayText(null, { name: 'FY', proRata: 1 }), 'Budget: FY');
  });
});
