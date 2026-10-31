/**
 * Notes and orders (README §3 › Tracking): what other documents bill or fulfil is matched per reference +
 * item and applied to the lines of the note / order. Pure; `vouchers.trackingRefs` (queries.ts) and the
 * documents module's Bills Pending / "Invoice now" (documents/billsPending.ts) share it.
 *
 * 2.2: a billing line carrying a source line's own description — the IDENTICAL text, as Alt+T and "Invoice
 * now" copy it — is applied to that line first, so a note billed out of line order (SN-222 before SN-111,
 * Red 3 of 5 with Blue 5) leaves the right line pending. Whatever no line's text claims — billed without a
 * description, under an edited text, or beyond the line's quantity — is then applied in line order (FIFO),
 * as before. Billing without descriptions is therefore exactly the earlier rule.
 */

/** Quantity billed per reference + item key, and the part of it billed under each line text. */
export interface BilledQty {
  readonly total: Map<string, number>;
  readonly byText: Map<string, Map<string, number>>;
}

export function billedQty(): BilledQty {
  return { total: new Map(), byText: new Map() };
}

/** Add what one group of billing lines took (`description`: their own text; null or '' when none). */
export function addBilled(b: BilledQty, key: string, description: string | null, qty: number): void {
  b.total.set(key, (b.total.get(key) ?? 0) + qty);
  if (!description) return;
  let texts = b.byText.get(key);
  if (!texts) {
    texts = new Map();
    b.byText.set(key, texts);
  }
  texts.set(description, (texts.get(description) ?? 0) + qty);
}

/** A line of a note / order: its reference + item key (the one `addBilled` used), quantity and own text. */
export interface TrackedLine {
  key: string;
  qty: number;
  description: string | null;
}

/**
 * What each line has billed and what is left pending, in the order of `lines` — which must be the line
 * order of the documents (date, voucher, line). `billed` is not changed.
 */
export function applyBilled(lines: readonly TrackedLine[], billed: BilledQty): Array<{ billed: number; pending: number }> {
  const total = new Map(billed.total);
  const texts = new Map([...billed.byText].map(([key, m]) => [key, new Map(m)] as const));
  // 1. A described line first takes what was billed under its own text.
  const own = lines.map((l) => {
    if (!l.description) return 0;
    const m = texts.get(l.key);
    const avail = m?.get(l.description) ?? 0;
    const take = Math.min(avail, l.qty);
    if (!m || take <= 0) return 0;
    m.set(l.description, avail - take);
    total.set(l.key, (total.get(l.key) ?? 0) - take);
    return take;
  });
  // 2. The rest of the reference + item, in line order.
  return lines.map((l, i) => {
    const rest = l.qty - own[i];
    const left = total.get(l.key) ?? 0;
    const take = Math.max(0, Math.min(left, rest));
    total.set(l.key, left - take);
    return { billed: own[i] + take, pending: rest - take };
  });
}
