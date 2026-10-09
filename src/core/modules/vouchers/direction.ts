/**
 * SQL fragments other modules use to recognise documents by their GST direction without re-running the
 * posting engine.
 *
 * A Debit Note to a customer (Sundry Debtors) is an outward supplementary invoice / upward price revision:
 * the posting engine credits a Sales ledger for its item lines (ledger_entries.role = 'sales'), while a
 * Debit Note to a supplier (purchase return) credits a purchase ledger (role = 'purchase'). Its item lines
 * are value-only (inventory_entries.affects_stock = 0): sales value without a second stock movement.
 */

/**
 * True for an inventory line of a Debit Note to a customer. `v` / `ie` are the aliases of the voucher and of
 * its inventory_entries row. Parameter-free (safe to embed in any statement).
 */
export function outwardDebitNoteLineSql(v: string, ie: string): string {
  return `(${v}.base_type = 'debit_note' AND EXISTS (
    SELECT 1 FROM ledger_entries dn_le
     WHERE dn_le.voucher_id = ${ie}.voucher_id AND dn_le.ledger_id = ${ie}.ledger_id AND dn_le.role = 'sales'))`;
}
