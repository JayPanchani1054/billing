/**
 * Pure presentation rules of the cheques screens (tested in model.test.ts): labels, the payee form's
 * field checks, layout form numbers, and the export tables of the register and the e-payment list.
 */
import type {
  ChequeBook,
  ChequeLayoutSpec,
  ChequeLeafStatus,
  ChequeRegisterResult,
  ChequeRegisterRow,
  EPaymentCandidate,
  PayeeAccountType,
  PayeeBankDetails,
  PayeePaymentMode,
} from '../../../../shared/types/cheques.ts';
import { localDateOf } from '../../../../shared/dates.ts';
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
    rows: rows.map((r) => [r.date, r.voucherLabel, r.payeeName ?? '', r.beneficiaryName ?? '', r.accountNo ?? '', r.ifsc ?? '', r.mode.toUpperCase(), r.amount, r.problem ?? (r.exportedAt ? `In a payment file (${localDateOf(r.exportedAt)})` : 'Ready')]),
    totals: [null, '', '', '', '', '', 'Total', rows.reduce((a, r) => a + r.amount, 0), ''],
  };
}

/** Ready to go into a payment file. */
export function readyPayments(rows: readonly EPaymentCandidate[]): EPaymentCandidate[] {
  return rows.filter((r) => r.problem === null);
}

// ───────────────────────────── Cheque books ─────────────────────────────

export interface BookDraft {
  name: string;
  fromNo: number | null;
  toNo: number | null;
  digits: number | null;
  isActive: boolean;
}

export function bookDraft(b: ChequeBook | null): BookDraft {
  return { name: b?.name ?? '', fromNo: b?.fromNo ?? null, toNo: b?.toNo ?? null, digits: b?.digits ?? 6, isActive: b?.isActive ?? true };
}

/** Cheque number as printed: zero-padded to the book's digits ('501', 6 → '000501'). */
export function padNo(n: number, digits: number): string {
  return String(n).padStart(Math.max(1, digits), '0');
}

/** Leaves in the book (null until both numbers are typed and in order). */
export function bookLeaves(d: Pick<BookDraft, 'fromNo' | 'toNo'>): number | null {
  if (d.fromNo === null || d.toNo === null || d.toNo < d.fromNo) return null;
  return d.toNo - d.fromNo + 1;
}

/** The core's checks (books.ts › saveBook), before a round trip; overlaps are the core's alone. */
export function bookErrors(d: BookDraft): Partial<Record<keyof BookDraft, string>> {
  const e: Partial<Record<keyof BookDraft, string>> = {};
  const digits = d.digits ?? 6;
  if (d.fromNo === null || !Number.isInteger(d.fromNo) || d.fromNo < 0) e.fromNo = 'Enter the first cheque number of the book.';
  if (d.toNo === null || !Number.isInteger(d.toNo)) e.toNo = 'Enter the last cheque number of the book.';
  else if (d.fromNo !== null && d.toNo < d.fromNo) e.toNo = 'The last cheque number must be the same as or after the first.';
  else if (d.fromNo !== null && d.toNo - d.fromNo >= 10_000) e.toNo = 'A cheque book can have at most 10,000 leaves.';
  if (!Number.isInteger(digits) || digits < 1 || digits > 12) e.digits = 'Cheque numbers have 1 to 12 digits (6 on CTS-2010 cheques).';
  else if (d.toNo !== null && !e.toNo && d.toNo >= 10 ** digits) e.toNo = `Cheque ${d.toNo} has more than ${digits} digits.`;
  if (d.name.trim().length > 100) e.name = 'Keep the name under 100 characters.';
  return e;
}

export function bookInput(bankLedgerId: number, d: BookDraft, id?: number) {
  return {
    ...(id !== undefined ? { id } : {}),
    bankLedgerId,
    ...(d.name.trim() ? { name: d.name.trim() } : {}),
    fromNo: d.fromNo ?? 0,
    toNo: d.toNo ?? 0,
    digits: d.digits ?? 6,
    isActive: d.isActive,
  };
}

/** Status line of a book in the list. */
export function bookStatus(b: Pick<ChequeBook, 'isActive' | 'unused' | 'nextNo'>): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' } {
  if (!b.isActive) return { label: 'Inactive', tone: 'neutral' };
  if (b.nextNo === null || b.unused === 0) return { label: 'Used up', tone: 'warning' };
  return { label: `Next ${b.nextNo}`, tone: 'success' };
}

// ───────────────────────────── Register views ─────────────────────────────

export type RegisterView = ChequeLeafStatus | 'all';

/** Ctrl+1 … Ctrl+6 on the register, in this order. */
export const REGISTER_VIEWS: ReadonlyArray<{ value: RegisterView; label: string }> = [
  { value: 'all', label: 'All leaves' },
  { value: 'issued', label: 'Issued' },
  { value: 'stale', label: 'Stale' },
  { value: 'unused', label: 'Unused' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'cleared', label: 'Cleared' },
];

/** What Alt+X / Alt+U may do with a register row. */
export function leafActions(r: Pick<ChequeRegisterRow, 'status' | 'voucherId' | 'printedAt' | 'reason'> | null): { cancel: boolean; restore: boolean } {
  if (!r) return { cancel: false, restore: false };
  return {
    cancel: r.status === 'unused',
    // A leaf cancelled by the user (no voucher on it) can be re-opened; one spoilt by a print or
    // cancelled with its voucher cannot.
    restore: r.status === 'cancelled' && r.voucherId === null && r.printedAt === null,
  };
}

// ───────────────────────────── Layout form ─────────────────────────────

/** Field error of a position cell from the core's issues ('spec.payee.y' …); a point-level one shows on x. */
export function pointError(errors: Readonly<Record<string, string>>, key: LayoutPointKey, part: 'x' | 'y' | 'w' | 'pitch'): string | undefined {
  return errors[`spec.${key}.${part}`] ?? (part === 'x' ? errors[`spec.${key}`] : undefined);
}

/** Layout name suggested for a preset / bank ('HDFC Bank - CTS-2010 standard leaf'). */
export function suggestedLayoutName(presetName: string, bankName?: string | null): string {
  return (bankName ? `${bankName} - ${presetName}` : presetName).slice(0, 80);
}

export const PLACEMENT_LABELS: Readonly<Record<ChequeLayoutSpec['placement'], string>> = {
  leaf: 'Leaf on its own (cheque printer / custom paper)',
  a4_left: 'On an A4 sheet, top-left',
  a4_center: 'On an A4 sheet, top-centre',
};

// ───────────────────────────── E-payments ─────────────────────────────

/** Selected rows that can go into a file (problem rows are never sent), in list order. */
export function epaymentChosen(rows: readonly EPaymentCandidate[], selected: ReadonlySet<number>): EPaymentCandidate[] {
  return rows.filter((r) => r.problem === null && selected.has(r.voucherId));
}

/** Tick all ready rows, or untick everything when all ready rows are ticked. */
export function toggleAllReady(rows: readonly EPaymentCandidate[], selected: ReadonlySet<number>): Set<number> {
  const ready = readyPayments(rows).map((r) => r.voucherId);
  const allOn = ready.length > 0 && ready.every((id) => selected.has(id));
  return allOn ? new Set() : new Set(ready);
}

/** Rows already put in an earlier payment file among the chosen ones (to warn before paying twice). */
export function alreadyExported(rows: readonly EPaymentCandidate[]): EPaymentCandidate[] {
  return rows.filter((r) => r.exportedAt !== null);
}

/**
 * Make the bulk payment file and save it: the core records the batch (re-export warning) when it builds
 * the file, so when the save dialog is cancelled or the write fails, the batch is discarded again —
 * otherwise those payments would be flagged "already in a payment file" although no file exists.
 * Returns the file and where it was saved (null: not saved). A failed save is re-thrown after the discard.
 */
export async function makeAndSavePaymentFile<F extends { batchId: number }>(deps: {
  make: () => Promise<F>;
  save: (file: F) => Promise<{ path: string } | null>;
  discard: (batchId: number) => Promise<unknown>;
}): Promise<{ file: F; saved: { path: string } | null }> {
  const file = await deps.make();
  let saved: { path: string } | null = null;
  try {
    saved = await deps.save(file);
  } finally {
    if (!saved) await deps.discard(file.batchId).catch(() => undefined);
  }
  return { file, saved };
}
