/**
 * Payment at the counter — pure logic (tested in tender.test.ts). One row per tender mode; the
 * "balance" row (cash by default) takes whatever the other rows leave, until the cashier types into it.
 * Cash handed over (cash tendered) gives the change. A walk-in bill must be paid in full; a
 * customer's bill may leave the rest on account (credit).
 */
import type { Paise } from '../../../../shared/money.ts';
import type { PosTenderKind, PosTenderMode, VoucherPosInput } from '../../../../shared/types/pos.ts';
import type { VoucherWarning } from '../../../../shared/types/vouchers.ts';
import { formatMoney } from '../../../../shared/format.ts';

export interface TenderRow {
  modeId: number;
  name: string;
  kind: PosTenderKind;
  amount: Paise;
  reference: string;
  /** Exchange mode on a bill: the POS return whose credit is used. */
  exchangeVoucherId?: number;
}

export interface TenderState {
  rows: TenderRow[];
  /** Index of the row that absorbs the balance (−1: none). */
  balanceIndex: number;
  /** Cash handed over by the customer (null: exact). */
  cashTendered: Paise | null;
}

export interface TenderSummary {
  due: Paise;
  paid: Paise;
  /** due − paid when positive: left on the customer's account (or unpaid on a walk-in bill). */
  credit: Paise;
  cash: Paise;
  change: Paise;
  problems: string[];
  ok: boolean;
}

const rupees = (p: Paise): string => `₹ ${formatMoney(p)}`;

/**
 * Starting rows: every active mode except exchange credit (added only when the counter brings one),
 * the whole bill on the first cash mode (else the first mode). `exchange` pre-fills exchange credit
 * from a return (exchange flow), capped at the bill.
 */
export function initialTenders(modes: readonly PosTenderMode[], due: Paise, exchange?: { modeId: number; name: string; voucherId: number; amount: Paise }): TenderState {
  const rows: TenderRow[] = modes.filter((m) => m.isActive && m.kind !== 'exchange').map((m) => ({ modeId: m.id, name: m.name, kind: m.kind, amount: 0, reference: '' }));
  let rest = due;
  if (exchange) {
    const amount = Math.min(exchange.amount, Math.max(0, due));
    rows.push({ modeId: exchange.modeId, name: exchange.name, kind: 'exchange', amount, reference: '', exchangeVoucherId: exchange.voucherId });
    rest -= amount;
  }
  const cashIndex = rows.findIndex((r) => r.kind === 'cash');
  const balanceIndex = cashIndex >= 0 ? cashIndex : rows.length > 0 ? 0 : -1;
  if (balanceIndex >= 0) rows[balanceIndex] = { ...rows[balanceIndex], amount: Math.max(0, rest) };
  return { rows, balanceIndex, cashTendered: null };
}

/**
 * Rows of a saved bill being altered: its tenders as saved (modes no longer active kept, exchange rows
 * with their return), no automatic balance (the cashier sees exactly what was taken).
 */
export function tendersFromSaved(modes: readonly PosTenderMode[], saved: VoucherPosInput): TenderState {
  const byId = new Map(modes.map((m) => [m.id, m]));
  const rows: TenderRow[] = modes.filter((m) => m.isActive && m.kind !== 'exchange').map((m) => ({ modeId: m.id, name: m.name, kind: m.kind, amount: 0, reference: '' }));
  for (const t of saved.tenders) {
    const m = byId.get(t.modeId);
    const i = t.exchangeVoucherId === undefined ? rows.findIndex((r) => r.modeId === t.modeId && r.kind !== 'exchange') : -1;
    if (i >= 0 && rows[i].amount === 0) rows[i] = { ...rows[i], amount: t.amount, reference: t.reference ?? '' };
    else rows.push({ modeId: t.modeId, name: m?.name ?? 'Tender', kind: m?.kind ?? 'other', amount: t.amount, reference: t.reference ?? '', ...(t.exchangeVoucherId !== undefined ? { exchangeVoucherId: t.exchangeVoucherId } : {}) });
  }
  return { rows, balanceIndex: -1, cashTendered: saved.cashTendered ?? null };
}

/** Put what the other rows leave on the balance row (never below zero). */
export function rebalance(state: TenderState, due: Paise): TenderState {
  if (state.balanceIndex < 0) return state;
  const others = state.rows.reduce((a, r, i) => (i === state.balanceIndex ? a : a + r.amount), 0);
  const rows = [...state.rows];
  rows[state.balanceIndex] = { ...rows[state.balanceIndex], amount: Math.max(0, due - others) };
  return { ...state, rows };
}

/**
 * The cashier typed an amount on a row: other rows than the balance row rebalance it; typing on the
 * balance row itself stops the automatic balance (the rest then shows as credit / unpaid).
 */
export function setTenderAmount(state: TenderState, index: number, amount: Paise, due: Paise): TenderState {
  if (!state.rows[index]) return state;
  const rows = [...state.rows];
  rows[index] = { ...rows[index], amount: Math.max(0, Math.round(amount)) };
  if (index === state.balanceIndex) return { ...state, rows, balanceIndex: -1 };
  return rebalance({ ...state, rows }, due);
}

export function setTenderReference(state: TenderState, index: number, reference: string): TenderState {
  if (!state.rows[index]) return state;
  const rows = [...state.rows];
  rows[index] = { ...rows[index], reference };
  return { ...state, rows };
}

/**
 * Use exchange credit of a POS return on this bill: a row for that return (replacing one already
 * there for it), at most the credit available and what is still due after the other non-balance rows.
 */
export function addExchangeRow(state: TenderState, ex: { modeId: number; name: string; voucherId: number; available: Paise }, due: Paise): TenderState {
  const rows = state.rows.filter((r) => !(r.kind === 'exchange' && r.exchangeVoucherId === ex.voucherId));
  const balanceRow = state.balanceIndex >= 0 ? state.rows[state.balanceIndex] : undefined;
  const others = rows.reduce((a, r) => (r === balanceRow ? a : a + r.amount), 0);
  const amount = Math.max(0, Math.min(ex.available, due - others));
  rows.push({ modeId: ex.modeId, name: ex.name, kind: 'exchange', amount, reference: '', exchangeVoucherId: ex.voucherId });
  const balanceIndex = balanceRow ? rows.indexOf(balanceRow) : -1;
  return rebalance({ ...state, rows, balanceIndex }, due);
}

/** Put the whole remaining bill on one row (e.g. "all by UPI"). */
export function payRestBy(state: TenderState, index: number, due: Paise): TenderState {
  if (!state.rows[index]) return state;
  const rows = state.rows.map((r, i) => (i === index ? r : { ...r, amount: i === state.balanceIndex ? 0 : r.amount }));
  const others = rows.reduce((a, r, i) => (i === index ? a : a + r.amount), 0);
  rows[index] = { ...rows[index], amount: Math.max(0, due - others) };
  return { ...state, rows, balanceIndex: index };
}

export function summarizeTenders(state: TenderState, due: Paise, opts: { walkIn: boolean; isReturn?: boolean }): TenderSummary {
  const paid = state.rows.reduce((a, r) => a + r.amount, 0);
  const cash = state.rows.filter((r) => r.kind === 'cash').reduce((a, r) => a + r.amount, 0);
  const problems: string[] = [];
  if (paid > due) problems.push(`${opts.isReturn ? 'The refund' : 'The payment'} (${rupees(paid)}) is more than the ${opts.isReturn ? 'return' : 'bill'} (${rupees(due)}) by ${rupees(paid - due)}.`);
  const credit = Math.max(0, due - paid);
  if (credit > 0 && opts.walkIn) {
    problems.push(
      opts.isReturn
        ? `${rupees(credit)} is not refunded. Refund it in full, or give exchange credit.`
        : `${rupees(credit)} is not paid. A walk-in bill is paid in full — or choose the customer (Alt+U) to sell on credit.`,
    );
  }
  let change = 0;
  if (state.cashTendered !== null && !opts.isReturn) {
    if (cash === 0 && state.cashTendered > 0) problems.push('Cash handed over, but nothing is paid in cash.');
    else if (state.cashTendered < cash) problems.push(`Cash handed over (${rupees(state.cashTendered)}) is less than the cash on the bill (${rupees(cash)}).`);
    else change = state.cashTendered - cash;
  }
  for (const r of state.rows) if (r.kind === 'exchange' && r.amount > 0 && r.exchangeVoucherId === undefined && !opts.isReturn) problems.push('Choose the return whose exchange credit is used.');
  return { due, paid, credit, cash, change, problems, ok: problems.length === 0 && due >= 0 };
}

/** The posBill block for the voucher (rows with an amount only). */
export function toPosBill(state: TenderState, extra: { counter?: string; returnOfId?: number; isReturn?: boolean } = {}): VoucherPosInput {
  const counter = (extra.counter ?? '').trim();
  const out: VoucherPosInput = {
    tenders: state.rows
      .filter((r) => r.amount > 0)
      .map((r) => ({
        modeId: r.modeId,
        amount: r.amount,
        ...(r.reference.trim() ? { reference: r.reference.trim() } : {}),
        ...(r.kind === 'exchange' && r.exchangeVoucherId !== undefined && !extra.isReturn ? { exchangeVoucherId: r.exchangeVoucherId } : {}),
      })),
  };
  if (state.cashTendered !== null && !extra.isReturn) out.cashTendered = state.cashTendered;
  if (counter) out.counter = counter;
  if (extra.returnOfId !== undefined) out.returnOfId = extra.returnOfId;
  return out;
}

/** Quick "cash handed over" amounts: exact, then the next round ₹10 / ₹50 / ₹100 / ₹500 / ₹2,000 above it. */
export function quickCash(cash: Paise): Paise[] {
  if (cash <= 0) return [];
  const out = new Set<number>([cash]);
  for (const note of [10_00, 50_00, 100_00, 500_00, 2000_00]) {
    const up = Math.ceil(cash / note) * note;
    if (up > cash) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

/** Is the reference worth asking for (card slip / UPI transaction)? */
export const wantsReference = (kind: PosTenderKind): boolean => kind === 'card' || kind === 'upi' || kind === 'wallet';

/** A pos warning that only concerns the payment (decided in the payment dialog, not on the bill). */
const isTenderWarning = (w: Pick<VoucherWarning, 'code' | 'path'>): boolean =>
  w.code === 'pos' && (w.path === undefined || w.path.startsWith('posBill.tenders') || w.path === 'posBill.cashTendered' || w.path === 'posBill');

/**
 * Blocking warnings of the bill / return itself, from a preview made with no tenders yet: everything
 * that blocks except what the payment will settle ("not paid in full", tender checks). Kept: the
 * engine's own blocks and the pos checks on goods, customer, date and the bill returned (e.g. a return
 * above what is left on the bill, or an altered bill selling less than came back).
 */
export function billBlockers<W extends Pick<VoucherWarning, 'code' | 'path' | 'blocking'>>(warnings: readonly W[]): W[] {
  return warnings.filter((w) => w.blocking && !isTenderWarning(w));
}
