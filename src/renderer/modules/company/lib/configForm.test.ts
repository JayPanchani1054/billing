import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_CONFIG } from '../../../../shared/settings.ts';
import type { CompanyConfig } from '../../../../shared/settings.ts';
import { configDirty, configEdited, configFormKey, configSaveInput, configTabOf, invoiceSummary, tabOfErrorPath } from './configForm.ts';

const cfg = (over: Partial<CompanyConfig> = {}): CompanyConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...over });

describe('F12 configuration form', () => {
  test("opens the tab named in params (Backup › Backup settings → 'backup'); anything else → Invoices", () => {
    assert.equal(configTabOf('backup'), 'backup');
    assert.equal(configTabOf('guards'), 'guards');
    assert.equal(configTabOf(undefined), 'invoice');
    assert.equal(configTabOf('printing'), 'invoice');
    assert.equal(configTabOf(3), 'invoice');
  });

  test('server errors switch to the tab of the field', () => {
    assert.equal(tabOfErrorPath('backup.folder'), 'backup');
    assert.equal(tabOfErrorPath('gst.lutValidTo'), 'gst');
    assert.equal(tabOfErrorPath('roundOff.unit'), 'invoice');
    assert.equal(tabOfErrorPath('nonsense'), 'invoice');
  });

  test('F12 saves only its own sections — never invoice printing or the period lock (single editor)', () => {
    const c = cfg({ lockedUpTo: '2026-03-31' });
    const input = configSaveInput(configEdited(c));
    assert.deepEqual(Object.keys(input).sort(), ['backup', 'display', 'gst', 'guards', 'roundOff']);
    assert.equal('invoice' in input, false);
    assert.equal('lockedUpTo' in input, false);
  });

  test('a print-settings save does not remount F12 (its key and dirty state ignore config.invoice)', () => {
    const before = cfg();
    const afterPrint = cfg({ invoice: { ...before.invoice, template: 'classic', upiId: 'shop@okhdfcbank' } });
    assert.equal(configFormKey(afterPrint), configFormKey(before));
    const draft = configEdited(before);
    assert.equal(configDirty(draft, afterPrint), false);
    assert.equal(configDirty({ ...draft, backup: { ...draft.backup, keepLast: 9 } }, afterPrint), true);
    assert.notEqual(configFormKey(cfg({ backup: { ...before.backup, keepLast: 9 } })), configFormKey(before));
  });
});

describe('F12 › Invoices: invoice printing summary', () => {
  const banks = [
    { ledgerId: 7, ledgerName: 'HDFC Bank', accountNo: '50100012345678', upiId: 'shop@okhdfcbank' },
    { ledgerId: 9, ledgerName: 'SBI Current', accountNo: null, upiId: null },
  ];
  const value = (rows: ReturnType<typeof invoiceSummary>, key: string) => rows.find((r) => r.key === key)?.value;

  test('defaults read plainly', () => {
    const rows = invoiceSummary(DEFAULT_CONFIG.invoice, banks);
    assert.deepEqual(
      rows.map((r) => r.label),
      ['Template', 'Copies', 'After saving an invoice', 'Bank account details', 'UPI QR code', 'Declaration', 'Terms & conditions'],
    );
    assert.equal(value(rows, 'template'), 'Modern');
  });

  test('bank shown by name and account number (never "Ledger #id"), with the stale and loading cases', () => {
    const inv = { ...DEFAULT_CONFIG.invoice, showBankDetails: true, bankLedgerId: 7 };
    assert.equal(value(invoiceSummary(inv, banks), 'bank'), 'HDFC Bank · A/c 50100012345678');
    assert.equal(value(invoiceSummary({ ...inv, bankLedgerId: 9 }, banks), 'bank'), 'SBI Current (no account number yet)');
    assert.match(value(invoiceSummary({ ...inv, bankLedgerId: 42 }, banks), 'bank') ?? '', /no longer an active bank account/);
    assert.equal(value(invoiceSummary(inv, undefined), 'bank'), 'On');
    assert.equal(value(invoiceSummary({ ...inv, bankLedgerId: null }, banks), 'bank'), 'On, but no bank account chosen');
    assert.equal(value(invoiceSummary({ ...inv, showBankDetails: false }, banks), 'bank'), 'Not printed');
  });

  test('UPI: own ID, else the bank ledger’s, else flagged; template and copies in print wording', () => {
    const inv = { ...DEFAULT_CONFIG.invoice, showUpiQr: true, upiId: '', bankLedgerId: 7, template: 'compact' as const, copies: ['triplicate', 'original'] as Array<'original' | 'duplicate' | 'triplicate'> };
    const rows = invoiceSummary(inv, banks);
    assert.equal(value(rows, 'upi'), 'shop@okhdfcbank (from the bank ledger)');
    assert.equal(value(rows, 'template'), 'Compact 80 mm');
    assert.equal(value(rows, 'copies'), 'Original, Triplicate');
    assert.equal(value(invoiceSummary({ ...inv, upiId: ' me@okaxis ' }, banks), 'upi'), 'me@okaxis');
    assert.equal(value(invoiceSummary({ ...inv, bankLedgerId: 9 }, banks), 'upi'), 'On, but no UPI ID');
    assert.equal(value(invoiceSummary({ ...inv, showUpiQr: false }, banks), 'upi'), 'Off');
  });
});
