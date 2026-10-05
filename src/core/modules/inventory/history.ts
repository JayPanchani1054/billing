/**
 * Removing one dated GST row of a stock item or stock group (e.g. a rate change entered with the
 * wrong 'Applicable from' date). Re-saving on the same date replaces a row; this removes it.
 *
 * When the removed row was the latest one, the master's current GST columns are brought back to the
 * new latest row, so the master shows the details that are in force again.
 */
import { formatDate } from '../../../shared/dates.ts';
import type { DeleteResult } from '../../../shared/types/inventory.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { notFound } from '../../lib/errors.ts';
import { nowIso, requirePermission } from './common.ts';
import { alignColumnsWithLatestHistory, latestGstHistoryDate, type GstEntityType } from './gst.ts';
import { auditSnapshot, getItem } from './items.ts';
import { getStockGroup } from './masters.ts';

export function deleteGstHistoryEntry(ctx: CompanyCtx, id: number): DeleteResult {
  requirePermission(ctx, 'masters.alter', 'change GST details');
  const { db } = ctx;
  const row = db.get<{ entity_type: GstEntityType; entity_id: number; applicable_from: string }>(
    `SELECT entity_type, entity_id, applicable_from FROM gst_rate_history
      WHERE id = :id AND entity_type IN ('stock_item', 'stock_group')`,
    { id },
  );
  if (!row) throw notFound('GST rate history entry', id);
  const today = ctx.clock.today();
  const snapshot = (): { guid: string; name: string; data: unknown } => {
    if (row.entity_type === 'stock_item') {
      const item = getItem(db, row.entity_id, today);
      return { guid: item.guid, name: item.name, data: auditSnapshot(item) };
    }
    const group = getStockGroup(db, row.entity_id);
    return { guid: group.guid, name: group.name, data: group };
  };
  const before = snapshot();
  db.run('DELETE FROM gst_rate_history WHERE id = :id', { id });
  const latest = latestGstHistoryDate(db, row.entity_type, row.entity_id);
  if (latest !== undefined && row.applicable_from > latest) alignColumnsWithLatestHistory(db, row.entity_type, row.entity_id, nowIso(ctx));
  const after = snapshot();
  ctx.audit({
    action: 'alter',
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityGuid: after.guid,
    entityLabel: `${after.name} (GST details from ${formatDate(row.applicable_from)} removed)`,
    before: before.data,
    after: after.data,
  });
  return { id, deleted: true };
}
