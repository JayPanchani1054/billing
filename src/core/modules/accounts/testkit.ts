/**
 * Test helpers for the accounts module: insert vouchers + ledger_entries directly (the posting engine
 * belongs to the vouchers module), so balance and "in use" rules can be tested in isolation.
 */
import { randomUUID } from 'node:crypto';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { TestCompany } from '../../testing/fixtures.ts';

export interface RawVoucher {
  date: string;
  /** [ledgerId, amount (paise, Dr +, Cr −)] — must sum to 0. */
  lines: Array<[number, number]>;
  baseType?: VoucherBaseType;
  voucherTypeId?: number;
  number?: string;
  optional?: boolean;
  cancelled?: boolean;
  postDated?: boolean;
  partyLedgerId?: number;
}

/** Insert a voucher with its ledger entries (denormalised flags as the posting engine writes them). */
export function postRaw(t: TestCompany, v: RawVoucher): number {
  const sum = v.lines.reduce((s, [, a]) => s + a, 0);
  if (sum !== 0) throw new Error(`postRaw: entries sum to ${sum}, not 0`);
  const affects = !(v.optional || v.cancelled);
  const ts = t.clock.now().toISOString();
  const voucherId = t.db.run(
    `INSERT INTO vouchers (guid, voucher_type_id, base_type, number, date, party_ledger_id, is_optional, is_post_dated, is_cancelled,
                           affects_books, created_at, updated_at)
     VALUES (:guid, :vt, :base, :number, :date, :party, :opt, :pd, :cancel, :affects, :ts, :ts)`,
    {
      guid: randomUUID(),
      vt: v.voucherTypeId ?? t.ids.voucherTypes[v.baseType ?? 'journal'],
      base: v.baseType ?? 'journal',
      number: v.number ?? null,
      date: v.date,
      party: v.partyLedgerId ?? null,
      opt: v.optional ?? false,
      pd: v.postDated ?? false,
      cancel: v.cancelled ?? false,
      affects,
      ts,
    },
  ).lastInsertRowid;
  v.lines.forEach(([ledgerId, amount], i) => {
    t.db.run(
      `INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, date, affects_books, is_post_dated)
       VALUES (:v, :n, :l, :a, :d, :affects, :pd)`,
      { v: voucherId, n: i + 1, l: ledgerId, a: amount, d: v.date, affects, pd: v.postDated ?? false },
    );
  });
  return voucherId;
}

/** Last audit row for an entity type. */
export function lastAudit(t: TestCompany, entityType: string):
  | { action: string; entity_id: number | null; entity_label: string | null; before_json: string | null; after_json: string | null; username: string | null }
  | undefined {
  return t.db.get(
    'SELECT action, entity_id, entity_label, before_json, after_json, username FROM audit_log WHERE entity_type = :e ORDER BY id DESC LIMIT 1',
    { e: entityType },
  );
}
