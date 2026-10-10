/**
 * Voucher types of the mfg module: stock journal types with a class in their configuration
 * (voucher_types.config.stockJournalClass = 'manufacturing' | 'material_out' | 'material_in').
 *
 * They are ordinary (non-predefined) types under the predefined Stock Journal, created when the
 * Manufacturing / Job work feature is turned on (F11, or a new company created with it) — like
 * the conventional Manufacturing Journal and Material In / Out types — so the user may rename, renumber or
 * deactivate them and create more of the same class under Masters › Voucher Types.
 * Imports nothing but node:crypto (and types), so the seed and the company module may call it.
 */
import { randomUUID } from 'node:crypto';
import type { StockJournalClass } from '../../../shared/types/mfg.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';

interface TypeSpec {
  cls: StockJournalClass;
  name: string;
  abbreviation: string;
  config: Record<string, unknown>;
}

const SPECS: readonly TypeSpec[] = [
  { cls: 'manufacturing', name: 'Manufacturing Journal', abbreviation: 'Mfg Jrn', config: { stockJournalClass: 'manufacturing' } },
  // CGST Rule 55(1)(c): goods sent for job work move under a delivery challan.
  { cls: 'material_out', name: 'Material Out', abbreviation: 'Mat Out', config: { stockJournalClass: 'material_out', printTitle: 'Delivery Challan (Job Work)' } },
  { cls: 'material_in', name: 'Material In', abbreviation: 'Mat In', config: { stockJournalClass: 'material_in' } },
];

/** Class of a voucher type's configuration, or null. */
export function stockJournalClassOf(config: Record<string, unknown> | null | undefined): StockJournalClass | null {
  const c = config?.stockJournalClass;
  return c === 'manufacturing' || c === 'material_out' || c === 'material_in' ? c : null;
}

/**
 * Create the missing classed voucher types for the features that are on. A class already served by
 * any stock journal type (even a renamed or inactive one) is left alone; a name taken by another
 * type gets a suffix. Returns the ids created.
 */
export function ensureMfgVoucherTypes(
  db: Db,
  ts: string,
  features: { manufacturing: boolean; jobWork: boolean },
  /** Edit-log writer (F11): each type created is a master created (the seed of a new company passes none). */
  audit?: CompanyCtx['audit'],
): number[] {
  const parent = db.get<{ id: number }>(`SELECT id FROM voucher_types WHERE base_type = 'stock_journal' AND is_predefined = 1 ORDER BY id LIMIT 1`);
  if (!parent) return [];
  const created: number[] = [];
  for (const spec of SPECS) {
    const wanted = spec.cls === 'manufacturing' ? features.manufacturing : features.jobWork;
    if (!wanted) continue;
    const exists = db.value(
      `SELECT 1 FROM voucher_types WHERE base_type = 'stock_journal' AND json_valid(config) AND json_extract(config, '$.stockJournalClass') = :cls LIMIT 1`,
      { cls: spec.cls },
    );
    if (exists !== undefined) continue;
    let name = spec.name;
    for (let n = 2; db.value('SELECT 1 FROM voucher_types WHERE name = :name COLLATE NOCASE OR alias = :name COLLATE NOCASE', { name }) !== undefined && n < 50; n++) {
      name = `${spec.name} ${n}`;
    }
    const guid = randomUUID();
    const id = db.run(
      `INSERT INTO voucher_types (guid, name, abbreviation, base_type, parent_id, is_predefined, is_active, numbering_method,
                                  numbering_restart, config, created_at, updated_at)
       VALUES (:guid, :name, :abbr, 'stock_journal', :parent, 0, 1, 'automatic', 'yearly', :config, :ts, :ts)`,
      { guid, name, abbr: spec.abbreviation, parent: parent.id, config: JSON.stringify(spec.config), ts },
    ).lastInsertRowid;
    audit?.({
      action: 'create',
      entityType: 'voucher_type',
      entityId: id,
      entityGuid: guid,
      entityLabel: name,
      after: { name, baseType: 'stock_journal', abbreviation: spec.abbreviation, config: spec.config, createdBy: 'mfg' },
    });
    created.push(id);
  }
  return created;
}
