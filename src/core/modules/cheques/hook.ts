/**
 * Cheques voucher hook (vouchers/hooks.ts extension point). A no-op unless F11 › Cheque printing is on
 * and the voucher is a Payment or Contra.
 *
 *   compose      a bank credit line paid by cheque without a number gets the next unused leaf of the
 *                bank's cheque books (books.ts › nextLeaf) — inside the save transaction, so two vouchers
 *                can never get the same leaf; the preview shows the number it would get.
 *   adjust       confirm-level warnings: the leaf is already issued on another voucher, used twice in
 *                this voucher, cancelled, or spoilt; info: not in any cheque book / every leaf used.
 *   beforeRemove cancelling a voucher cancels its cheque leaves (the written leaf cannot be reused); a
 *                deleted voucher frees its leaves unless they were printed (then they count as spoilt,
 *                derived from cheque_prints in the register).
 */
import { formatDate } from '../../../shared/dates.ts';
import type { LedgerLineInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { getFeatures } from '../company/service.ts';
import type { PostingAdjustContext, VoucherHook } from '../vouchers/hooks.ts';
import type { PostingEnv } from '../vouchers/posting.ts';
import type { VoucherTypeInfo } from '../vouchers/numbering.ts';
import type { VoucherRow } from '../vouchers/service.ts';
import { bookOfLeaf, hasActiveBook, nextLeaf } from './books.ts';
import { chequeNumber, issuedCheques, leafMarks, spoiltByPrint, voucherLabel } from './common.ts';

const CHEQUE_BASES: ReadonlySet<string> = new Set(['payment', 'contra']);

const isChequeCredit = (l: LedgerLineInput): boolean => l.instrument?.type === 'cheque' && l.amount < 0;
const typedNumber = (l: LedgerLineInput): string => (l.instrument?.number ?? '').trim();

function ledgerName(db: Db, id: number): string {
  return db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id }) ?? 'the bank';
}

function compose(env: PostingEnv, input: VoucherInput, vt: VoucherTypeInfo, voucherId: number | null): VoucherInput | undefined {
  if (!env.features.chequePrinting || !CHEQUE_BASES.has(vt.baseType)) return undefined;
  const lines = input.ledgers ?? [];
  if (!lines.some((l) => isChequeCredit(l) && typedNumber(l) === '')) return undefined;
  // Numbers typed on other lines of this voucher are taken.
  const taken = new Map<number, Set<number>>();
  const takenOf = (bank: number): Set<number> => {
    let s = taken.get(bank);
    if (!s) taken.set(bank, (s = new Set()));
    return s;
  };
  for (const l of lines) {
    const n = isChequeCredit(l) ? chequeNumber(typedNumber(l)) : null;
    if (n !== null) takenOf(l.ledgerId).add(n);
  }
  let changed = false;
  const ledgers = lines.map((l) => {
    if (!isChequeCredit(l) || typedNumber(l) !== '' || !hasActiveBook(env.db, l.ledgerId)) return l;
    const next = nextLeaf(env.db, l.ledgerId, { excludeVoucherId: voucherId, taken: takenOf(l.ledgerId) });
    if (!next) return l;
    takenOf(l.ledgerId).add(Number(next.chequeNo));
    changed = true;
    return { ...l, instrument: { ...(l.instrument ?? { type: 'cheque' as const }), number: next.chequeNo } };
  });
  return changed ? { ...input, ledgers } : undefined;
}

function adjust(ctx: PostingAdjustContext): void {
  const { env, input } = ctx;
  if (!env.features.chequePrinting || !CHEQUE_BASES.has(ctx.baseType)) return;
  const lines = input.ledgers ?? [];
  const seen = new Map<string, number>();
  const byBank = new Map<number, ReturnType<typeof issuedCheques>>();
  lines.forEach((l, i) => {
    if (!isChequeCredit(l)) return;
    const path = `ledgers[${i}]`;
    const raw = typedNumber(l);
    const bank = ledgerName(env.db, l.ledgerId);
    if (raw === '') {
      if (hasActiveBook(env.db, l.ledgerId)) {
        ctx.warn('cheque', `Every leaf of the cheque books of ${bank} is used or cancelled. Add a cheque book (Banking › Cheque Books) or type the cheque number.`, 'info', path);
      }
      return;
    }
    const n = chequeNumber(raw);
    if (n === null) return;
    const key = `${l.ledgerId}:${n}`;
    if (seen.has(key)) {
      ctx.warn('cheque', `Cheque ${raw} of ${bank} is used on two lines of this voucher.`, 'confirm', path);
      return;
    }
    seen.set(key, i);
    let issued = byBank.get(l.ledgerId);
    if (!issued) byBank.set(l.ledgerId, (issued = issuedCheques(env.db, l.ledgerId, { excludeVoucherId: ctx.voucherId })));
    const other = issued.find((c) => c.chequeNo === n);
    if (other) {
      ctx.warn('cheque', `Cheque ${raw} of ${bank} is already issued on ${voucherLabel(other.typeName, other.number, other.date)}. Check the cheque number.`, 'confirm', path);
      return;
    }
    const mark = leafMarks(env.db, l.ledgerId).get(n);
    if (mark) {
      ctx.warn('cheque', `Cheque ${raw} of ${bank} was cancelled on ${formatDate(mark.date)}${mark.reason ? ` (${mark.reason})` : ''}. Use another leaf.`, 'confirm', path);
      return;
    }
    const spoilt = spoiltByPrint(env.db, l.ledgerId, issuedCheques(env.db, l.ledgerId)).get(n);
    if (spoilt) {
      ctx.warn('cheque', `Cheque ${raw} of ${bank} was printed${spoilt.label ? ` for ${spoilt.label}` : ''} and is spoilt. Use another leaf.`, 'confirm', path);
      return;
    }
    if (hasActiveBook(env.db, l.ledgerId) && !bookOfLeaf(env.db, l.ledgerId, n)) {
      ctx.warn('cheque', `Cheque ${raw} is not in any cheque book of ${bank}.`, 'info', path);
    }
  });
}

/** Cancelling a voucher cancels the cheque leaves it used (the written leaf cannot be used again). */
function beforeRemove(ctx: CompanyCtx, row: VoucherRow, action: 'delete' | 'cancel'): void {
  if (action !== 'cancel' || !CHEQUE_BASES.has(row.base_type) || !getFeatures(ctx.db).chequePrinting) return;
  const typeName = ctx.db.value<string>('SELECT name FROM voucher_types WHERE id = :id', { id: row.voucher_type_id }) ?? 'Voucher';
  const label = voucherLabel(typeName, row.number, row.date);
  const now = ctx.clock.now().toISOString();
  for (const e of ctx.db.all<{ ledger_id: number; instrument_no: string | null }>(
    "SELECT ledger_id, instrument_no FROM ledger_entries WHERE voucher_id = :id AND instrument_type = 'cheque' AND amount < 0",
    { id: row.id },
  )) {
    const n = chequeNumber(e.instrument_no);
    if (n === null) continue;
    ctx.db.run(
      `INSERT OR IGNORE INTO cheque_leaf_marks (bank_ledger_id, cheque_no, status, reason, date, voucher_id, created_by, created_at)
       VALUES (:b, :n, 'cancelled', :reason, :date, :v, :by, :now)`,
      { b: e.ledger_id, n, reason: `${label} cancelled`, date: ctx.clock.today(), v: row.id, by: ctx.session.userId, now },
    );
  }
}

export const chequeVoucherHook: VoucherHook = { name: 'cheques', compose, adjust, beforeRemove };
