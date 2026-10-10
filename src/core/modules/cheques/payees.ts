/**
 * Payee bank details: the beneficiary account of a party / expense ledger (bulk e-payment files) and the
 * name written on cheques. Kept beside the ledger (payee_bank_details), not in the ledger master: the
 * ledger's own bank fields belong to bank ledgers (the company's accounts). A change of account number
 * or IFSC is a classic payment-fraud vector, so every change is in the edit log with before / after.
 */
import type { PayeeBankDetails, PayeeBankSaveInput, PayeeListInput, PayeeListRow } from '../../../shared/types/cheques.ts';
import { normalizeIfsc, validateBankAccountNo, validateIfsc } from '../../../shared/validators.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { ledgerClass } from '../accounts/books.ts';
import { requirePermission } from './common.ts';

interface PayeeRow {
  ledger_id: number;
  beneficiary_name: string | null;
  account_no: string | null;
  ifsc: string | null;
  bank_name: string | null;
  branch: string | null;
  account_type: PayeeBankDetails['accountType'];
  cheque_name: string | null;
  payment_mode: PayeeBankDetails['paymentMode'];
  updated_at: string;
}

const txt = (s: string | null | undefined): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/\s+/g, ' ');
  return t === '' ? null : t;
};

/** Account numbers are stored compact and upper-case (spaces / dashes removed). */
export function compactAccountNo(s: string | null | undefined): string | null {
  const t = txt(s);
  return t ? t.replace(/[\s-]/g, '').toUpperCase() : null;
}

export function getPayee(db: Db, ledgerId: number): PayeeBankDetails {
  const l = db.get<{ id: number; name: string; mailing_name: string | null }>('SELECT id, name, mailing_name FROM ledgers WHERE id = :id', { id: ledgerId });
  if (!l) throw notFound('Ledger', ledgerId);
  const r = db.get<PayeeRow>('SELECT * FROM payee_bank_details WHERE ledger_id = :id', { id: ledgerId });
  const effective = txt(r?.cheque_name) ?? txt(r?.beneficiary_name) ?? txt(l.mailing_name) ?? l.name;
  return {
    ledgerId: l.id,
    ledgerName: l.name,
    beneficiaryName: r?.beneficiary_name ?? null,
    accountNo: r?.account_no ?? null,
    ifsc: r?.ifsc ?? null,
    bankName: r?.bank_name ?? null,
    branch: r?.branch ?? null,
    accountType: r?.account_type ?? null,
    chequeName: r?.cheque_name ?? null,
    paymentMode: r?.payment_mode ?? null,
    effectiveChequeName: effective,
    updatedAt: r?.updated_at ?? null,
  };
}

export function savePayee(ctx: CompanyCtx, input: PayeeBankSaveInput): PayeeBankDetails {
  const { db } = ctx;
  requirePermission(ctx, 'masters.alter', 'change payee bank details');
  const before = getPayee(db, input.ledgerId);
  const cls = ledgerClass(db, input.ledgerId);
  if (cls.isCashOrBank) {
    throw rule(`“${before.ledgerName}” is a cash or bank ledger: its own account details are in the ledger (Alter ledger › Bank details).`);
  }
  const pick = <K extends keyof PayeeBankSaveInput>(k: K, cur: PayeeBankSaveInput[K]): PayeeBankSaveInput[K] => (input[k] === undefined ? cur : input[k]);
  const next = {
    beneficiaryName: txt(pick('beneficiaryName', before.beneficiaryName)),
    accountNo: compactAccountNo(pick('accountNo', before.accountNo)),
    ifsc: txt(pick('ifsc', before.ifsc)) ? normalizeIfsc(pick('ifsc', before.ifsc)) : null,
    bankName: txt(pick('bankName', before.bankName)),
    branch: txt(pick('branch', before.branch)),
    accountType: pick('accountType', before.accountType) ?? null,
    chequeName: txt(pick('chequeName', before.chequeName)),
    paymentMode: pick('paymentMode', before.paymentMode) ?? null,
  };
  const issues: Array<{ path: string; message: string }> = [];
  if (next.accountNo !== null) {
    const e = validateBankAccountNo(next.accountNo);
    if (e) issues.push({ path: 'accountNo', message: e });
  }
  if (next.ifsc !== null) {
    const e = validateIfsc(next.ifsc);
    if (e) issues.push({ path: 'ifsc', message: e });
  }
  if (next.accountNo !== null && next.ifsc === null) issues.push({ path: 'ifsc', message: 'Enter the IFSC of the account (bank transfers need both)' });
  if (next.ifsc !== null && next.accountNo === null) issues.push({ path: 'accountNo', message: 'Enter the account number (bank transfers need both)' });
  if (next.beneficiaryName !== null && next.beneficiaryName.length > 100) issues.push({ path: 'beneficiaryName', message: 'Keep the beneficiary name under 100 characters' });
  if (next.chequeName !== null && next.chequeName.length > 80) issues.push({ path: 'chequeName', message: 'The name on the cheque must fit the payee line: 80 characters at most' });
  for (const k of ['bankName', 'branch'] as const) {
    const v = next[k];
    if (v !== null && v.length > 100) issues.push({ path: k, message: 'Keep it under 100 characters' });
  }
  if (issues.length > 0) throw validation(issues);
  const empty = Object.values(next).every((v) => v === null);
  const now = ctx.clock.now().toISOString();
  if (empty) {
    db.run('DELETE FROM payee_bank_details WHERE ledger_id = :id', { id: input.ledgerId });
  } else {
    db.run(
      `INSERT INTO payee_bank_details (ledger_id, beneficiary_name, account_no, ifsc, bank_name, branch, account_type, cheque_name, payment_mode, updated_at)
       VALUES (:id, :beneficiaryName, :accountNo, :ifsc, :bankName, :branch, :accountType, :chequeName, :paymentMode, :now)
       ON CONFLICT(ledger_id) DO UPDATE SET beneficiary_name = excluded.beneficiary_name, account_no = excluded.account_no, ifsc = excluded.ifsc,
         bank_name = excluded.bank_name, branch = excluded.branch, account_type = excluded.account_type, cheque_name = excluded.cheque_name,
         payment_mode = excluded.payment_mode, updated_at = excluded.updated_at`,
      { id: input.ledgerId, ...next, now },
    );
  }
  const after = getPayee(db, input.ledgerId);
  const strip = (p: PayeeBankDetails) => ({
    beneficiaryName: p.beneficiaryName,
    accountNo: p.accountNo,
    ifsc: p.ifsc,
    bankName: p.bankName,
    branch: p.branch,
    accountType: p.accountType,
    chequeName: p.chequeName,
    paymentMode: p.paymentMode,
  });
  if (JSON.stringify(strip(before)) !== JSON.stringify(strip(after))) {
    ctx.audit({
      action: 'alter',
      entityType: 'ledger_bank_details',
      entityId: input.ledgerId,
      entityLabel: `Bank details of ${before.ledgerName}`,
      before: strip(before),
      after: strip(after),
    });
  }
  return after;
}

/** Party / expense ledgers with (or, with `withDetails: false`, also without) payee bank details. */
export function listPayees(db: Db, input: PayeeListInput): { rows: PayeeListRow[]; total: number } {
  const search = txt(input.search);
  const where: string[] = [
    // Not cash / bank ledgers (their details are in the ledger itself).
    `l.group_id NOT IN (WITH RECURSIVE g(id) AS (SELECT id FROM groups WHERE reserved_code IN ('BANK_ACCOUNTS', 'BANK_OD', 'CASH_IN_HAND'))
                         SELECT id FROM g UNION SELECT c.id FROM groups c JOIN g ON c.parent_id = g.id)`,
  ];
  if (input.withDetails !== false) where.push('p.ledger_id IS NOT NULL');
  else where.push(`(p.ledger_id IS NOT NULL OR l.group_id IN (WITH RECURSIVE s(id) AS (SELECT id FROM groups WHERE reserved_code IN ('SUNDRY_CREDITORS', 'SUNDRY_DEBTORS'))
                         SELECT id FROM s UNION SELECT c.id FROM groups c JOIN s ON c.parent_id = s.id))`);
  if (search) where.push("(l.name LIKE :q ESCAPE '\\' OR p.beneficiary_name LIKE :q ESCAPE '\\' OR p.account_no LIKE :q ESCAPE '\\')");
  const q = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const sql = `FROM ledgers l JOIN groups gr ON gr.id = l.group_id LEFT JOIN payee_bank_details p ON p.ledger_id = l.id WHERE ${where.join(' AND ')}`;
  const total = db.value<number>(`SELECT COUNT(*) ${sql}`, search ? { q } : {}) ?? 0;
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  const rows = db
    .all<{
      id: number;
      name: string;
      group_name: string;
      beneficiary_name: string | null;
      account_no: string | null;
      ifsc: string | null;
      bank_name: string | null;
      payment_mode: PayeeListRow['paymentMode'];
      has: number;
    }>(
      `SELECT l.id, l.name, gr.name AS group_name, p.beneficiary_name, p.account_no, p.ifsc, p.bank_name, p.payment_mode,
              CASE WHEN p.ledger_id IS NULL THEN 0 ELSE 1 END AS has
         ${sql} ORDER BY l.name COLLATE NOCASE LIMIT :limit OFFSET :offset`,
      { ...(search ? { q } : {}), limit, offset },
    )
    .map((r) => ({
      ledgerId: r.id,
      ledgerName: r.name,
      groupName: r.group_name,
      beneficiaryName: r.beneficiary_name,
      accountNo: r.account_no,
      ifsc: r.ifsc,
      bankName: r.bank_name,
      paymentMode: r.payment_mode,
      hasDetails: r.has === 1,
    }));
  return { rows, total };
}
