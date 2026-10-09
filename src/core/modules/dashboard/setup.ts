/**
 * Getting-started facts for the dashboard's "Get started" card (`DashboardSummary.setup`). Each step
 * of the card is marked done from the books, never from a click (the renderer only adds the steps
 * the user ticked by hand). A handful of indexed EXISTS / one-row reads; computed inside the summary
 * memo, so any save (a ledger, an item, a settings change) refreshes it.
 */
import { DEFAULT_CONFIG } from '../../../shared/settings.ts';
import type { CompanyConfig } from '../../../shared/settings.ts';
import type { DashboardSetup } from '../../../shared/types/dashboard.ts';
import type { Db } from '../../db/db.ts';
import { getConfig } from '../company/service.ts';

const exists = (db: Db, sql: string): boolean => db.value<number>(sql) !== undefined;

/** True when the invoice print options differ from the defaults in any way (copies compared as a set). */
export function invoicePrintingCustomised(inv: CompanyConfig['invoice']): boolean {
  const norm = (o: CompanyConfig['invoice']) => JSON.stringify({ ...o, copies: [...o.copies].sort() });
  return norm(inv) !== norm(DEFAULT_CONFIG.invoice);
}

/**
 * Features (F11) were reviewed: an F11 save is in the edit log that changed something other than
 * `security` (Security Settings and the create wizard's password step also save `security`, which
 * is not a review of the features).
 */
function featuresReviewed(db: Db): boolean {
  for (const r of db.iterate<{ before_json: string | null; after_json: string | null }>(
    `SELECT before_json, after_json FROM audit_log WHERE entity_type = 'company_features'`,
    {},
  )) {
    try {
      const before = JSON.parse(r.before_json ?? '{}') as Record<string, unknown>;
      const after = JSON.parse(r.after_json ?? '{}') as Record<string, unknown>;
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const k of keys) if (k !== 'security' && JSON.stringify(before[k]) !== JSON.stringify(after[k])) return true;
    } catch {
      // an unreadable entry says nothing either way
    }
  }
  return false;
}

export function setupFacts(db: Db): DashboardSetup {
  const company = db.get<{ address: string | null; state_code: string | null }>('SELECT address, state_code FROM company WHERE id = 1');
  const config = getConfig(db);
  return {
    profileComplete: Boolean(company?.address?.trim()) && Boolean(company?.state_code?.trim()),
    featuresReviewed: featuresReviewed(db),
    invoicePrintingSet: invoicePrintingCustomised(config.invoice),
    hasOwnLedgers: exists(db, 'SELECT 1 FROM ledgers WHERE is_predefined = 0 LIMIT 1'),
    hasItems: exists(db, 'SELECT 1 FROM stock_items LIMIT 1'),
    hasSales: exists(db, `SELECT 1 FROM vouchers WHERE base_type = 'sales' LIMIT 1`),
    backupFolderSet: config.backup.folder !== null && config.backup.folder.trim() !== '',
  };
}
