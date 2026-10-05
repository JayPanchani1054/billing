import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FieldIssue } from '../../../shared/api.ts';
import { AppError } from '../../lib/errors.ts';
import { createTestCompany } from '../../testing/fixtures.ts';
import { saveLedger } from './ledgers.ts';
import { lastAudit, postRaw } from './testkit.ts';
import { checkNumbering, deleteVoucherType, getVoucherType, listVoucherTypes, saveVoucherType } from './voucherTypes.ts';

const isErr = (code: string, re?: RegExp) => (e: unknown) => e instanceof AppError && e.code === code && (!re || re.test(e.message));

function expectIssue(fn: () => unknown, path: string, re: RegExp): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError && e.code === 'VALIDATION', `expected VALIDATION, got ${String(e)}`);
    const hit = (e.details as FieldIssue[]).find((i) => i.path === path);
    assert.ok(hit, `no issue at ${path}: ${JSON.stringify(e.details)}`);
    assert.match(hit.message, re);
    return;
  }
  assert.fail(`expected a validation error at ${path}`);
}

describe('voucher types: list & create', () => {
  it('lists the 18 predefined types in hotkey order with numbering and voucher counts', () => {
    const t = createTestCompany();
    postRaw(t, { date: '2026-04-02', baseType: 'sales', lines: [[t.ids.ledgers.CASH, 100], [t.ids.ledgers.SALES, -100]] });
    const { rows, total } = listVoucherTypes(t.db);
    assert.equal(total, 18);
    assert.deepEqual(
      rows.slice(0, 5).map((r) => r.name),
      ['Contra', 'Payment', 'Receipt', 'Journal', 'Sales'],
    );
    const sales = rows.find((r) => r.baseType === 'sales');
    assert.equal(sales?.hotkey, 'F8');
    assert.equal(sales?.voucherCount, 1);
    assert.deepEqual(sales?.numbering, { method: 'automatic', prefix: null, suffix: null, start: 1, width: 0, restart: 'yearly' });
    assert.equal(listVoucherTypes(t.db, { search: 'note' }).total, 4);
    t.close();
  });

  it('creates a custom type under a predefined one, inheriting base type, flags and config', () => {
    const t = createTestCompany();
    const vt = saveVoucherType(t.ctx, {
      name: 'Cash Sales',
      parentId: t.ids.voucherTypes.sales,
      numbering: { prefix: 'CS/', width: 4 },
      config: { defaultPartyLedgerId: t.ids.ledgers.CASH, printTitle: 'Cash Memo', invoiceMode: 'item' },
    });
    assert.equal(vt.baseType, 'sales');
    assert.equal(vt.parentName, 'Sales');
    assert.equal(vt.isPredefined, false);
    assert.equal(vt.hotkey, null);
    assert.equal(vt.abbreviation, 'Cash Sales');
    assert.deepEqual(vt.config, { defaultLedgerId: t.ids.ledgers.SALES, defaultPartyLedgerId: t.ids.ledgers.CASH, printTitle: 'Cash Memo', invoiceMode: 'item' });
    assert.deepEqual(vt.numbering, { method: 'automatic', prefix: 'CS/', suffix: null, start: 1, width: 4, restart: 'yearly' });
    assert.deepEqual(vt.numberingWarnings, []);
    const audit = lastAudit(t, 'voucher_type');
    assert.equal(audit?.action, 'create');
    assert.equal(JSON.parse(audit?.after_json ?? '{}').name, 'Cash Sales');
    // By base type instead of parent.
    const exp = saveVoucherType(t.ctx, { name: 'Sales - Export', baseType: 'sales', numbering: { prefix: 'EXP/' } });
    assert.equal(exp.parentId, t.ids.voucherTypes.sales);
    // A type based on a custom type.
    const b2b = saveVoucherType(t.ctx, { name: 'Tax Invoice (B2B)', parentId: exp.id });
    assert.equal(b2b.baseType, 'sales');
    assert.equal(b2b.parentName, 'Sales - Export');
    expectIssue(() => saveVoucherType(t.ctx, { name: 'cash sales', baseType: 'sales' }), 'name', /already exists/);
    expectIssue(() => saveVoucherType(t.ctx, { name: 'Orphan' }), 'parentId', /Choose the voucher type this one is based on/);
    expectIssue(() => saveVoucherType(t.ctx, { name: 'Mixed', parentId: t.ids.voucherTypes.sales, baseType: 'purchase' }), 'baseType', /follows the parent type 'Sales'/);
    t.close();
  });
});

describe('voucher types: numbering rules', () => {
  it('GST documents: at most 16 characters and only A–Z a–z 0–9 / -', () => {
    const t = createTestCompany();
    expectIssue(
      () => saveVoucherType(t.ctx, { name: 'Tax Invoice (B2B)', baseType: 'sales', numbering: { prefix: 'INV/2026-27/B2B/', width: 4 } }),
      'numbering.prefix',
      /would be 20 characters long .*at most 16 characters/,
    );
    expectIssue(() => saveVoucherType(t.ctx, { name: 'CN Series', baseType: 'credit_note', numbering: { prefix: 'CN#' } }), 'numbering.prefix', /contains '#'/);
    expectIssue(() => saveVoucherType(t.ctx, { name: 'DN Series', baseType: 'debit_note', numbering: { suffix: '/26 27' } }), 'numbering.suffix', /contains a space/);
    expectIssue(() => saveVoucherType(t.ctx, { name: 'No Numbers', baseType: 'sales', numbering: { method: 'none' } }), 'numbering.method', /must carry a serial number/);
    // Fits exactly: 12 + 4 = 16, with a headroom warning.
    const ok = saveVoucherType(t.ctx, { name: 'Sales B2B', baseType: 'sales', numbering: { prefix: 'INV/2026-27/', width: 4 } });
    assert.match(ok.numberingWarnings.join(' '), /longer than 16 characters after no\. 9,999/);
    // A monthly restart with a fixed prefix repeats numbers within the financial year → refused for GST documents.
    expectIssue(() => saveVoucherType(t.ctx, { id: ok.id, numbering: { restart: 'monthly' } }), 'numbering.restart', /unique for the whole financial year/);
    assert.equal(saveVoucherType(t.ctx, { id: ok.id, numbering: { restart: 'never' } }).numbering.restart, 'never');
    // Manual numbering may restart monthly (the user types the numbers); it only gets the uniqueness advice.
    const manual = saveVoucherType(t.ctx, { name: 'Manual Bills', baseType: 'sales', numbering: { method: 'manual', restart: 'monthly' } });
    assert.match(manual.numberingWarnings.join(' '), /unique within the financial year/);
    t.close();
  });

  it('other voucher types only warn, and so do GST types of a company without GST', () => {
    const t = createTestCompany();
    const pay = saveVoucherType(t.ctx, { name: 'Bank Payment', baseType: 'payment', numbering: { prefix: 'BANK PAYMENT #', width: 6 } });
    assert.equal(pay.numbering.prefix, 'BANK PAYMENT #');
    assert.equal(pay.numberingWarnings.length, 2);
    t.close();
    const u = createTestCompany({ gst: false });
    const s = saveVoucherType(u.ctx, { name: 'Bill', baseType: 'sales', numbering: { prefix: 'BILL#' } });
    assert.match(s.numberingWarnings[0], /contains '#'/);
    u.close();
    // Pure check
    assert.deepEqual(checkNumbering('sales', { method: 'automatic', prefix: 'S/', suffix: null, start: 1, width: 5, restart: 'yearly' }, true), { errors: [], warnings: [] });
  });

  it('validates start number and zero padding', () => {
    const t = createTestCompany();
    expectIssue(() => saveVoucherType(t.ctx, { id: t.ids.voucherTypes.journal, numbering: { start: 0 } }), 'numbering.start', /1 or more/);
    expectIssue(() => saveVoucherType(t.ctx, { id: t.ids.voucherTypes.journal, numbering: { width: 12 } }), 'numbering.width', /between 0 and 9/);
    t.close();
  });

  it('changing numbering never renumbers existing vouchers', () => {
    const t = createTestCompany();
    const vt = saveVoucherType(t.ctx, { name: 'Counter Sales', baseType: 'sales', numbering: { prefix: 'CS/' } });
    const vid = postRaw(t, { date: '2026-04-02', baseType: 'sales', voucherTypeId: vt.id, number: 'CS/1', lines: [[t.ids.ledgers.CASH, 100], [t.ids.ledgers.SALES, -100]] });
    const changed = saveVoucherType(t.ctx, { id: vt.id, numbering: { prefix: 'CTR/', width: 5, start: 100 } });
    assert.equal(changed.numbering.prefix, 'CTR/');
    assert.equal(changed.voucherCount, 1);
    assert.equal(t.db.value('SELECT number FROM vouchers WHERE id = :id', { id: vid }), 'CS/1');
    t.close();
  });
});

describe('voucher types: predefined protection, config, delete', () => {
  it('predefined types allow numbering/config changes but not name, base type or deactivation', () => {
    const t = createTestCompany();
    const id = t.ids.voucherTypes.sales;
    expectIssue(() => saveVoucherType(t.ctx, { id, name: 'Invoice' }), 'name', /predefined voucher type and cannot be renamed/);
    expectIssue(() => saveVoucherType(t.ctx, { id, baseType: 'purchase' }), 'baseType', /base type cannot be changed/);
    expectIssue(() => saveVoucherType(t.ctx, { id, parentId: t.ids.voucherTypes.purchase }), 'parentId', /cannot be changed/);
    expectIssue(() => saveVoucherType(t.ctx, { id, isActive: false }), 'isActive', /cannot be deactivated/);
    const s = saveVoucherType(t.ctx, {
      id,
      name: 'Sales',
      abbreviation: 'Sl',
      numbering: { prefix: 'SI/', width: 5 },
      printAfterSave: true,
      config: { printTitle: 'Tax Invoice', declaration: 'Goods once sold will not be taken back.' },
    });
    assert.equal(s.numbering.prefix, 'SI/');
    assert.equal(s.printAfterSave, true);
    assert.equal(s.config.printTitle, 'Tax Invoice');
    assert.equal(s.config.defaultLedgerId, t.ids.ledgers.SALES, 'other config keys are kept');
    const cleared = saveVoucherType(t.ctx, { id, config: { printTitle: null } });
    assert.equal(cleared.config.printTitle, undefined);
    t.close();
  });

  it('validates the config ledgers against the base type and keeps unknown keys', () => {
    const t = createTestCompany();
    const sales = t.ids.voucherTypes.sales;
    expectIssue(() => saveVoucherType(t.ctx, { id: sales, config: { defaultLedgerId: t.ids.ledgers.PURCHASE } }), 'config.defaultLedgerId', /under Sales Accounts/);
    expectIssue(() => saveVoucherType(t.ctx, { id: t.ids.voucherTypes.purchase, config: { defaultLedgerId: t.ids.ledgers.SALES } }), 'config.defaultLedgerId', /under Purchase Accounts/);
    expectIssue(() => saveVoucherType(t.ctx, { id: t.ids.voucherTypes.payment, config: { defaultLedgerId: t.ids.ledgers.SALES } }), 'config.defaultLedgerId', /only to sales and purchase/);
    expectIssue(() => saveVoucherType(t.ctx, { id: sales, config: { defaultPartyLedgerId: t.ids.ledgers.SALES } }), 'config.defaultPartyLedgerId', /Sundry Debtors or Creditors\) or a cash or bank ledger/);
    expectIssue(() => saveVoucherType(t.ctx, { id: sales, config: { bankLedgerId: t.ids.ledgers.CASH } }), 'config.bankLedgerId', /under Bank Accounts or Bank OD/);
    expectIssue(() => saveVoucherType(t.ctx, { id: t.ids.voucherTypes.payment, config: { invoiceMode: 'item' } }), 'config.invoiceMode', /only to sales, purchase/);
    expectIssue(() => saveVoucherType(t.ctx, { id: sales, config: { defaultGodownId: 99_999 } }), 'config.defaultGodownId', /does not exist/);
    const old = saveLedger(t.ctx, { name: 'Old Customer', groupId: t.ids.groups.SUNDRY_DEBTORS, isActive: false });
    expectIssue(() => saveVoucherType(t.ctx, { id: sales, config: { defaultPartyLedgerId: old.id } }), 'config.defaultPartyLedgerId', /is inactive/);
    const bank = saveLedger(t.ctx, { name: 'HDFC Bank', groupId: t.ids.groups.BANK_ACCOUNTS });
    t.db.run('UPDATE voucher_types SET config = :c WHERE id = :id', { c: JSON.stringify({ defaultLedgerId: t.ids.ledgers.SALES, printCopies: 2 }), id: sales });
    const ok = saveVoucherType(t.ctx, { id: sales, config: { bankLedgerId: bank.id, defaultGodownId: t.ids.mainGodownId } });
    assert.deepEqual(ok.config, { defaultLedgerId: t.ids.ledgers.SALES, printCopies: 2, bankLedgerId: bank.id, defaultGodownId: t.ids.mainGodownId });
    t.close();
  });

  it('a custom type can move to another base type only while no vouchers use it; no cycles', () => {
    const t = createTestCompany();
    const a = saveVoucherType(t.ctx, { name: 'Counter Sales', baseType: 'sales' });
    const b = saveVoucherType(t.ctx, { name: 'Counter Sales - Card', parentId: a.id });
    expectIssue(() => saveVoucherType(t.ctx, { id: a.id, parentId: b.id }), 'parentId', /cannot be based on itself/);
    const moved = saveVoucherType(t.ctx, { id: a.id, parentId: t.ids.voucherTypes.purchase });
    assert.equal(moved.baseType, 'purchase');
    assert.equal(moved.config.defaultLedgerId, undefined, 'the sales default ledger is dropped');
    assert.equal(getVoucherType(t.db, b.id).baseType, 'purchase', 'types based on it follow');
    postRaw(t, { date: '2026-04-02', baseType: 'purchase', voucherTypeId: b.id, lines: [[t.ids.ledgers.PURCHASE, 100], [t.ids.ledgers.CASH, -100]] });
    expectIssue(() => saveVoucherType(t.ctx, { id: a.id, parentId: t.ids.voucherTypes.sales }), 'parentId', /1 voucher already use it/);
    t.close();
  });

  it('deletes only unused custom types without children, and audits it', () => {
    const t = createTestCompany();
    assert.throws(() => deleteVoucherType(t.ctx, t.ids.voucherTypes.sales), isErr('BUSINESS_RULE', /predefined voucher type/));
    const used = saveVoucherType(t.ctx, { name: 'Cash Sales', baseType: 'sales' });
    postRaw(t, { date: '2026-04-02', baseType: 'sales', voucherTypeId: used.id, lines: [[t.ids.ledgers.CASH, 100], [t.ids.ledgers.SALES, -100]] });
    assert.throws(() => deleteVoucherType(t.ctx, used.id), isErr('BUSINESS_RULE', /1 voucher uses it\. Deactivate it instead/));
    const parent = saveVoucherType(t.ctx, { name: 'Export', baseType: 'sales' });
    const child = saveVoucherType(t.ctx, { name: 'Export - LUT', parentId: parent.id });
    assert.throws(() => deleteVoucherType(t.ctx, parent.id), isErr('BUSINESS_RULE', /types based on it \('Export - LUT'\)/));
    t.db.run(`INSERT INTO voucher_counters (voucher_type_id, period_key, last_number) VALUES (:id, '2026-27', 5)`, { id: child.id });
    assert.deepEqual(deleteVoucherType(t.ctx, child.id), { id: child.id, deleted: true });
    assert.equal(t.db.value('SELECT COUNT(*) FROM voucher_counters WHERE voucher_type_id = :id', { id: child.id }), 0);
    assert.equal(lastAudit(t, 'voucher_type')?.action, 'delete');
    const deactivated = saveVoucherType(t.ctx, { id: used.id, isActive: false });
    assert.equal(deactivated.isActive, false);
    assert.equal(listVoucherTypes(t.db, { activeOnly: true }).rows.some((r) => r.id === used.id), false);
    t.close();
  });
});
