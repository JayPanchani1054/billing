/**
 * Module-owned migration for 'inventory' (additive only).
 *  - stock_groups.cess_per_unit: specific cess (paise per unit) so a group's GST profile has the same
 *    shape as an item's and as gst_rate_history.
 *  - Lookup indexes used by the inventory masters, the item picker and the stock engine.
 */
export const migration040 = {
  version: 40,
  name: 'inventory',
  sql: /* sql */ `
ALTER TABLE stock_groups ADD COLUMN cess_per_unit INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_stock_groups_parent ON stock_groups(parent_id);
CREATE INDEX IF NOT EXISTS idx_stock_categories_parent ON stock_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_godowns_parent ON godowns(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_category ON stock_items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_unit ON stock_items(unit_id);
CREATE INDEX IF NOT EXISTS idx_items_alt_unit ON stock_items(alt_unit_id);
CREATE INDEX IF NOT EXISTS idx_items_alias ON stock_items(alias COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_units_first ON units(first_unit_id);
CREATE INDEX IF NOT EXISTS idx_units_second ON units(second_unit_id);
CREATE INDEX IF NOT EXISTS idx_stock_openings_godown ON stock_openings(godown_id, item_id);
CREATE INDEX IF NOT EXISTS idx_price_list_level ON price_list(price_level_id, item_id, applicable_from);
CREATE INDEX IF NOT EXISTS idx_ie_item_godown_batch ON inventory_entries(item_id, godown_id, batch_name);
`,
} as const;
