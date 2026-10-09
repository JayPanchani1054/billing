/**
 * F12 Configuration — pure helpers (tested in configForm.test.ts).
 *
 * F12 edits round-off, GST, checks, display and backup. Invoice printing (config.invoice) has ONE
 * editor, Invoice Printing ('print.settings', live preview); the Invoices tab shows a summary of it
 * and opens that screen. So F12 never sends `invoice` (nor `lockedUpTo`, set by the period lock):
 * saving F12 cannot overwrite a print-settings change made while F12 was open further down the stack.
 */
import type { CompanyConfig, InvoiceTemplate } from '../../../../shared/settings.ts';
import type { CompanyConfigInput } from '../../../../shared/types/company.ts';

export type ConfigTabId = 'invoice' | 'gst' | 'guards' | 'display' | 'backup';

export const CONFIG_TABS: readonly ConfigTabId[] = ['invoice', 'gst', 'guards', 'display', 'backup'];

/** Params of 'company.config': `{ tab?: ConfigTabId }` (e.g. Backup › Backup settings opens 'backup'). */
export interface ConfigScreenParams {
  tab?: ConfigTabId;
}

/** The tab to open first: `params.tab` when it names a tab, else Invoices. */
export function configTabOf(tab: unknown): ConfigTabId {
  return typeof tab === 'string' && (CONFIG_TABS as readonly string[]).includes(tab) ? (tab as ConfigTabId) : 'invoice';
}

/** The sections F12 edits. */
export type ConfigEdited = Pick<CompanyConfig, 'roundOff' | 'gst' | 'guards' | 'display' | 'backup'>;

export function configEdited(c: CompanyConfig | ConfigEdited): ConfigEdited {
  return { roundOff: c.roundOff, gst: c.gst, guards: c.guards, display: c.display, backup: c.backup };
}

/** What F12 saves: only its own sections (never `invoice` / `lockedUpTo`). */
export function configSaveInput(c: ConfigEdited): CompanyConfigInput {
  return configEdited(c);
}

/**
 * Identity of F12's saved values: the form remounts (drops its draft) only when one of ITS sections
 * changed on the server, not when invoice printing or the period lock did.
 */
export function configFormKey(c: CompanyConfig): string {
  return JSON.stringify(configEdited(c));
}

export function configDirty(draft: ConfigEdited, saved: CompanyConfig): boolean {
  return JSON.stringify(configEdited(draft)) !== JSON.stringify(configEdited(saved));
}

/** First tab with an error for a server field path ('backup.folder' → 'backup'; 'roundOff.*' → 'invoice'). */
export function tabOfErrorPath(path: string): ConfigTabId {
  const head = path.split('.')[0];
  if (head === 'roundOff' || head === 'invoice') return 'invoice';
  return configTabOf(head);
}

// ───────────────────────────── Invoice printing summary ─────────────────────────────

export const TEMPLATE_LABELS: Readonly<Record<InvoiceTemplate, string>> = {
  modern: 'Modern',
  classic: 'Classic',
  compact: 'Compact 80 mm',
};

const COPY_LABELS = { original: 'Original', duplicate: 'Duplicate', triplicate: 'Triplicate' } as const;

/** The bank ledger chosen for invoices, as listed by 'print.bankLedgers'. */
export interface SummaryBank {
  ledgerId: number;
  ledgerName: string;
  accountNo: string | null;
  upiId: string | null;
}

export interface SummaryRow {
  key: string;
  label: string;
  value: string;
}

/**
 * Read-only summary of config.invoice for F12 › Invoices, worded as on Invoice Printing.
 * `banks`: the 'print.bankLedgers' list, or undefined while it loads / when it cannot be read.
 */
export function invoiceSummary(inv: CompanyConfig['invoice'], banks: readonly SummaryBank[] | undefined): SummaryRow[] {
  const bank = inv.bankLedgerId === null ? null : (banks?.find((b) => b.ledgerId === inv.bankLedgerId) ?? null);
  let bankText: string;
  if (!inv.showBankDetails) bankText = 'Not printed';
  else if (inv.bankLedgerId === null) bankText = 'On, but no bank account chosen';
  else if (bank) bankText = bank.accountNo ? `${bank.ledgerName} · A/c ${bank.accountNo}` : `${bank.ledgerName} (no account number yet)`;
  else if (banks) bankText = 'The chosen ledger is no longer an active bank account — choose another';
  else bankText = 'On';
  let upiText: string;
  if (!inv.showUpiQr) upiText = 'Off';
  else if (inv.upiId.trim()) upiText = inv.upiId.trim();
  else if (bank?.upiId) upiText = `${bank.upiId} (from the bank ledger)`;
  else upiText = 'On, but no UPI ID';
  const copies = (['original', 'duplicate', 'triplicate'] as const).filter((c) => inv.copies.includes(c)).map((c) => COPY_LABELS[c]);
  return [
    { key: 'template', label: 'Template', value: TEMPLATE_LABELS[inv.template] ?? inv.template },
    { key: 'copies', label: 'Copies', value: copies.length ? copies.join(', ') : 'None chosen' },
    { key: 'afterSave', label: 'After saving an invoice', value: inv.printAfterSave ? 'Print right away' : 'Do not print automatically' },
    { key: 'bank', label: 'Bank account details', value: bankText },
    { key: 'upi', label: 'UPI QR code', value: upiText },
    { key: 'declaration', label: 'Declaration', value: inv.declaration.trim() ? 'Set' : 'None' },
    { key: 'terms', label: 'Terms & conditions', value: inv.terms.trim() ? 'Set' : 'None' },
  ];
}
