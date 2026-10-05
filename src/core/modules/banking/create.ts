/**
 * Vouchers from statement lines (bank charges, interest, direct credits, ATM withdrawals …). Each voucher is
 * posted through the vouchers service (saveVoucher: numbering, guards, period lock, audit), then its bank
 * entry gets the statement date as bank date and the line becomes 'created'.
 *
 *   deposit    → Receipt: Dr Bank / Cr contra ledger     or Contra: Dr Bank / Cr Cash (or another bank)
 *   withdrawal → Payment: Dr contra ledger / Cr Bank     or Contra: Dr Cash (or another bank) / Cr Bank
 */
import type { CreateFromLineInput, CreateFromLineResult } from '../../../shared/types/banking.ts';
import type { InstrumentInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { AppError, notFound, rule, validation } from '../../lib/errors.ts';
import { ledgerClass } from '../accounts/books.ts';
import { saveVoucher } from '../vouchers/service.ts';
import { effectiveStatus, lineLabel, linkLine, loadLine, requireBankLedger, requirePermission } from './common.ts';
import { instrumentFromNarration } from './matcher.ts';

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

export function createFromLine(ctx: CompanyCtx, input: CreateFromLineInput): CreateFromLineResult {
  const { db } = ctx;
  requirePermission(ctx, 'vouchers.create', 'create vouchers');
  requirePermission(ctx, 'banking.reconcile', 'reconcile bank accounts');
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
  const res = saveVoucher(ctx, {
    voucherTypeId: voucherTypeFor(ctx, input.kind, input.voucherTypeId),
    date: line.txn_date,
    mode: 'ledger',
    narration,
    ledgers,
    acknowledgeWarnings: input.acknowledgeWarnings === true,
  });
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

/** All-or-nothing: any failure rolls back every voucher of the batch (numbers are not consumed). */
export function createFromLines(ctx: CompanyCtx, items: readonly CreateFromLineInput[], acknowledgeWarnings?: boolean): CreateFromLineResult[] {
  const seen = new Map<number, number>();
  items.forEach((it, i) => {
    const prev = seen.get(it.lineId);
    if (prev !== undefined) {
      throw validation([{ path: `items[${i}].lineId`, message: `Statement line ${it.lineId} is listed twice (items ${prev + 1} and ${i + 1})` }]);
    }
    seen.set(it.lineId, i);
  });
  return ctx.db.transaction(() =>
    items.map((it, i) => {
      try {
        return createFromLine(ctx, { ...it, acknowledgeWarnings: it.acknowledgeWarnings ?? acknowledgeWarnings });
      } catch (err) {
        if (err instanceof AppError) {
          // Field issues (VALIDATION) keep their array shape; other details gain the failing item's index.
          const details = Array.isArray(err.details)
            ? err.details
            : { ...(err.details && typeof err.details === 'object' ? err.details : {}), index: i };
          throw new AppError(err.code, `Item ${i + 1} of ${items.length}: ${err.message} Nothing was saved.`, details);
        }
        throw err;
      }
    }),
  );
}
