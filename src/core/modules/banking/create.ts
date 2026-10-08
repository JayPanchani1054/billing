/**
 * Vouchers from statement lines (bank charges, interest, direct credits, ATM withdrawals …). Each voucher is
 * posted through the vouchers service (saveVoucher: numbering, guards, period lock, audit), then its bank
 * entry gets the statement date as bank date and the line becomes 'created'.
 *
 *   deposit    → Receipt: Dr Bank / Cr contra ledger     or Contra: Dr Bank / Cr Cash (or another bank)
 *   withdrawal → Payment: Dr contra ledger / Cr Bank     or Contra: Dr Cash (or another bank) / Cr Bank
 *
 * Duplicate guard: when the books already hold an unmatched entry that could be this line (same signed amount
 * within the auto-match date rules), creating another voucher would very likely double-count it. Unless
 * `acknowledgeWarnings` is set, the request fails with BUSINESS_RULE { needsConfirmation: true, warnings: string[],
 * possibleDuplicates } naming those vouchers — match the line instead, or confirm to create it anyway.
 */
import type { CreateFromLineInput, CreateFromLineResult, MatchCandidate, StatementLineStatus } from '../../../shared/types/banking.ts';
import type { InstrumentInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { AppError, notFound, rule, validation } from '../../lib/errors.ts';
import { ledgerClass } from '../accounts/books.ts';
import { previewVoucher, saveVoucher } from '../vouchers/service.ts';
import { effectiveStatus, fmtDate, lineLabel, linkLine, loadLine, money, requireBankLedger, requirePermission, type BankLedger, type LineRow } from './common.ts';
import { DEFAULT_MATCH_OPTIONS, instrumentFromNarration } from './matcher.ts';
import { lineCandidates } from './matching.ts';

const KIND_LABEL = { receipt: 'Receipt', payment: 'Payment', contra: 'Contra' } as const;

function voucherTypeFor(ctx: CompanyCtx, kind: CreateFromLineInput['kind'], voucherTypeId: number | undefined): number {
  if (voucherTypeId !== undefined) {
    const vt = ctx.db.get<{ base_type: string; name: string; is_active: number }>('SELECT base_type, name, is_active FROM voucher_types WHERE id = :id', {
      id: voucherTypeId,
    });
    if (!vt) throw notFound('Voucher type', voucherTypeId);
    if (vt.base_type !== kind) throw rule(`Voucher type "${vt.name}" is not a ${KIND_LABEL[kind]} type. Choose a ${KIND_LABEL[kind]} voucher type.`);
    if (vt.is_active !== 1) throw rule(`Voucher type "${vt.name}" is inactive. Choose another ${KIND_LABEL[kind]} voucher type.`);
    return voucherTypeId;
  }
  const id = ctx.db.value<number>(
    'SELECT id FROM voucher_types WHERE base_type = :k AND is_active = 1 ORDER BY is_predefined DESC, id LIMIT 1',
    { k: kind },
  );
  if (id === undefined) throw rule(`There is no active ${KIND_LABEL[kind]} voucher type. Create one in Voucher Types first.`);
  return id;
}

/** Instrument for the bank line from the statement: NEFT/RTGS/IMPS/UPI/cheque … and the reference as number. */
function instrumentOf(description: string, reference: string): InstrumentInput | undefined {
  const type = instrumentFromNarration(`${description} ${reference}`);
  const number = reference.trim().slice(0, 50) || undefined;
  if (!type && !number) return undefined;
  return { type: type ?? 'other', number };
}

/** Everything checked and prepared for one line, before anything is written. */
interface LinePlan {
  line: LineRow;
  status: StatementLineStatus;
  bank: BankLedger;
  voucher: VoucherInput;
}

function planFromLine(ctx: CompanyCtx, input: CreateFromLineInput): LinePlan {
  const { db } = ctx;
  const line = loadLine(db, input.lineId);
  const status = effectiveStatus(line);
  if (status === 'matched' || status === 'created') {
    throw rule(`Statement line ${lineLabel(line)} is already matched with ${[line.e_type_name, line.e_number].filter(Boolean).join(' ')}.`);
  }
  const bank = requireBankLedger(db, line.ledger_id, 'Bank reconciliation');
  const deposit = line.amount > 0;
  if (input.kind === 'receipt' && !deposit) {
    throw rule(`Statement line ${lineLabel(line)} is a withdrawal. Record it as a Payment (or a Contra for cash withdrawn / transfers).`);
  }
  if (input.kind === 'payment' && deposit) {
    throw rule(`Statement line ${lineLabel(line)} is a deposit. Record it as a Receipt (or a Contra for cash deposited / transfers).`);
  }
  if (input.contraLedgerId === bank.id) throw rule(`Choose the other ledger of the transaction, not ${bank.name} itself.`);
  const contraName = db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: input.contraLedgerId });
  if (contraName === undefined) throw notFound('Ledger', input.contraLedgerId);
  const cls = ledgerClass(db, input.contraLedgerId);
  if (input.kind === 'contra' && !cls.isCashOrBank) {
    throw rule(`${contraName} is not a Cash or Bank ledger. A Contra voucher only moves money between Cash, Bank and Bank OD accounts — use a ${deposit ? 'Receipt' : 'Payment'} instead.`);
  }
  if (input.kind !== 'contra' && cls.isCashOrBank) {
    throw rule(`${contraName} is a Cash/Bank ledger. Money moved between Cash and Bank accounts is entered as a Contra voucher.`);
  }

  const amount = Math.abs(line.amount);
  const description = (line.description ?? '').trim();
  const instrument = instrumentOf(description, line.reference ?? '');
  const ledgers: VoucherInput['ledgers'] = deposit
    ? [
        { ledgerId: bank.id, amount, instrument },
        { ledgerId: input.contraLedgerId, amount: -amount },
      ]
    : [
        { ledgerId: input.contraLedgerId, amount },
        { ledgerId: bank.id, amount: -amount, instrument },
      ];
  const narration = (input.narration?.trim() || description).slice(0, 4000) || undefined;
  return {
    line,
    status,
    bank,
    voucher: { voucherTypeId: voucherTypeFor(ctx, input.kind, input.voucherTypeId), date: line.txn_date, mode: 'ledger', narration, ledgers },
  };
}

/**
 * Unmatched book entries that could be this statement line (same signed amount, auto-match date rules with
 * the default 7-day window; cheques named in the statement up to 92 days), best first, at most 3.
 */
export function possibleDuplicates(ctx: CompanyCtx, line: LineRow): MatchCandidate[] {
  return lineCandidates(ctx.db, ctx.clock.today(), line, { dateWindowDays: DEFAULT_MATCH_OPTIONS.dateWindowDays, limit: 3 });
}

function duplicateText(c: MatchCandidate): string {
  return `${c.voucherType}${c.number ? ` ${c.number}` : ''} dated ${fmtDate(c.date)} — ${c.particulars}, ${money(Math.abs(c.amount))} — is already in the books and not matched with any statement line.`;
}

/**
 * What the user must accept before this line's voucher is saved: possible duplicates and, only when there are
 * any, the voucher engine's own 'confirm' warnings (so one confirmation covers both). [] = nothing to confirm.
 */
function confirmationsFor(ctx: CompanyCtx, plan: LinePlan, prefix: string): { warnings: string[]; dups: MatchCandidate[] } {
  const dups = possibleDuplicates(ctx, plan.line);
  if (dups.length === 0) return { warnings: [], dups };
  const warnings = dups.map((c) => `${prefix}${duplicateText(c)}`);
  try {
    for (const w of previewVoucher(ctx, plan.voucher).warnings) if (w.level === 'confirm') warnings.push(`${prefix}${w.message}`);
  } catch {
    // Field/rule errors surface from saveVoucher itself.
  }
  return { warnings, dups };
}

function duplicateError(message: string, warnings: string[], possible: Array<{ lineId: number; candidates: MatchCandidate[] }>): AppError {
  return rule(message, { needsConfirmation: true, warnings, possibleDuplicates: possible });
}

function saveFromPlan(ctx: CompanyCtx, plan: LinePlan, acknowledgeWarnings: boolean): CreateFromLineResult {
  const { db } = ctx;
  const { line, bank, status } = plan;
  const res = saveVoucher(ctx, { ...plan.voucher, acknowledgeWarnings });
  const entryId = db.value<number>(
    'SELECT id FROM ledger_entries WHERE voucher_id = :v AND ledger_id = :l AND amount = :a ORDER BY line_no LIMIT 1',
    { v: res.id, l: bank.id, a: line.amount },
  );
  if (entryId === undefined) throw new Error(`createFromLine: bank entry of voucher ${res.id} not found`);
  linkLine(ctx, line, entryId, 'created', null);
  ctx.audit({
    action: 'alter',
    entityType: 'bank_statement_line',
    entityId: line.id,
    entityLabel: `Voucher created from ${lineLabel(line)}`,
    before: { status },
    after: { status: 'created', voucherId: res.id, number: res.number, ledgerEntryId: entryId, bankDate: line.txn_date },
  });
  return { lineId: line.id, voucherId: res.id, number: res.number, ledgerEntryId: entryId, warnings: res.warnings };
}

function requireCreatePermissions(ctx: CompanyCtx): void {
  requirePermission(ctx, 'vouchers.create', 'create vouchers');
  requirePermission(ctx, 'banking.reconcile', 'reconcile bank accounts');
}

export function createFromLine(ctx: CompanyCtx, input: CreateFromLineInput): CreateFromLineResult {
  requireCreatePermissions(ctx);
  const plan = planFromLine(ctx, input);
  const ack = input.acknowledgeWarnings === true;
  if (!ack) {
    const { warnings, dups } = confirmationsFor(ctx, plan, '');
    if (dups.length > 0) {
      throw duplicateError(
        `Statement line ${lineLabel(plan.line)} may already be entered in the books. Match the line with that voucher instead of creating another one, or confirm to create a new voucher anyway.`,
        warnings,
        [{ lineId: plan.line.id, candidates: dups }],
      );
    }
  }
  return saveFromPlan(ctx, plan, ack);
}

/**
 * All-or-nothing: any failure rolls back every voucher of the batch (numbers are not consumed). Without
 * acknowledgement, every item is checked for possible duplicates first and ONE confirmation lists them all.
 */
export function createFromLines(ctx: CompanyCtx, items: readonly CreateFromLineInput[], acknowledgeWarnings?: boolean): CreateFromLineResult[] {
  requireCreatePermissions(ctx);
  const seen = new Map<number, number>();
  items.forEach((it, i) => {
    const prev = seen.get(it.lineId);
    if (prev !== undefined) {
      throw validation([{ path: `items[${i}].lineId`, message: `Statement line ${it.lineId} is listed twice (items ${prev + 1} and ${i + 1})` }]);
    }
    seen.set(it.lineId, i);
  });
  const fail = (err: unknown, i: number): never => {
    if (err instanceof AppError) {
      // Field issues (VALIDATION) keep their array shape; other details gain the failing item's index.
      const details = Array.isArray(err.details) ? err.details : { ...(err.details && typeof err.details === 'object' ? err.details : {}), index: i };
      throw new AppError(err.code, `Item ${i + 1} of ${items.length}: ${err.message} Nothing was saved.`, details);
    }
    throw err;
  };
  const acks = items.map((it) => (it.acknowledgeWarnings ?? acknowledgeWarnings) === true);
  return ctx.db.transaction(() => {
    const plans = items.map((it, i) => {
      try {
        return planFromLine(ctx, it);
      } catch (err) {
        return fail(err, i);
      }
    });
    const warnings: string[] = [];
    const possible: Array<{ lineId: number; candidates: MatchCandidate[] }> = [];
    plans.forEach((plan, i) => {
      if (acks[i]) return;
      const c = confirmationsFor(ctx, plan, `Item ${i + 1} (${lineLabel(plan.line)}): `);
      if (c.dups.length === 0) return;
      warnings.push(...c.warnings);
      possible.push({ lineId: plan.line.id, candidates: c.dups });
    });
    if (possible.length > 0) {
      throw duplicateError(
        `${possible.length} of the ${items.length} statement line${items.length === 1 ? '' : 's'} may already be entered in the books. ` +
          'Match those lines with the vouchers listed instead, or confirm to create every voucher anyway. Nothing was saved.',
        warnings,
        possible,
      );
    }
    return plans.map((plan, i) => {
      try {
        return saveFromPlan(ctx, plan, acks[i]);
      } catch (err) {
        return fail(err, i);
      }
    });
  });
}
