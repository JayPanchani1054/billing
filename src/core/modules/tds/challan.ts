/**
 * TDS/TCS challan (ITNS 281) helper: builds the Payment voucher that deposits the tax and saves it
 * through the vouchers module (numbering, period lock, permissions, audit, bank reconciliation stay
 * there). The challan details travel in VoucherInput.tds.challan, so the voucher hook rebuilds
 * tds_challans whenever the voucher is altered (here or in the voucher screen), cancelled or deleted.
 *
 *   Dr TDS Payable – <section> / TCS Payable   tax + surcharge + cess
 *   Dr Interest on TDS/TCS (late payment)       interest
 *   Dr Late fee u/s 234E                         fee
 *   Dr TDS/TCS – penalty and other charges       others
 *       Cr Bank                                  total
 */
import { formatMonth } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { periodDueDate } from '../../../shared/tds/rules.ts';
import type { TdsChallanSaveInput, TdsChallanSuggestion, TdsKind } from '../../../shared/types/tds.ts';
import type { LedgerLineInput, VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { Masters } from '../vouchers/masters.ts';
import { loadVoucherRow, parseMeta, saveVoucher } from '../vouchers/service.ts';
import { challanSuggestion } from './reports.ts';
import { ensureExpenseLedger, ensurePayableLedger, payableLedgerName, TdsStore } from './store.ts';

export const INTEREST_LEDGER = 'Interest on TDS / TCS (late payment)';
export const FEE_LEDGER = 'Late fee u/s 234E';
export const OTHERS_LEDGER = 'TDS / TCS – penalty and other charges';

export function suggestChallan(ctx: CompanyCtx, p: { kind: TdsKind; section: string; period: string; depositDate: string; excludeVoucherId?: number }): TdsChallanSuggestion {
  const s = challanSuggestion(ctx.db, { ...p, today: ctx.clock.today() });
  return {
    kind: p.kind,
    section: p.section,
    period: p.period,
    dueDate: periodDueDate(p.kind, p.period),
    unpaid: s.unpaid,
    interest: s.interest,
    lines: s.lines,
    payableLedgerId: new TdsStore(ctx.db).payableLedgerId(p.kind, p.section),
    payableLedgerName: payableLedgerName(p.kind, p.section),
  };
}

export function saveChallan(ctx: CompanyCtx, input: TdsChallanSaveInput): VoucherSaveResult {
  const { db } = ctx;
  const c = input.challan;
  const m = new Masters(db);
  const bank = m.ledgerOrNull(input.bankLedgerId);
  if (!bank || !bank.isCashBank) throw validation([{ path: 'bankLedgerId', message: 'Select the bank (or cash) ledger the tax was paid from.' }]);
  const deposited = c.tax + (c.surcharge ?? 0) + (c.cess ?? 0);
  const total = deposited + (c.interest ?? 0) + (c.fee ?? 0) + (c.others ?? 0);
  if (total <= 0) throw validation([{ path: 'challan.tax', message: 'Enter the tax (and any interest or fee) paid with this challan.' }]);

  let voucherTypeId = input.voucherTypeId;
  let existingNumber: string | undefined;
  if (input.voucherId !== undefined) {
    const row = loadVoucherRow(db, input.voucherId);
    if (!row) throw notFound('Challan voucher', input.voucherId);
    if (row.base_type !== 'payment') throw rule('This voucher is not a Payment voucher.');
    if (!parseMeta(row.meta).input?.tds?.challan) throw rule('This Payment voucher carries no challan details.');
    voucherTypeId = row.voucher_type_id;
    existingNumber = row.number ?? undefined;
  }
  if (voucherTypeId === undefined) {
    voucherTypeId = db.value<number>(`SELECT id FROM voucher_types WHERE base_type = 'payment' AND is_active = 1 ORDER BY is_predefined DESC, id LIMIT 1`);
    if (voucherTypeId === undefined) throw rule('No active Payment voucher type exists. Activate one in Voucher Types.');
  }

  const payable = ensurePayableLedger(ctx, c.kind, c.section);
  const ledgers: LedgerLineInput[] = [];
  const label = `${c.kind.toUpperCase()} u/s ${c.section} for ${formatMonth(c.period)}`;
  if (deposited > 0) ledgers.push({ ledgerId: payable, amount: deposited, narration: label });
  if ((c.interest ?? 0) > 0) ledgers.push({ ledgerId: ensureExpenseLedger(ctx, INTEREST_LEDGER), amount: c.interest ?? 0, narration: `Interest — ${label}` });
  if ((c.fee ?? 0) > 0) ledgers.push({ ledgerId: ensureExpenseLedger(ctx, FEE_LEDGER), amount: c.fee ?? 0, narration: `Late fee — ${label}` });
  if ((c.others ?? 0) > 0) ledgers.push({ ledgerId: ensureExpenseLedger(ctx, OTHERS_LEDGER), amount: c.others ?? 0, narration: `Other — ${label}` });
  ledgers.push({ ledgerId: bank.id, amount: -total });

  const voucher: VoucherInput = {
    voucherTypeId,
    date: input.date,
    mode: 'ledger',
    narration:
      input.narration?.trim() ||
      `Challan ${c.challanNo} (BSR ${c.bsrCode}) dated ${c.depositDate}: ${label}, ${formatMoney(total, { symbol: true })}`,
    ledgers,
    tds: { challan: { ...c, minorHead: c.minorHead ?? '200' } },
  };
  if (input.voucherId !== undefined) {
    voucher.id = input.voucherId;
    if (existingNumber !== undefined) voucher.number = existingNumber;
    if (input.expectedUpdatedAt) voucher.expectedUpdatedAt = input.expectedUpdatedAt;
  }
  if (input.acknowledgeWarnings) voucher.acknowledgeWarnings = true;
  return saveVoucher(ctx, voucher);
}
