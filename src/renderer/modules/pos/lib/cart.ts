/**
 * POS counter cart — pure logic (tested in cart.test.ts): what a scan does to the bill, prices by
 * quantity (price-level slabs), line values, MRP, and the VoucherInput the counter sends.
 *
 * Scanner input: a USB / Bluetooth barcode scanner "types" the code and presses Enter. `3*8901…`
 * (or `3 x 8901…`) scans three at once. Scanning an item already on the bill adds to that line,
 * unless the line's rate or discount was changed by hand or it is batch-wise (then a new line).
 */
import { lineAmount, roundTo, type Paise } from '../../../../shared/money.ts';
import type { PosDraft, PosItem, PosPriceSlab, VoucherPosInput } from '../../../../shared/types/pos.ts';
import type { ItemLineInput, VoucherInput } from '../../../../shared/types/vouchers.ts';

export interface CartLine {
  /** Stable key for React and selection. */
  key: string;
  itemId: number;
  name: string;
  unit: string;
  unitDecimals: number;
  qty: number;
  /** Rupees per base unit (as the item / price list gives it, or typed). */
  rate: number;
  discountPct: number;
  /** The cashier changed rate or discount: re-pricing by quantity no longer applies. */
  priceEdited: boolean;
  /** Paise per unit, incl. taxes; null when the item has none. */
  mrp: Paise | null;
  sellingRate: number;
  slabs: PosPriceSlab[];
  rateInclusiveOfTax: boolean;
  maintainBatches: boolean;
  batchName?: string;
  /** On hand when scanned (null for services). */
  stock: number | null;
}

export interface ParsedScan {
  qty: number;
  code: string;
}

/** "3*8901234" / "3 x 8901234" / "1.5*rice" → qty + code; plain text → qty 1. Empty → null. */
export function parseScan(text: string): ParsedScan | null {
  const t = text.trim();
  if (t === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*[*xX×]\s*(.+)$/.exec(t);
  if (m) {
    const qty = Number(m[1]);
    const code = m[2].trim();
    if (qty > 0 && code !== '') return { qty, code };
  }
  return { qty: 1, code: t };
}

/** Quantity rounded to the unit's decimals (Nos: whole numbers). */
export function roundQty(qty: number, decimals: number): number {
  return roundTo(qty, Math.max(0, Math.min(6, decimals)));
}

/** Price for a quantity: the price-level slab covering it, else the item's selling price. */
export function priceFor(item: Pick<PosItem, 'slabs' | 'sellingRate'>, qty: number): { rate: number; discountPct: number } {
  const q = Math.abs(qty);
  for (const s of item.slabs) if (q >= s.qtyFrom - 1e-9 && (s.qtyTo === null || q < s.qtyTo - 1e-9)) return { rate: s.rate, discountPct: s.discountPct };
  return { rate: item.sellingRate, discountPct: 0 };
}

let keySeq = 0;
const nextKey = (): string => `l${++keySeq}`;

export function lineFromItem(item: PosItem, qty: number): CartLine {
  const q = roundQty(qty, item.unitDecimals);
  const p = priceFor(item, q);
  return {
    key: nextKey(),
    itemId: item.itemId,
    name: item.name,
    unit: item.unit,
    unitDecimals: item.unitDecimals,
    qty: q,
    rate: p.rate,
    discountPct: p.discountPct,
    priceEdited: false,
    mrp: item.mrp,
    sellingRate: item.sellingRate,
    slabs: item.slabs,
    rateInclusiveOfTax: item.rateInclusiveOfTax,
    maintainBatches: item.maintainBatches,
    stock: item.stock,
  };
}

/** Re-price a line for its quantity unless the cashier set the price. */
function repriced(l: CartLine): CartLine {
  if (l.priceEdited) return l;
  const p = priceFor(l, l.qty);
  return p.rate === l.rate && p.discountPct === l.discountPct ? l : { ...l, rate: p.rate, discountPct: p.discountPct };
}

/**
 * Add a scanned item: the same item scanned again adds to its last line (re-priced by the new
 * quantity) unless that line has a hand-set price or a batch; otherwise a new line at the end.
 * Returns the new lines and the index of the line that changed.
 */
export function addScanned(lines: readonly CartLine[], item: PosItem, qty: number): { lines: CartLine[]; index: number } {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.itemId !== item.itemId) continue;
    if (l.priceEdited || l.maintainBatches) break;
    const next = [...lines];
    next[i] = repriced({ ...l, qty: roundQty(l.qty + qty, l.unitDecimals) });
    return { lines: next, index: i };
  }
  return { lines: [...lines, lineFromItem(item, qty)], index: lines.length };
}

export function setQty(lines: readonly CartLine[], index: number, qty: number): CartLine[] {
  const l = lines[index];
  if (!l) return [...lines];
  const next = [...lines];
  next[index] = repriced({ ...l, qty: roundQty(Math.max(0, qty), l.unitDecimals) });
  return next;
}

/** +1 / −1 on the selected line (a line brought to 0 is removed). */
export function stepQty(lines: readonly CartLine[], index: number, delta: number): CartLine[] {
  const l = lines[index];
  if (!l) return [...lines];
  const q = roundQty(l.qty + delta, l.unitDecimals);
  return q <= 0 ? removeLine(lines, index) : setQty(lines, index, q);
}

export function setPrice(lines: readonly CartLine[], index: number, rate: number, discountPct: number): CartLine[] {
  const l = lines[index];
  if (!l) return [...lines];
  const next = [...lines];
  const changed = rate !== l.rate || discountPct !== l.discountPct;
  next[index] = { ...l, rate: Math.max(0, rate), discountPct: Math.min(100, Math.max(0, discountPct)), priceEdited: l.priceEdited || changed };
  return next;
}

export function setBatch(lines: readonly CartLine[], index: number, batchName: string): CartLine[] {
  const l = lines[index];
  if (!l) return [...lines];
  const next = [...lines];
  const b = batchName.trim();
  next[index] = { ...l, ...(b ? { batchName: b } : { batchName: undefined }) };
  return next;
}

export function removeLine(lines: readonly CartLine[], index: number): CartLine[] {
  return lines.filter((_, i) => i !== index);
}

/** Line value before tax, as entered (an inclusive rate is converted by the engine). */
export function lineValue(l: Pick<CartLine, 'qty' | 'rate' | 'discountPct'>): Paise {
  return lineAmount(l.qty, l.rate, l.discountPct);
}

/** MRP × qty of a line (paise), or null. */
export function lineMrp(l: Pick<CartLine, 'qty' | 'mrp'>): Paise | null {
  return l.mrp === null ? null : Math.round(l.mrp * l.qty);
}

export function totalQty(lines: readonly CartLine[]): number {
  return lines.reduce((a, l) => a + l.qty, 0);
}

/** Lines the bill sends (zero quantities dropped). */
export function billLines(lines: readonly CartLine[], godownId: number | null): ItemLineInput[] {
  return lines
    .filter((l) => l.qty > 0)
    .map((l) => ({
      itemId: l.itemId,
      qty: l.qty,
      rate: l.rate,
      ...(l.discountPct ? { discountPct: l.discountPct } : {}),
      ...(godownId !== null ? { godownId } : {}),
      ...(l.batchName ? { batchName: l.batchName } : {}),
    }));
}

export interface BillHeader {
  voucherTypeId: number;
  date: string;
  partyLedgerId: number;
  placeOfSupply: string | null;
  priceLevelId: number | null;
  godownId: number | null;
  narration?: string;
  /** Alteration of a saved bill. */
  id?: number;
  expectedUpdatedAt?: string;
}

/** The voucher the counter previews / saves: a Sales voucher in item-invoice mode with `posBill`. */
export function buildBillInput(h: BillHeader, lines: readonly CartLine[], posBill: VoucherPosInput): VoucherInput {
  const narration = (h.narration ?? '').trim();
  return {
    ...(h.id !== undefined ? { id: h.id } : {}),
    ...(h.expectedUpdatedAt ? { expectedUpdatedAt: h.expectedUpdatedAt } : {}),
    voucherTypeId: h.voucherTypeId,
    date: h.date,
    mode: 'item_invoice',
    partyLedgerId: h.partyLedgerId,
    ...(h.placeOfSupply ? { placeOfSupply: h.placeOfSupply } : {}),
    ...(h.priceLevelId !== null ? { priceLevelId: h.priceLevelId } : {}),
    ...(narration ? { narration } : {}),
    items: billLines(lines, h.godownId),
    posBill,
  };
}

/** A held bill's draft from the counter. */
export function toDraft(voucherTypeId: number, lines: readonly CartLine[], customer: { ledgerId: number; name: string; mobile: string | null } | null, placeOfSupply: string | null): PosDraft {
  return {
    voucherTypeId,
    ...(customer ? { partyLedgerId: customer.ledgerId, customerName: customer.name, ...(customer.mobile ? { customerMobile: customer.mobile } : {}) } : {}),
    ...(placeOfSupply ? { placeOfSupply } : {}),
    lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, rate: l.rate, ...(l.discountPct ? { discountPct: l.discountPct } : {}), ...(l.batchName ? { batchName: l.batchName } : {}) })),
  };
}

/**
 * Lines back from a held draft or a saved bill, given the items looked up again (current name, MRP,
 * slabs). The rate kept is the one on the draft / bill, marked as set (never silently re-priced).
 */
export function linesFromDraft(draft: Pick<PosDraft, 'lines'>, items: ReadonlyMap<number, PosItem>): { lines: CartLine[]; missing: number[] } {
  const out: CartLine[] = [];
  const missing: number[] = [];
  for (const d of draft.lines) {
    const item = items.get(d.itemId);
    if (!item) {
      missing.push(d.itemId);
      continue;
    }
    const base = lineFromItem(item, d.qty);
    const p = priceFor(item, base.qty);
    out.push({
      ...base,
      rate: d.rate,
      discountPct: d.discountPct ?? 0,
      priceEdited: d.rate !== p.rate || (d.discountPct ?? 0) !== p.discountPct,
      ...(d.batchName ? { batchName: d.batchName } : {}),
    });
  }
  return { lines: out, missing };
}

/**
 * Place of supply of a recalled held bill: a draft held with the goods delivered to the customer in
 * another state keeps that (IGST) choice; otherwise the counter's state applies.
 */
export function deliveryFromDraft(draft: Pick<PosDraft, 'partyLedgerId' | 'placeOfSupply'>, companyState: string | null, walkInId: number | null): { stateCode: string | null; deliver: boolean } {
  const customer = draft.partyLedgerId !== undefined && draft.partyLedgerId !== walkInId;
  const pos = draft.placeOfSupply ?? null;
  if (!customer || pos === null || pos === companyState) return { stateCode: null, deliver: false };
  return { stateCode: pos, deliver: true };
}
