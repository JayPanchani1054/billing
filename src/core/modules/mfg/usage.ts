/**
 * Where a stock item is used by the mfg module (for the inventory module's delete check). Imports only
 * the Db type, so the inventory module can call it without an import cycle.
 */
import type { Db } from '../../db/db.ts';

/** Human-readable uses of the item in BOMs and job work orders (empty when unused). */
export function itemMfgUses(db: Db, itemId: number): Array<[count: number, what: string]> {
  const n = (sql: string): number => Number(db.value(sql, { id: itemId }) ?? 0);
  return [
    [n('SELECT COUNT(*) FROM boms WHERE item_id = :id'), 'bill(s) of materials of the item'],
    [n('SELECT COUNT(DISTINCT bom_id) FROM bom_lines WHERE item_id = :id'), 'bill(s) of materials of other items'],
    [
      n('SELECT COUNT(*) FROM (SELECT id FROM job_work_orders WHERE item_id = :id UNION SELECT order_id FROM job_work_order_lines WHERE item_id = :id)'),
      'job work order(s)',
    ],
  ];
}
