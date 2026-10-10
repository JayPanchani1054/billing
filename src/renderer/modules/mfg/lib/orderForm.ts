/**
 * Job Work Order form — pure state and mapping (tested in forms.test.ts).
 *   out  Job Work Out Order: we give work to a job worker (godown: 'Our stock with third party');
 *   in   Job Work In Order: a principal gives work to us (godown: 'Third-party stock with us').
 */
import type { JobWorkGoodsType } from '../../../../shared/mfg/jobwork.ts';
import type { JobWorkDirection, JobWorkOrderDetail, JobWorkOrderSaveInput, ThirdPartyKind } from '../../../../shared/types/mfg.ts';

export interface OrderRow {
  key: string;
  itemId: number | null;
  itemName: string;
  unit: string;
  decimals: number;
  qty: number | null;
  goodsType: JobWorkGoodsType;
}

export interface OrderForm {
  direction: JobWorkDirection;
  number: string;
  date: string;
  partyLedgerId: number | null;
  godownId: number | null;
  itemId: number | null;
  itemName: string;
  unit: string;
  decimals: number;
  qty: number | null;
  bomId: number | null;
  dueDate: string | null;
  process: string;
  rate: number | null;
  status: 'open' | 'closed';
  narration: string;
  rows: OrderRow[];
}

let seq = 0;
const key = (): string => `o${++seq}`;

export function blankOrderRow(over: Partial<OrderRow> = {}): OrderRow {
  return { key: key(), itemId: null, itemName: '', unit: '', decimals: 0, qty: null, goodsType: 'inputs', ...over };
}

export function emptyOrderForm(direction: JobWorkDirection, date: string): OrderForm {
  return {
    direction,
    number: '',
    date,
    partyLedgerId: null,
    godownId: null,
    itemId: null,
    itemName: '',
    unit: '',
    decimals: 0,
    qty: null,
    bomId: null,
    dueDate: null,
    process: '',
    rate: null,
    status: 'open',
    narration: '',
    rows: [blankOrderRow()],
  };
}

export function orderFormFrom(d: JobWorkOrderDetail): OrderForm {
  return {
    direction: d.direction,
    number: d.number,
    date: d.date,
    partyLedgerId: d.partyLedgerId,
    godownId: d.godownId,
    itemId: d.itemId,
    itemName: d.itemName ?? '',
    unit: d.unit ?? '',
    decimals: 3,
    qty: d.qty,
    bomId: d.bomId,
    dueDate: d.dueDate,
    process: d.process ?? '',
    rate: d.rate,
    status: d.status,
    narration: d.narration ?? '',
    rows: d.lines.map((l) => blankOrderRow({ itemId: l.itemId, itemName: l.itemName, unit: l.unit, decimals: 3, qty: l.qty, goodsType: l.goodsType })),
  };
}

/** The input to save, with the row key of each `lines[i]` (to show server errors next to the row). */
export function toOrderInput(form: OrderForm, alter?: { id: number; updatedAt: string }): { input: JobWorkOrderSaveInput | null; lineKeys: string[] } {
  if (form.partyLedgerId === null) return { input: null, lineKeys: [] };
  const filled = form.rows.filter((r) => r.itemId !== null && r.qty !== null && r.qty > 0);
  const input: JobWorkOrderSaveInput = {
    direction: form.direction,
    date: form.date,
    partyLedgerId: form.partyLedgerId,
    godownId: form.godownId,
    itemId: form.itemId,
    qty: form.itemId !== null ? form.qty : null,
    bomId: form.itemId !== null ? form.bomId : null,
    dueDate: form.dueDate,
    process: form.process.trim() || null,
    rate: form.rate,
    status: form.status,
    narration: form.narration.trim() || null,
    lines: filled.map((r) => ({ itemId: r.itemId as number, qty: r.qty as number, goodsType: r.goodsType })),
  };
  if (form.number.trim()) input.number = form.number.trim();
  if (alter) {
    input.id = alter.id;
    input.expectedUpdatedAt = alter.updatedAt;
  }
  return { input, lineKeys: filled.map((r) => r.key) };
}

/** `lines[1].qty` → that row; header paths stay fields; anything else is a general message. */
export function mapOrderErrors(errors: Readonly<Record<string, string>>, lineKeys: readonly string[]): { rows: Map<string, string>; fields: Record<string, string>; general: string[] } {
  const rows = new Map<string, string>();
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const [path, msg] of Object.entries(errors)) {
    const m = /^lines\[(\d+)\]/.exec(path) ?? /^lines\.(\d+)/.exec(path);
    if (m && lineKeys[Number(m[1])]) rows.set(lineKeys[Number(m[1])], msg);
    else if (/^(number|date|partyLedgerId|godownId|itemId|qty|bomId|dueDate|process|rate|narration)$/.test(path)) fields[path] = msg;
    else general.push(msg);
  }
  return { rows, fields, general };
}

/** The godown kind an order of this direction uses. */
export const ORDER_GODOWN_KIND: Readonly<Record<JobWorkDirection, ThirdPartyKind>> = { out: 'ours_with_party', in: 'party_with_us' };

export const ORDER_TITLES: Readonly<Record<JobWorkDirection, { one: string; many: string; party: string }>> = {
  out: { one: 'Job Work Out Order', many: 'Job Work Out Orders', party: 'Job worker' },
  in: { one: 'Job Work In Order', many: 'Job Work In Orders', party: 'Principal' },
};

/** The party's job work godown of the right kind (the first one), for a new order or challan. */
export function godownForParty<G extends { id: number; kind: ThirdPartyKind; partyLedgerId: number | null }>(godowns: readonly G[], partyLedgerId: number | null, kind: ThirdPartyKind | null): G | null {
  if (partyLedgerId === null) return null;
  return godowns.find((g) => g.partyLedgerId === partyLedgerId && (kind === null ? g.kind !== 'none' : g.kind === kind)) ?? null;
}
