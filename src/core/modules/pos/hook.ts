/**
 * POS voucher hook (vouchers/hooks.ts extension point). A cheap no-op unless the voucher carries a
 * `posBill` block (VoucherInput.posBill) — or is a saved POS bill being altered / removed.
 *
 *   adjust       turns the tenders into ledger entries of the SAME voucher (no separate receipt):
 *                  Sale (Sales voucher of a POS type, party Dr G):   Dr each tender's ledger,
 *                                                                    party reduced to the unpaid part.
 *                  Return (Credit Note, party Cr G):                  Cr each tender's ledger (refund /
 *                                                                    exchange credit issued), party
 *                                                                    reduced to what is credited.
 *                Σ entries stays 0 (the party's reduction equals Σ tenders). The unpaid part stays on
 *                the party with the usual bill-wise reference named after the bill — only a customer
 *                may buy on credit: the walk-in (cash / bank) party must be paid in full. Checks (block):
 *                POS type, invoice mode, tender modes, Σ tenders ≤ bill, cash tendered ≥ cash, exchange
 *                credit available, a return's bill / party / items and quantities still returnable.
 *   validate     F11 › POS invoicing must be on to enter a posBill; a saved POS bill cannot lose its
 *                tenders by an alteration made elsewhere (it is altered on the POS counter).
 *   write        rebuilds pos_bills / pos_payments (date, affects_books, is_post_dated) in the voucher's
 *                transaction; clear removes them on alter / cancel / delete.
 *   beforeRemove refuses to delete / cancel a bill with returns in the books, or a return whose
 *                exchange credit was used on a later bill (cancel those first).
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { PosBillView, PosTenderInput, PosTenderKind, PosTenderView, VoucherPosInput } from '../../../shared/types/pos.ts';
import { POS_TENDER_KIND_LABELS } from '../../../shared/types/pos.ts';
import type { InstrumentType, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { rule, validation } from '../../lib/errors.ts';
import { getFeatures } from '../company/service.ts';
import type { PostingAdjustContext, VoucherHook, VoucherHookValidateArgs, VoucherHookWriteContext } from '../vouchers/hooks.ts';
import type { VoucherTypeInfo } from '../vouchers/numbering.ts';
import type { PostingEnv } from '../vouchers/posting.ts';
import type { VoucherRow } from '../vouchers/service.ts';
import { POS_OFF_MESSAGE } from './store.ts';

/** Data handed from adjust() to write() / preview(). */
export interface PosStash extends PosBillView {}

interface ModeRow {
  id: number;
  name: string;
  kind: PosTenderKind;
  ledger_id: number;
  ledger_name: string;
  is_active: number;
}

const rupees = (p: number): string => `₹ ${formatMoney(p)}`;

/**
 * CGST Rule 46(e): name, address of delivery and state of an UNREGISTERED recipient are required on the
 * tax invoice when the taxable value is ₹50,000 or more (below that, a walk-in bill may say "Cash").
 */
export const RULE_46E_UNREGISTERED_PAISE = 50_000_00;
/**
 * Income-tax Act 1961 s.269ST (cash of ₹2,00,000 or more from a person in a day / for one transaction /
 * one event is prohibited; penalty s.271DA). The Income-tax Act, 2025 (in force from 1-Apr-2026) carries
 * the same limit — its section number is not relied on here (see README › Legal notes). Checked per
 * bill only; the per-day aggregate for one person is not tracked.
 */
export const CASH_RECEIPT_LIMIT_PAISE = 2_00_000_00;

/** Books filter for pos_bills / pos_payments rows (same as gst_lines). */
export const POS_BOOKS = `affects_books = 1 AND (is_post_dated = 0 OR date <= :today)`;

function voucherLabelOf(db: Db, id: number): string {
  const v = db.get<{ type_name: string; number: string | null; date: string }>(
    'SELECT vt.name AS type_name, v.number, v.date FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id',
    { id },
  );
  return v ? `${v.type_name} ${v.number ?? ''} dated ${formatDate(v.date)}`.replace(/\s+/g, ' ') : `voucher #${id}`;
}

/**
 * Exchange credit a return issued (Σ its exchange tenders, magnitude). Counts the return when it is in
 * the books (affects_books); a post-dated return can only be used on or after its date (checked by date).
 */
export function exchangeIssued(db: Db, returnId: number): number {
  return -(db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM pos_payments WHERE voucher_id = :id AND kind = 'exchange' AND affects_books = 1`, { id: returnId }) ?? 0);
}

/**
 * Exchange credit of a return used on bills (magnitude), optionally excluding one voucher. Every bill in
 * the books counts — a post-dated bill too, even before its date — so the same credit is never spent twice.
 */
export function exchangeUsed(db: Db, returnId: number, excludeVoucherId: number | null = null): number {
  return (
    db.value<number>(`SELECT COALESCE(SUM(amount), 0) FROM pos_payments WHERE exchange_voucher_id = :id AND voucher_id IS NOT :ex AND affects_books = 1`, {
      id: returnId,
      ex: excludeVoucherId,
    }) ?? 0
  );
}

/**
 * Quantity and taxable value per item of a POS bill already taken back by POS returns in the books
 * (excluding one voucher). A post-dated return counts before its date too: the goods are promised back.
 */
export function returnedQty(db: Db, billId: number, excludeVoucherId: number | null = null): Map<number, number> {
  const out = new Map<number, number>();
  for (const [itemId, r] of returnedByItem(db, billId, excludeVoucherId)) out.set(itemId, r.qty);
  return out;
}

export function returnedByItem(db: Db, billId: number, excludeVoucherId: number | null = null): Map<number, { qty: number; value: number }> {
  const out = new Map<number, { qty: number; value: number }>();
  for (const r of db.all<{ item_id: number; qty: number; value: number }>(
    `SELECT ie.item_id, SUM(ABS(COALESCE(ie.billed_qty, ie.qty))) AS qty, SUM(ie.amount) AS value
       FROM pos_bills b JOIN inventory_entries ie ON ie.voucher_id = b.voucher_id
      WHERE b.return_of_id = :bill AND b.voucher_id IS NOT :ex AND b.affects_books = 1
      GROUP BY ie.item_id`,
    { bill: billId, ex: excludeVoucherId },
  )) {
    out.set(r.item_id, { qty: r.qty, value: r.value });
  }
  return out;
}

/** Quantity and taxable value per item sold on a voucher. */
function soldByItem(db: Db, voucherId: number): Map<number, { qty: number; value: number }> {
  const out = new Map<number, { qty: number; value: number }>();
  for (const r of db.all<{ item_id: number; qty: number; value: number }>(
    'SELECT item_id, SUM(ABS(COALESCE(billed_qty, qty))) AS qty, SUM(amount) AS value FROM inventory_entries WHERE voucher_id = :id GROUP BY item_id',
    { id: voucherId },
  )) {
    out.set(r.item_id, { qty: r.qty, value: r.value });
  }
  return out;
}

/**
 * Round-off slack per return (paise): a bill rounded down and its returns rounded up can together
 * exceed the bill by up to ₹1 per note; anything more is a refund larger than what was paid.
 */
export const RETURN_ROUNDING_SLACK = 100;

/**
 * Last date a credit note may reduce output tax on a supply (CGST s.34(2) as amended w.e.f.
 * 1-Oct-2022): 30 November after the end of the financial year of the supply (or the annual return,
 * if filed earlier — not known here).
 */
export function creditNoteGstDeadline(supplyDate: string): string {
  const y = Number(supplyDate.slice(0, 4));
  const m = Number(supplyDate.slice(5, 7));
  const fyEnd = m >= 4 ? y + 1 : y;
  return `${fyEnd}-11-30`;
}

const instrumentFor = (kind: PosTenderKind): InstrumentType | null => (kind === 'card' ? 'card' : kind === 'upi' ? 'upi' : null);

function adjust(ctx: PostingAdjustContext): void {
  const pb = ctx.input.posBill;
  if (!pb) return;
  const { env } = ctx;
  const db = env.db;
  if (!env.features.pos) {
    ctx.warn('pos', POS_OFF_MESSAGE, 'block', 'posBill');
    return;
  }
  const isSale = ctx.baseType === 'sales';
  if (!isSale && ctx.baseType !== 'credit_note') {
    ctx.warn('pos', 'Tenders can be entered on a POS bill (Sales) or a POS return (Credit Note) only.', 'block', 'posBill');
    return;
  }
  if (isSale && ctx.voucherType.config?.posInvoice !== true) {
    ctx.warn('pos', `'${ctx.voucherType.name}' is not a POS voucher type. Bill on the POS counter, or mark the type "Use as POS invoice" (Masters › Voucher Types).`, 'block', 'posBill');
    return;
  }
  if (ctx.mode !== 'item_invoice' && ctx.mode !== 'accounting_invoice') {
    ctx.warn('pos', 'A POS bill is entered as an invoice (item or accounting invoice mode).', 'block', 'mode');
    return;
  }
  const party = ctx.entries.find((e) => e.source.kind === 'party');
  if (!party || !ctx.party) return; // nothing payable (the engine reports the missing party / zero value)
  const s = isSale ? 1 : -1;
  const billValue = s * party.amount;
  if (billValue <= 0) return; // negative_value / zero_value come from the engine

  // Tender modes (an inactive mode stays usable on the bill that already used it).
  const ids = [...new Set(pb.tenders.map((t) => t.modeId))];
  const modes = new Map<number, ModeRow>();
  if (ids.length > 0) {
    for (const m of db.all<ModeRow>(
      `SELECT m.id, m.name, m.kind, m.ledger_id, l.name AS ledger_name, m.is_active
         FROM pos_tender_modes m JOIN ledgers l ON l.id = m.ledger_id WHERE m.id IN (SELECT value FROM json_each(:ids))`,
      { ids: JSON.stringify(ids) },
    )) {
      modes.set(m.id, m);
    }
  }
  const usedBefore = new Set<number>(
    ctx.voucherId === null ? [] : db.all<{ mode_id: number }>('SELECT DISTINCT mode_id FROM pos_payments WHERE voucher_id = :id', { id: ctx.voucherId }).map((r) => r.mode_id),
  );

  const tenders: PosTenderView[] = [];
  let ok = true;
  const exchangeByNote = new Map<number, { amount: number; index: number }>();
  pb.tenders.forEach((t, i) => {
    const path = `posBill.tenders[${i}]`;
    const m = modes.get(t.modeId);
    if (!m) {
      ctx.warn('pos', 'This tender mode no longer exists. Choose another way of payment.', 'block', `${path}.modeId`);
      ok = false;
      return;
    }
    if (m.is_active !== 1 && !usedBefore.has(m.id)) {
      ctx.warn('pos', `Tender mode '${m.name}' is inactive. Choose another way of payment.`, 'block', `${path}.modeId`);
      ok = false;
      return;
    }
    if (m.kind === 'exchange') {
      if (isSale) {
        if (t.exchangeVoucherId === undefined) {
          ctx.warn('pos', 'Exchange credit needs the return it comes from: choose the POS return.', 'block', `${path}.exchangeVoucherId`);
          ok = false;
          return;
        }
        const prev = exchangeByNote.get(t.exchangeVoucherId);
        exchangeByNote.set(t.exchangeVoucherId, { amount: (prev?.amount ?? 0) + t.amount, index: prev?.index ?? i });
      } else if (t.exchangeVoucherId !== undefined) {
        ctx.warn('pos', 'A return issues exchange credit; it cannot use exchange credit of another return.', 'block', `${path}.exchangeVoucherId`);
        ok = false;
        return;
      }
    } else if (t.exchangeVoucherId !== undefined) {
      ctx.warn('pos', 'Only the exchange-credit tender refers to a return.', 'block', `${path}.exchangeVoucherId`);
      ok = false;
      return;
    }
    const reference = (t.reference ?? '').trim();
    tenders.push({
      modeId: m.id,
      name: m.name,
      kind: m.kind,
      ledgerId: m.ledger_id,
      ledgerName: m.ledger_name,
      amount: t.amount,
      reference: reference === '' ? null : reference,
      exchangeVoucherId: m.kind === 'exchange' && isSale ? (t.exchangeVoucherId ?? null) : null,
    });
  });

  // Exchange credit used on a sale: the return must be a POS return in the books with credit left.
  for (const [noteId, use] of exchangeByNote) {
    const path = `posBill.tenders[${use.index}].exchangeVoucherId`;
    const note = db.get<{ base_type: string; date: string; is_cancelled: number }>('SELECT base_type, date, is_cancelled FROM vouchers WHERE id = :id', { id: noteId });
    if (!note || note.base_type !== 'credit_note' || note.is_cancelled === 1) {
      ctx.warn('pos', 'The exchange credit must come from a POS return (credit note) in the books.', 'block', path);
      ok = false;
      continue;
    }
    if (note.date > ctx.date) {
      ctx.warn('pos', `The return ${voucherLabelOf(db, noteId)} is dated after this bill; exchange credit can only be used on or after the return.`, 'block', path);
      ok = false;
      continue;
    }
    const available = exchangeIssued(db, noteId) - exchangeUsed(db, noteId, ctx.voucherId);
    if (use.amount > available) {
      ctx.warn(
        'pos',
        `${voucherLabelOf(db, noteId)} has ${rupees(Math.max(0, available))} of exchange credit left; ${rupees(use.amount)} cannot be used.`,
        'block',
        path,
      );
      ok = false;
    }
  }

  const paid = tenders.reduce((a, t) => a + t.amount, 0);
  const cashPaid = tenders.filter((t) => t.kind === 'cash').reduce((a, t) => a + t.amount, 0);
  if (paid > billValue) {
    ctx.warn(
      'pos',
      isSale
        ? `The tenders (${rupees(paid)}) are more than the bill (${rupees(billValue)}) by ${rupees(paid - billValue)}. Enter what is applied to the bill; cash handed over goes in "Cash tendered" and the change is worked out.`
        : `The refund (${rupees(paid)}) is more than the return (${rupees(billValue)}) by ${rupees(paid - billValue)}.`,
      'block',
      'posBill.tenders',
    );
    ok = false;
  }
  const credit = billValue - paid;
  if (credit > 0 && ctx.party.isCashBank) {
    ctx.warn(
      'pos',
      isSale
        ? `${rupees(credit)} of the bill is not paid. A walk-in bill is paid in full at the counter: add a tender, or choose the customer to sell on credit.`
        : `${rupees(credit)} of the return is not refunded. Refund it in full (or give exchange credit), or choose the customer to credit the account.`,
      'block',
      'posBill.tenders',
    );
    ok = false;
  }
  let change = 0;
  let cashTendered: number | null = null;
  if (pb.cashTendered !== undefined) {
    if (!isSale) {
      ctx.warn('pos', 'Cash tendered applies to a bill, not to a return.', 'block', 'posBill.cashTendered');
      ok = false;
    } else if (pb.cashTendered < cashPaid) {
      ctx.warn('pos', `Cash tendered (${rupees(pb.cashTendered)}) is less than the cash taken on the bill (${rupees(cashPaid)}).`, 'block', 'posBill.cashTendered');
      ok = false;
    } else if (cashPaid === 0 && pb.cashTendered > 0) {
      ctx.warn('pos', 'Cash tendered is entered but the bill has no cash tender.', 'block', 'posBill.cashTendered');
      ok = false;
    } else {
      cashTendered = pb.cashTendered;
      change = pb.cashTendered - cashPaid;
    }
  }

  // Statutory reminders (confirm, never silent): see README › Legal notes.
  if (isSale) {
    const taxable = ctx.invoiceLines.reduce((a, l) => a + l.taxableValue, 0);
    const snap = ctx.input.party;
    const registered = ((snap?.gstin ?? ctx.party.row.gstin) ?? '').trim() !== '';
    const named = ctx.party.isCashBank ? (snap?.name ?? '').trim() !== '' : true;
    const address = ((snap?.address ?? (ctx.party.isCashBank ? null : ctx.party.row.address)) ?? '').trim() !== '';
    if (!registered && (!named || !address) && taxable >= RULE_46E_UNREGISTERED_PAISE) {
      ctx.warn(
        'pos',
        ctx.party.isCashBank
          ? `This bill's taxable value is ${rupees(taxable)}. For ₹50,000 or more to an unregistered buyer the invoice must show the buyer's name, address of delivery and state (CGST Rule 46(e)): choose or create the customer (Alt+U) and give the address.`
          : `This bill's taxable value is ${rupees(taxable)}. For ₹50,000 or more to an unregistered buyer the invoice must show the address of delivery (CGST Rule 46(e)): ${ctx.party.name} has no address — add it to the customer (ledger master).`,
        'confirm',
        'partyLedgerId',
      );
    }
    if (cashPaid >= CASH_RECEIPT_LIMIT_PAISE) {
      ctx.warn(
        'pos',
        `${rupees(cashPaid)} is taken in cash on one bill. Receiving ₹2,00,000 or more in cash from a person for one transaction is prohibited by the Income-tax Act (s.269ST of the 1961 Act, carried into the Income-tax Act, 2025) — take the excess by UPI, card or bank.`,
        'confirm',
        'posBill.tenders',
      );
    }
  }

  // Return: the bill, its customer and what is still returnable.
  let returnOfId: number | null = null;
  if (pb.returnOfId !== undefined) {
    if (isSale) {
      ctx.warn('pos', 'Only a return (credit note) refers to a POS bill.', 'block', 'posBill.returnOfId');
      ok = false;
    } else if (checkReturn(ctx, pb.returnOfId, billValue)) {
      returnOfId = pb.returnOfId;
    } else ok = false;
  }
  // Alteration of a bill with returns / of a return whose exchange credit was used: what was built on
  // it must stay true (no more back than sold, no credit spent that the return no longer issues).
  if (ctx.voucherId !== null) {
    if (isSale && !checkAlteredBill(ctx, ctx.voucherId, billValue)) ok = false;
    if (!isSale) {
      const issuedNow = ctx.isOptional ? 0 : tenders.filter((t) => t.kind === 'exchange').reduce((a, t) => a + t.amount, 0);
      if (!checkAlteredReturn(ctx, ctx.voucherId, issuedNow)) ok = false;
    }
  }
  if (!ok) return;

  // Post: one entry per tender on its ledger, the party reduced by the same total.
  for (const t of tenders) {
    const ledger = ctx.masters.ledger(t.ledgerId);
    const instrumentType = ledger.isCashBank ? instrumentFor(t.kind) : null;
    ctx.addEntry({
      ledgerId: t.ledgerId,
      amount: s * t.amount,
      role: ledger.isCashBank ? 'cash_bank' : 'other',
      narration: `${isSale ? 'POS' : 'POS refund'} · ${t.name}${t.reference ? ` ${t.reference}` : ''}`,
      instrument: instrumentType ? { type: instrumentType, ...(t.reference ? { number: t.reference } : {}) } : null,
    });
  }
  ctx.adjustEntry(party, -s * paid);
  const counter = (pb.counter ?? '').trim();
  const stash: PosStash = {
    kind: isSale ? 'sale' : 'return',
    billValue,
    paid,
    credit,
    cashTendered,
    change,
    tenders,
    returnOfId,
    counter: counter === '' ? null : counter,
  };
  ctx.setData(stash);
}

/**
 * A return's bill: a POS sale in the books, same customer, not later, items on the bill, quantities
 * and value still returnable (a return never refunds more than was charged for the goods).
 */
function checkReturn(ctx: PostingAdjustContext, billId: number, returnValue: number): boolean {
  const db = ctx.env.db;
  const path = 'posBill.returnOfId';
  const bill = db.get<{ party_ledger_id: number | null; date: string; is_cancelled: number; affects_books: number; bill_value: number }>(
    `SELECT v.party_ledger_id, v.date, v.is_cancelled, v.affects_books, b.bill_value FROM vouchers v JOIN pos_bills b ON b.voucher_id = v.id
      WHERE v.id = :id AND b.kind = 'sale'`,
    { id: billId },
  );
  if (!bill) {
    ctx.warn('pos', 'The bill being returned is not a POS bill. Choose the POS bill the goods were sold on.', 'block', path);
    return false;
  }
  const label = voucherLabelOf(db, billId);
  if (bill.is_cancelled === 1 || bill.affects_books !== 1) {
    ctx.warn('pos', `${label} is ${bill.is_cancelled === 1 ? 'cancelled' : 'not in the books (optional)'}; goods cannot be returned against it.`, 'block', path);
    return false;
  }
  if (ctx.date < bill.date) {
    ctx.warn('pos', `The return is dated before ${label}.`, 'block', 'date');
    return false;
  }
  if (bill.party_ledger_id !== (ctx.party?.id ?? null)) {
    ctx.warn('pos', `${label} was billed to another party. A return is made to the customer of the bill.`, 'block', 'partyLedgerId');
    return false;
  }
  const sold = soldByItem(db, billId);
  const already = returnedByItem(db, billId, ctx.voucherId);
  const items = ctx.input.items ?? [];
  const thisNote = new Map<number, { qty: number; value: number; lines: number; index: number }>();
  items.forEach((l, i) => {
    const q = l.billedQty ?? l.qty;
    const prev = thisNote.get(l.itemId);
    thisNote.set(l.itemId, { qty: (prev?.qty ?? 0) + q, value: prev?.value ?? 0, lines: (prev?.lines ?? 0) + 1, index: prev?.index ?? i });
  });
  for (const line of ctx.invoiceLines) {
    if (line.kind !== 'item') continue;
    const itemId = items[line.index]?.itemId;
    const mine = itemId !== undefined ? thisNote.get(itemId) : undefined;
    if (mine) mine.value += line.taxableValue;
  }
  let ok = true;
  for (const [itemId, mine] of thisNote) {
    const name = ctx.masters.item(itemId).name;
    const s = sold.get(itemId);
    if (!s || s.qty === 0) {
      ctx.warn('pos', `'${name}' is not on ${label}.`, 'block', `items[${mine.index}].itemId`);
      ok = false;
      continue;
    }
    const back = already.get(itemId) ?? { qty: 0, value: 0 };
    const left = s.qty - back.qty;
    // Quantities are REAL: compare with a tolerance far below any unit's decimals.
    if (mine.qty - left > 1e-9) {
      ctx.warn('pos', `Only ${trimQty(Math.max(0, left))} of '${name}' can still be returned on ${label} (sold ${trimQty(s.qty)}).`, 'block', `items[${mine.index}].qty`);
      ok = false;
      continue;
    }
    // Value before tax: at most what the bill charged for that quantity (the whole remainder when all of
    // it comes back), a paisa of rounding per line allowed.
    const valueLeft = s.value - back.value;
    const allowed = Math.abs(mine.qty - left) <= 1e-9 ? valueLeft : Math.round((s.value / s.qty) * mine.qty);
    if (mine.value > allowed + 2 * mine.lines) {
      ctx.warn(
        'pos',
        `'${name}' is returned at ${rupees(mine.value)} before tax, but ${label} charged ${rupees(Math.max(0, allowed))} for ${trimQty(mine.qty)}. Return it at the bill's rate and discount.`,
        'block',
        `items[${mine.index}].rate`,
      );
      ok = false;
    }
  }
  // The whole note: never more than the bill's value still not returned (round-off slack per note).
  const returnedValue =
    db.value<number>('SELECT COALESCE(SUM(bill_value), 0) FROM pos_bills WHERE return_of_id = :bill AND voucher_id IS NOT :ex AND affects_books = 1', {
      bill: billId,
      ex: ctx.voucherId,
    }) ?? 0;
  const valueLeft = bill.bill_value - returnedValue;
  if (ok && returnValue > valueLeft + RETURN_ROUNDING_SLACK) {
    ctx.warn(
      'pos',
      `This return (${rupees(returnValue)}) is more than what is left of ${label} (${rupees(Math.max(0, valueLeft))} of ${rupees(bill.bill_value)} not yet returned).`,
      'block',
      path,
    );
    ok = false;
  }
  // CGST s.34(2): output tax can be reduced by a credit note only up to 30 November after the year of supply.
  const deadline = creditNoteGstDeadline(bill.date);
  if (ok && ctx.date > deadline) {
    ctx.warn(
      'pos',
      `${label} is of an earlier financial year: a credit note dated after ${formatDate(deadline)} cannot reduce the GST paid on it (CGST s.34(2)). Check with your accountant before refunding the tax.`,
      'confirm',
      'date',
    );
  }
  return ok;
}

/** Bill being altered: its returns (party, date, quantities, value) must still fit the bill. */
function checkAlteredBill(ctx: PostingAdjustContext, billId: number, billValue: number): boolean {
  const db = ctx.env.db;
  const returns = db.all<{ voucher_id: number; date: string; bill_value: number; affects_books: number }>(
    'SELECT voucher_id, date, bill_value, affects_books FROM pos_bills WHERE return_of_id = :id ORDER BY date, voucher_id',
    { id: billId },
  );
  if (returns.length === 0) return true;
  const first = returns[0];
  const firstLabel = voucherLabelOf(db, first.voucher_id);
  const keep = 'Cancel or delete the return(s) first, or keep what was returned on the bill.';
  if (ctx.isOptional) {
    ctx.warn('pos', `Goods of this bill were returned on ${firstLabel}; the bill cannot become optional. ${keep}`, 'block', 'isOptional');
    return false;
  }
  const party = db.value<number | null>('SELECT party_ledger_id FROM vouchers WHERE id = :id', { id: billId }) ?? null;
  if ((ctx.party?.id ?? null) !== party) {
    ctx.warn('pos', `Goods of this bill were returned on ${firstLabel}, made to the bill's customer: the customer cannot change. ${keep}`, 'block', 'partyLedgerId');
    return false;
  }
  if (ctx.date > first.date) {
    ctx.warn('pos', `Goods of this bill were returned on ${firstLabel}: the bill cannot be dated after its return. ${keep}`, 'block', 'date');
    return false;
  }
  const back = returnedByItem(db, billId);
  const now = new Map<number, { qty: number; index: number }>();
  (ctx.input.items ?? []).forEach((l, i) => {
    const prev = now.get(l.itemId);
    now.set(l.itemId, { qty: (prev?.qty ?? 0) + (l.billedQty ?? l.qty), index: prev?.index ?? i });
  });
  let ok = true;
  for (const [itemId, r] of back) {
    const onBill = now.get(itemId)?.qty ?? 0;
    if (r.qty - onBill > 1e-9) {
      ctx.warn(
        'pos',
        `${trimQty(r.qty)} of '${ctx.masters.item(itemId).name}' came back on the returns of this bill; the bill cannot sell less (${trimQty(onBill)}). ${keep}`,
        'block',
        now.has(itemId) ? `items[${now.get(itemId)?.index ?? 0}].qty` : 'items',
      );
      ok = false;
    }
  }
  const inBooks = returns.filter((r) => r.affects_books === 1);
  const returnedValue = inBooks.reduce((a, r) => a + r.bill_value, 0);
  if (ok && billValue + RETURN_ROUNDING_SLACK * inBooks.length < returnedValue) {
    ctx.warn('pos', `The returns of this bill total ${rupees(returnedValue)}; the bill cannot be reduced to ${rupees(billValue)}. ${keep}`, 'block', 'items');
    ok = false;
  }
  return ok;
}

/** Return being altered: exchange credit already used on bills must still be issued, and not later than its use. */
function checkAlteredReturn(ctx: PostingAdjustContext, returnId: number, issuedNow: number): boolean {
  const db = ctx.env.db;
  const use = db.get<{ voucher_id: number; date: string }>(
    'SELECT voucher_id, date FROM pos_payments WHERE exchange_voucher_id = :id AND affects_books = 1 ORDER BY date, voucher_id LIMIT 1',
    { id: returnId },
  );
  if (!use) return true;
  const used = exchangeUsed(db, returnId);
  const label = voucherLabelOf(db, use.voucher_id);
  const fix = 'Cancel or alter the bill(s) that used it first.';
  if (issuedNow < used) {
    ctx.warn('pos', `${rupees(used)} of this return's exchange credit was used (first on ${label}); it cannot issue less (${rupees(issuedNow)}). ${fix}`, 'block', 'posBill.tenders');
    return false;
  }
  if (ctx.date > use.date) {
    ctx.warn('pos', `The exchange credit of this return was used on ${label}: the return cannot be dated after it. ${fix}`, 'block', 'date');
    return false;
  }
  return true;
}

const trimQty = (q: number): string => String(Math.round(q * 1000) / 1000);

/**
 * The POS block of a saved bill / return as it was saved (tenders, cash tendered, return of, counter).
 * Null when the voucher is not a POS bill.
 */
export function storedPosBill(db: Db, voucherId: number): VoucherPosInput | null {
  const b = db.get<{ cash_tendered: number | null; return_of_id: number | null; counter: string | null }>(
    'SELECT cash_tendered, return_of_id, counter FROM pos_bills WHERE voucher_id = :id',
    { id: voucherId },
  );
  if (!b) return null;
  const tenders: PosTenderInput[] = db
    .all<{ mode_id: number; amount: number; reference: string | null; exchange_voucher_id: number | null }>(
      'SELECT mode_id, amount, reference, exchange_voucher_id FROM pos_payments WHERE voucher_id = :id ORDER BY line_no',
      { id: voucherId },
    )
    .map((t) => ({
      modeId: t.mode_id,
      amount: Math.abs(t.amount),
      ...(t.reference !== null ? { reference: t.reference } : {}),
      ...(t.exchange_voucher_id !== null ? { exchangeVoucherId: t.exchange_voucher_id } : {}),
    }));
  return {
    tenders,
    ...(b.cash_tendered !== null ? { cashTendered: b.cash_tendered } : {}),
    ...(b.return_of_id !== null ? { returnOfId: b.return_of_id } : {}),
    ...(b.counter !== null ? { counter: b.counter } : {}),
  };
}

/**
 * Alteration made without the POS block (voucher entry screen, API, a return opened in Credit Note
 * alteration): the bill keeps its tenders and its link to the bill it returns — they are re-checked
 * against the altered voucher like on the counter — instead of silently losing them (which would drop
 * the bill from the POS summary and a return from the quantities already taken back).
 */
function compose(env: PostingEnv, input: VoucherInput, _vt: VoucherTypeInfo, voucherId: number | null): VoucherInput | undefined {
  if (voucherId === null || input.posBill) return undefined;
  const stored = storedPosBill(env.db, voucherId);
  return stored ? { ...input, posBill: stored } : undefined;
}

function validate(ctx: CompanyCtx, args: VoucherHookValidateArgs): void {
  const { input, existing } = args;
  if (input.posBill && !getFeatures(ctx.db).pos) throw validation([{ path: 'posBill', message: POS_OFF_MESSAGE }]);
  if (!input.posBill && existing) {
    const paid = ctx.db.value<number>('SELECT paid FROM pos_bills WHERE voucher_id = :id', { id: existing.id });
    if (paid !== undefined && paid > 0) {
      throw validation([
        {
          path: 'posBill',
          message: 'This is a POS bill paid by tenders: alter it on the POS counter, which keeps the tenders (F11 › POS invoicing must be on).',
        },
      ]);
    }
  }
}

function write(w: VoucherHookWriteContext): void {
  const data = w.data as PosStash | undefined;
  if (!data) return;
  const common = { v: w.voucherId, date: w.date, books: w.affectsBooks ? 1 : 0, pdc: w.isPostDated ? 1 : 0 };
  w.db.run(
    `INSERT INTO pos_bills (voucher_id, kind, return_of_id, bill_value, paid, credit, cash_tendered, change_due, counter, date, affects_books, is_post_dated)
     VALUES (:v, :kind, :ret, :value, :paid, :credit, :cashTendered, :change, :counter, :date, :books, :pdc)`,
    {
      ...common,
      kind: data.kind,
      ret: data.returnOfId,
      value: data.billValue,
      paid: data.paid,
      credit: data.credit,
      cashTendered: data.cashTendered,
      change: data.change,
      counter: data.counter,
    },
  );
  const s = data.kind === 'sale' ? 1 : -1;
  data.tenders.forEach((t, i) => {
    w.db.run(
      `INSERT INTO pos_payments (voucher_id, line_no, mode_id, mode_name, kind, ledger_id, amount, reference, exchange_voucher_id, date, affects_books, is_post_dated)
       VALUES (:v, :line, :mode, :name, :kind, :ledger, :amount, :ref, :ex, :date, :books, :pdc)`,
      { ...common, line: i + 1, mode: t.modeId, name: t.name, kind: t.kind, ledger: t.ledgerId, amount: s * t.amount, ref: t.reference, ex: t.exchangeVoucherId },
    );
  });
}

function clear(db: Db, voucherId: number): void {
  db.run('DELETE FROM pos_payments WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM pos_bills WHERE voucher_id = :id', { id: voucherId });
}

function beforeRemove(ctx: CompanyCtx, row: VoucherRow, action: 'delete' | 'cancel'): void {
  const { db } = ctx;
  const bill = db.get<{ kind: string }>('SELECT kind FROM pos_bills WHERE voucher_id = :id', { id: row.id });
  if (!bill) return;
  const verb = action === 'delete' ? 'deleted' : 'cancelled';
  if (bill.kind === 'sale') {
    const ret = db.get<{ voucher_id: number }>('SELECT voucher_id FROM pos_bills WHERE return_of_id = :id ORDER BY date, voucher_id LIMIT 1', { id: row.id });
    if (ret) throw rule(`Goods of this bill were returned on ${voucherLabelOf(db, ret.voucher_id)}. Cancel or delete the return first; then this bill can be ${verb}.`);
  } else {
    const use = db.get<{ voucher_id: number }>('SELECT voucher_id FROM pos_payments WHERE exchange_voucher_id = :id ORDER BY date, voucher_id LIMIT 1', { id: row.id });
    if (use) throw rule(`The exchange credit of this return was used on ${voucherLabelOf(db, use.voucher_id)}. Cancel or alter that bill first; then this return can be ${verb}.`);
  }
}

function preview(data: unknown): { posBill?: PosBillView } {
  return data ? { posBill: data as PosBillView } : {};
}

export const posVoucherHook: VoucherHook = { name: 'pos', compose, adjust, validate, write, clear, beforeRemove, preview };

/** Tender label for print / registers: 'UPI (Ref 4521)'. */
export function tenderLabel(name: string, kind: PosTenderKind, reference: string | null): string {
  const base = name || POS_TENDER_KIND_LABELS[kind];
  return reference ? `${base} (Ref ${reference})` : base;
}
