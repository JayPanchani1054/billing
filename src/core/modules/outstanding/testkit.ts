/**
 * Test helpers for the outstanding module: write vouchers + ledger_entries + bill_allocations rows the
 * way the posting engine does (denormalised date / affects_books / is_post_dated, allocations signed
 * like their ledger entry). Used only by *.test.ts files in this folder.
 */
import { randomUUID } from 'node:crypto';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { addDays } from '../../../shared/dates.ts';
import type { TestCompany } from '../../testing/fixtures.ts';

export interface BillSpec {
  ref: 'new' | 'against' | 'advance' | 'on_account';
  name?: string;
  /** Magnitude; the stored sign follows the ledger entry. */
  amount: number;
  creditDays?: number;
  /** Default for 'new' refs with creditDays: voucher date + creditDays (like the posting engine). */
  dueDate?: string;
}

export interface EntrySpec {
  ledgerId: number;
  /** Signed: Dr +, Cr −. */
  amount: number;
  bills?: BillSpec[];
  role?: string;
}

export interface PostSpec {
  type: VoucherBaseType;
  date: string;
  number?: string;
  entries: EntrySpec[];
  optional?: boolean;
  cancelled?: boolean;
  postDated?: boolean;
  narration?: string;
  referenceNo?: string;
  partyLedgerId?: number;
}

/** Insert a voucher with its entries and bill allocations. Returns the voucher id. */
export function post(t: TestCompany, spec: PostSpec): number {
  const sum = spec.entries.reduce((a, e) => a + e.amount, 0);
  if (sum !== 0) throw new Error(`post: voucher ${spec.number ?? ''} is not balanced (${sum})`);
  const affects = spec.optional || spec.cancelled ? 0 : 1;
  const pdc = spec.postDated ? 1 : 0;
  const ts = t.clock.now().toISOString();
  const total = spec.entries.reduce((a, e) => a + (e.amount > 0 ? e.amount : 0), 0);
  return t.db.transaction(() => {
    const vid = t.db.run(
      `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, date, reference_no, party_ledger_id, is_optional, is_post_dated,
                             is_cancelled, affects_books, narration, total_amount, created_at, updated_at)
       VALUES (:guid, :vt, :bt, :no, :date, :ref, :party, :opt, :pdc, :cancel, :affects, :narr, :total, :ts, :ts)`,
      {
        guid: randomUUID(),
        vt: t.ids.voucherTypes[spec.type],
        bt: spec.type,
        no: spec.number ?? null,
        date: spec.date,
        ref: spec.referenceNo ?? null,
        party: spec.partyLedgerId ?? null,
        opt: spec.optional ? 1 : 0,
        pdc,
        cancel: spec.cancelled ? 1 : 0,
        affects,
        narr: spec.narration ?? null,
        total,
        ts,
      },
    ).lastInsertRowid;
    spec.entries.forEach((e, i) => {
      const leId = t.db.run(
        `INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, role, date, affects_books, is_post_dated)
         VALUES (:vid, :line, :ledger, :amount, :role, :date, :affects, :pdc)`,
        { vid, line: i + 1, ledger: e.ledgerId, amount: e.amount, role: e.role ?? 'other', date: spec.date, affects, pdc },
      ).lastInsertRowid;
      if (!e.bills) return;
      const billSum = e.bills.reduce((a, b) => a + b.amount, 0);
      if (billSum !== Math.abs(e.amount)) throw new Error(`post: bill allocations ${billSum} ≠ entry ${e.amount}`);
      const sign = e.amount < 0 ? -1 : 1;
      for (const b of e.bills) {
        const due = b.dueDate ?? (b.ref === 'new' && b.creditDays !== undefined ? addDays(spec.date, b.creditDays) : null);
        t.db.run(
          `INSERT INTO bill_allocations (voucher_id, ledger_entry_id, ledger_id, ref_type, bill_name, amount, credit_days, due_date, date,
                                         affects_books, is_post_dated)
           VALUES (:vid, :le, :ledger, :ref, :name, :amount, :cd, :due, :date, :affects, :pdc)`,
          {
            vid,
            le: leId,
            ledger: e.ledgerId,
            ref: b.ref,
            name: b.ref === 'on_account' ? null : (b.name ?? null),
            amount: sign * b.amount,
            cd: b.creditDays ?? null,
            due,
            date: spec.date,
            affects,
            pdc,
          },
        );
      }
    });
    return vid;
  });
}

interface Common {
  date: string;
  no: string;
  amount: number;
  optional?: boolean;
  cancelled?: boolean;
  postDated?: boolean;
  narration?: string;
}

/** Sales invoice: Dr party (new ref = invoice number unless `bills` given; null = no allocations) / Cr Sales. */
export function sale(t: TestCompany, party: number, o: Common & { creditDays?: number; dueDate?: string; bills?: BillSpec[] | null }): number {
  const bills =
    o.bills === null ? undefined : (o.bills ?? [{ ref: 'new' as const, name: o.no, amount: o.amount, creditDays: o.creditDays, dueDate: o.dueDate }]);
  return post(t, {
    type: 'sales',
    date: o.date,
    number: o.no,
    partyLedgerId: party,
    optional: o.optional,
    cancelled: o.cancelled,
    postDated: o.postDated,
    narration: o.narration,
    entries: [
      { ledgerId: party, amount: o.amount, bills, role: 'party' },
      { ledgerId: t.ids.ledgers.SALES, amount: -o.amount, role: 'sales' },
    ],
  });
}

/** Receipt: Dr Cash / Cr party with the given allocations (default: on account). */
export function receipt(t: TestCompany, party: number, o: Common & { bills?: BillSpec[]; billWise?: boolean }): number {
  const bills = o.billWise === false ? undefined : (o.bills ?? [{ ref: 'on_account' as const, amount: o.amount }]);
  return post(t, {
    type: 'receipt',
    date: o.date,
    number: o.no,
    optional: o.optional,
    cancelled: o.cancelled,
    postDated: o.postDated,
    narration: o.narration,
    entries: [
      { ledgerId: t.ids.ledgers.CASH, amount: o.amount, role: 'cash_bank' },
      { ledgerId: party, amount: -o.amount, bills, role: 'party' },
    ],
  });
}

/** Credit note: Dr Sales / Cr party. */
export function creditNote(t: TestCompany, party: number, o: Common & { bills?: BillSpec[] }): number {
  return post(t, {
    type: 'credit_note',
    date: o.date,
    number: o.no,
    narration: o.narration,
    entries: [
      { ledgerId: t.ids.ledgers.SALES, amount: o.amount, role: 'sales' },
      { ledgerId: party, amount: -o.amount, bills: o.bills, role: 'party' },
    ],
  });
}

/** Purchase invoice: Dr Purchase / Cr supplier (new ref = supplier bill number unless `bills` given; null = none). */
export function purchase(t: TestCompany, party: number, o: Common & { creditDays?: number; dueDate?: string; bills?: BillSpec[] | null }): number {
  const bills =
    o.bills === null ? undefined : (o.bills ?? [{ ref: 'new' as const, name: o.no, amount: o.amount, creditDays: o.creditDays, dueDate: o.dueDate }]);
  return post(t, {
    type: 'purchase',
    date: o.date,
    number: o.no,
    referenceNo: o.no,
    partyLedgerId: party,
    optional: o.optional,
    cancelled: o.cancelled,
    postDated: o.postDated,
    entries: [
      { ledgerId: t.ids.ledgers.PURCHASE, amount: o.amount, role: 'purchase' },
      { ledgerId: party, amount: -o.amount, bills, role: 'party' },
    ],
  });
}

/** Payment: Dr supplier / Cr Cash. */
export function payment(t: TestCompany, party: number, o: Common & { bills?: BillSpec[]; billWise?: boolean }): number {
  const bills = o.billWise === false ? undefined : (o.bills ?? [{ ref: 'on_account' as const, amount: o.amount }]);
  return post(t, {
    type: 'payment',
    date: o.date,
    number: o.no,
    optional: o.optional,
    cancelled: o.cancelled,
    postDated: o.postDated,
    entries: [
      { ledgerId: party, amount: o.amount, bills, role: 'party' },
      { ledgerId: t.ids.ledgers.CASH, amount: -o.amount, role: 'cash_bank' },
    ],
  });
}

/** ₹ → paise for readable tests: rs(1_00_000) = 1,00,00,000 paise. */
export const rs = (rupees: number): number => Math.round(rupees * 100);
