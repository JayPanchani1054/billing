/**
 * Return / exchange from a POS bill — pure logic (tested in returns.test.ts): the quantities picked
 * against what is still returnable, and the Credit Note the return screen saves (same party, place of
 * supply, rates and discounts as the bill; the bill's number as the original invoice, CGST s.34).
 */
import { roundTo, type Paise } from '../../../../shared/money.ts';
import type { PosReturnContext, VoucherPosInput } from '../../../../shared/types/pos.ts';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';
import { lineValue } from './cart.ts';

/** Quantity to take back per bill line index. */
export type ReturnPicks = ReadonlyMap<number, number>;

export function pickIssues(ctx: Pick<PosReturnContext, 'lines'>, picks: ReturnPicks): Record<number, string> {
  const out: Record<number, string> = {};
  for (const l of ctx.lines) {
    const q = picks.get(l.index) ?? 0;
    if (q < 0) out[l.index] = 'Enter a quantity of 0 or more.';
    else if (q - l.returnable > 1e-9) out[l.index] = `Only ${l.returnable} ${l.unit} can be returned.`;
    else if (q !== roundTo(q, l.unitDecimals)) out[l.index] = `${l.unit} takes ${l.unitDecimals} decimal place${l.unitDecimals === 1 ? '' : 's'}.`;
  }
  return out;
}

/** Every returnable quantity (the whole bill comes back). */
export function pickAll(ctx: Pick<PosReturnContext, 'lines'>): Map<number, number> {
  return new Map(ctx.lines.filter((l) => l.returnable > 0).map((l) => [l.index, l.returnable]));
}

/** Value before tax of the picked quantities (the preview gives the exact credit note value). */
export function pickedValue(ctx: Pick<PosReturnContext, 'lines'>, picks: ReturnPicks): Paise {
  return ctx.lines.reduce((a, l) => a + lineValue({ qty: picks.get(l.index) ?? 0, rate: l.rate, discountPct: l.discountPct }), 0);
}

export function hasPicks(picks: ReturnPicks): boolean {
  for (const q of picks.values()) if (q > 0) return true;
  return false;
}

export function buildReturnInput(
  ctx: PosReturnContext,
  picks: ReturnPicks,
  posBill: VoucherPosInput,
  opts: { date: string; reason: string; narration?: string },
): VoucherInput {
  const narration = (opts.narration ?? '').trim();
  return {
    voucherTypeId: ctx.returnVoucherTypeId,
    date: opts.date,
    mode: 'item_invoice',
    ...(ctx.partyLedgerId !== null ? { partyLedgerId: ctx.partyLedgerId } : {}),
    ...(ctx.placeOfSupply ? { placeOfSupply: ctx.placeOfSupply } : {}),
    ...(ctx.billNumber ? { originalInvoiceNo: ctx.billNumber } : {}),
    originalInvoiceDate: ctx.billDate,
    noteReason: opts.reason.trim() || 'Sales return',
    ...(narration ? { narration } : {}),
    items: ctx.lines
      .filter((l) => (picks.get(l.index) ?? 0) > 0)
      .map((l) => ({
        itemId: l.itemId,
        qty: picks.get(l.index) ?? 0,
        rate: l.rate,
        rateInclusiveOfTax: l.rateInclusiveOfTax,
        ...(l.discountPct ? { discountPct: l.discountPct } : {}),
        ...(l.ledgerId !== null ? { ledgerId: l.ledgerId } : {}),
        ...(l.godownId !== null ? { godownId: l.godownId } : {}),
        ...(l.batchName ? { batchName: l.batchName } : {}),
      })),
    posBill: { ...posBill, returnOfId: ctx.billId },
  };
}
