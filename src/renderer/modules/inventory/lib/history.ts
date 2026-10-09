/**
 * Edit history of an inventory master (Alt+H "Edit history" on the master forms) — pure, tested in
 * history.test.ts. Opens 'security.audit' in record-history mode; the entity types are the ones the
 * core audits the masters under (src/core/modules/inventory: masters.ts, units.ts, items.ts), so the
 * history lists exactly that record's changes.
 */

/** ctx.audit entityType of each inventory master. */
export type InventoryAuditType = 'stock_item' | 'stock_group' | 'stock_category' | 'godown' | 'unit';

/** A type alias (not an interface) so it passes as nav params (Record<string, unknown>). */
export type MasterHistoryParams = {
  entityType: InventoryAuditType;
  entityId: number;
  entityGuid: string;
  /** Shown as the history's title ("Stock group Grains"). */
  label: string;
};

/** 'security.audit' params for a saved master; null while it is being created (no history yet). */
export function masterHistoryParams(entityType: InventoryAuditType, saved: { id: number; guid: string } | null, label: string): MasterHistoryParams | null {
  if (!saved || !Number.isSafeInteger(saved.id) || saved.id <= 0) return null;
  return { entityType, entityId: saved.id, entityGuid: saved.guid, label };
}
