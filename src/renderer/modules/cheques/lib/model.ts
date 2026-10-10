/**
 * Pure presentation rules of the cheques screens (tested in model.test.ts): labels, the payee form's
 * field checks, layout form numbers, and the export tables of the register and the e-payment list.
 */
import type {
  ChequeLayoutSpec,
  ChequeLeafStatus,
  ChequeRegisterResult,
  EPaymentCandidate,
  PayeeAccountType,
  PayeeBankDetails,
  PayeePaymentMode,
} from '../../../../shared/types/cheques.ts';
import { formatMoney } from '../../../../shared/format.ts';
import { normalizeIfsc, validateBankAccountNo, validateIfsc } from '../../../../shared/validators.ts';
import type { TableExportDef } from '../../../app/export.ts';

export const CHEQUES_OFF = 'Turn on “Cheque printing” in Features (F11) to keep cheque books, print cheques and see the cheque register.';

/** Mutations of this module change vouchers (numbers), the register and BRS. */
export const CHEQUE_INVALIDATES = ['cheques', 'vouchers', 'banking'];

export const STATUS_LABELS: Readonly<Record<ChequeLeafStatus, string>> = {
  unused: 'Unused',
  issued: 'Issued',
  cleared: 'Cleared',
  stale: 'Stale',
  cancelled: 'Cancelled',
};

export const STATUS_TONES: Readonly<Record<ChequeLeafStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  unused: 'neutral',
  issued: 'info',
  cleared: 'success',
  stale: 'warning',
  cancelled: 'danger',
};

export const ACCOUNT_TYPE_LABELS: Readonly<Record<PayeeAccountType, string>> = {
  savings: 'Savings',
  current: 'Current',
  cash_credit: 'Cash credit',
  overdraft: 'Overdraft',
  nre: 'NRE',
  nro: 'NRO',
  other: 'Other',
};

export const PAYMENT_MODE_LABELS: Readonly<Record<PayeePaymentMode, string>> = { neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', cheque: 'Cheque' };

// ───────────────────────────── Payee form ─────────────────────────────

export interface PayeeDraft {
  beneficiaryName: string;
  accountNo: string;
  confirmAccountNo: string;
  ifsc: string;
  bankName: string;
  branch: string;
  accountType: PayeeAccountType | '';
  chequeName: string;
  paymentMode: PayeePaymentMode | '';
}

export function payeeDraft(p: PayeeBankDetails | null): PayeeDraft {
  return {
    beneficiaryName: p?.beneficiaryName ?? '',
    accountNo: p?.accountNo ?? '',
    confirmAccountNo: p?.accountNo ?? '',
    ifsc: p?.ifsc ?? '',
    bankName: p?.bankName ?? '',
    branch: p?.branch ?? '',
    accountType: p?.accountType ?? '',
    chequeName: p?.chequeName ?? '',
    paymentMode: p?.paymentMode ?? '',
  };
}

const compact = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();

/**
 * Field errors before saving. The account number is typed twice (a wrong digit sends money to someone
 * else); IFSC is 4 letters, '0', 6 letters / digits; both or neither.
 */
export function payeeErrors(d: PayeeDraft): Partial<Record<keyof PayeeDraft, string>> {
  const e: Partial<Record<keyof PayeeDraft, string>> = {};
  const acc = compact(d.accountNo);
  if (acc) {
    const err = validateBankAccountNo(acc);
    if (err) e.accountNo = `${err}.`;
    else if (compact(d.confirmAccountNo) !== acc) e.confirmAccountNo = 'The account numbers do not match: type it again.';
  }
  if (d.ifsc.trim()) {
    const err = validateIfsc(d.ifsc);
    if (err) e.ifsc = `${err}.`;
  }
  if (acc && !d.ifsc.trim()) e.ifsc = 'Enter the IFSC of the account (bank transfers need both).';
  if (!acc && d.ifsc.trim()) e.accountNo = 'Enter the account number (bank transfers need both).';
  if (d.chequeName.trim().length > 80) e.chequeName = 'The name on the cheque must fit the payee line: 80 characters at most.';
  return e;
}

/** Bank code of an IFSC ('HDFC0001234' → 'HDFC') for the bank-name hint. */
export function ifscBank(ifsc: string): string | null {
  const i = normalizeIfsc(ifsc);
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(i) ? i.slice(0, 4) : null;
}

export function payeeInput(ledgerId: number, d: PayeeDraft) {
  const t = (s: string): string | null => s.trim() || null;
  return {
    ledgerId,
    beneficiaryName: t(d.beneficiaryName),
    accountNo: t(compact(d.accountNo)),
    ifsc: t(d.ifsc.toUpperCase()),
    bankName: t(d.bankName),
    branch: t(d.branch),
    accountType: d.accountType || null,
    chequeName: t(d.chequeName),
    paymentMode: d.paymentMode || null,
  };
}

// ───────────────────────────── Layout form ─────────────────────────────

/** Editable numbers of a layout, as rows of the position table. */
export const LAYOUT_FIELDS: ReadonlyArray<{ key: 'date' | 'payee' | 'words' | 'words2' | 'figures' | 'acPayee' | 'signatory'; label: string; width: boolean }> = [
  { key: 'date', label: 'Date (first box)', width: false },
  { key: 'payee', label: 'Payee line', width: true },
  { key: 'words', label: 'Amount in words, line 1', width: true },
  { key: 'words2', label: 'Amount in words, line 2', width: true },
  { key: 'figures', label: 'Amount in figures', width: true },
  { key: 'acPayee', label: "'A/c Payee' crossing", width: true },
  { key: 'signatory', label: 'For company / signatory', width: true },
];

export type LayoutPointKey = (typeof LAYOUT_FIELDS)[number]['key'];

/** Set x / y / w of one point (other values unchanged). */
export function withPoint(spec: ChequeLayoutSpec, key: LayoutPointKey, part: 'x' | 'y' | 'w', value: number): ChequeLayoutSpec {
  return { ...spec, [key]: { ...spec[key], [part]: value } };
}

/** Sample cheque for the layout preview. */
export const SAMPLE_CHEQUE = {
  dateDigits: '15042026',
  payee: 'Supreme Suppliers Private Limited',
  amountWords: 'One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only',
  amountFigures: '**1,23,456.78/-',
  acPayee: true,
  companyName: 'Your Company',
  signatory: 'Authorised Signatory',
} as const;

// ───────────────────────────── Exports ─────────────────────────────

export function registerExport(r: ChequeRegisterResult): Omit<TableExportDef, 'company'> {
  return {
    title: 'Cheque Register',
    subtitle: `${r.bankLedgerName} · as on ${r.asOf}`,
    columns: [
      { header: 'Cheque No.' },
      { header: 'Status' },
      { header: 'Cheque date', kind: 'date' },
      { header: 'Payee' },
      { header: 'Amount', kind: 'amount' },
      { header: 'Voucher' },
      { header: 'Cleared on', kind: 'date' },
      { header: 'Book' },
      { header: 'Remarks' },
    ],
    rows: r.rows.map((x) => [x.chequeNo, STATUS_LABELS[x.status] + (x.postDated ? ' (post-dated)' : ''), x.chequeDate, x.payee ?? '', x.amount, x.voucherLabel ?? '', x.bankDate, x.bookName ?? 'Outside the books', x.reason ?? '']),
    totals: ['', `${r.totals.leaves} leaves`, null, '', r.totals.issuedAmount, '', null, '', `Uncleared ${formatMoney(r.totals.unclearedAmount)}`],
  };
}

export function epaymentExport(rows: readonly EPaymentCandidate[], period: { from: string; to: string }): Omit<TableExportDef, 'company'> {
  return {
    title: 'E-payments',
    subtitle: 'Payments by bank transfer',
    period,
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher' },
      { header: 'Payee' },
      { header: 'Beneficiary' },
      { header: 'A/c No.' },
      { header: 'IFSC' },
      { header: 'Mode' },
      { header: 'Amount', kind: 'amount' },
      { header: 'Status' },
    ],
    rows: rows.map((r) => [r.date, r.voucherLabel, r.payeeName ?? '', r.beneficiaryName ?? '', r.accountNo ?? '', r.ifsc ?? '', r.mode.toUpperCase(), r.amount, r.problem ?? (r.exportedAt ? `In a payment file (${r.exportedAt.slice(0, 10)})` : 'Ready')]),
    totals: [null, '', '', '', '', '', 'Total', rows.reduce((a, r) => a + r.amount, 0), ''],
  };
}

/** Ready to go into a payment file. */
export function readyPayments(rows: readonly EPaymentCandidate[]): EPaymentCandidate[] {
  return rows.filter((r) => r.problem === null);
}
