/**
 * Edit Log ⇄ records (pure, tested in recordLinks.test.ts).
 *
 * - From a record's history (or a selected Edit Log row), Alt+A "Open record" opens the screen that
 *   shows the record: a voucher → its view, a master → its alteration form.
 * - The other way, master forms offer Alt+H "Edit history": 'security.audit' { entityType, entityId,
 *   entityGuid?, label? } with the entity types the core audits (ctx.audit entityType) — the same
 *   types as RECORD_SCREENS below.
 */
import type { AuditActionName } from '../../../../shared/types/security.ts';

/** Audited record types that have a screen showing one record, and that screen. */
const RECORD_SCREENS: Readonly<Record<string, { screen: string; noun: string; withId: boolean }>> = {
  voucher: { screen: 'vouchers.view', noun: 'voucher', withId: true },
  ledger: { screen: 'accounts.ledger.form', noun: 'ledger', withId: true },
  group: { screen: 'accounts.group.form', noun: 'group', withId: true },
  voucher_type: { screen: 'accounts.voucherType.form', noun: 'voucher type', withId: true },
  stock_item: { screen: 'inventory.item.form', noun: 'stock item', withId: true },
  stock_group: { screen: 'inventory.group.form', noun: 'stock group', withId: true },
  stock_category: { screen: 'inventory.category.form', noun: 'stock category', withId: true },
  unit: { screen: 'inventory.unit.form', noun: 'unit', withId: true },
  godown: { screen: 'inventory.godown.form', noun: 'godown', withId: true },
  role: { screen: 'security.role.form', noun: 'role', withId: true },
  user: { screen: 'security.user.form', noun: 'user', withId: true },
  company: { screen: 'company.profile', noun: 'company details', withId: false },
};

export interface RecordLink {
  screen: string;
  params: Record<string, number>;
  label: string;
}

/**
 * The screen that shows an audited record; null when the type has none (reports, settings, imports),
 * the entry names no record, or the record was deleted since.
 */
export function recordLink(entityType: string | null, entityId: number | null, deleted = false): RecordLink | null {
  if (!entityType || deleted) return null;
  const s = Object.prototype.hasOwnProperty.call(RECORD_SCREENS, entityType) ? RECORD_SCREENS[entityType] : undefined;
  if (!s) return null;
  if (s.withId && (entityId === null || !Number.isSafeInteger(entityId) || entityId <= 0)) return null;
  return { screen: s.screen, params: s.withId ? { id: entityId as number } : {}, label: `Open ${s.noun}` };
}

/** A record's history ends with its deletion (versions oldest first). */
export function isDeletedRecord(versions: ReadonlyArray<{ action: AuditActionName }>): boolean {
  return versions.length > 0 && versions[versions.length - 1].action === 'delete';
}

