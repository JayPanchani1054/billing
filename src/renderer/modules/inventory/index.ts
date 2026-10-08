/**
 * Inventory masters UI: stock items (single, multiple), stock groups, stock categories, units,
 * godowns and price lists, plus reusable pickers (see README.md). Every screen needs the Inventory
 * feature (F11); godowns also need Multiple godowns and price lists Price levels.
 */
import type { ModuleDef } from '../../app/registry.ts';
import { api } from '../../app/api.ts';
import { registerGotoProvider } from '../../app/lib/goto.ts';
import { formatQty } from '../../../shared/format.ts';
import { CategoryFormScreen, CategoryListScreen } from './Categories.tsx';
import { GodownFormScreen, GodownListScreen } from './Godowns.tsx';
import { GroupFormScreen, GroupListScreen } from './Groups.tsx';
import { ItemBulkScreen } from './ItemBulk.tsx';
import { ItemFormScreen } from './ItemForm.tsx';
import { ItemListScreen } from './ItemList.tsx';
import { itemGotoResults } from './lib/goto.ts';
import { PriceListScreen } from './PriceList.tsx';
import { UnitFormScreen, UnitListScreen } from './Units.tsx';

export const inventoryModule: ModuleDef = {
  id: 'inventory',
  screens: [
    { id: 'inventory.item.list', title: 'Stock Items', component: ItemListScreen, access: 'masters.view', feature: 'inventory', keywords: ['products', 'goods', 'inventory', 'stock'] },
    { id: 'inventory.item.form', title: 'Stock Item', component: ItemFormScreen, access: 'masters.view', feature: 'inventory', keywords: ['product', 'goods'] },
    { id: 'inventory.item.bulk', title: 'Multiple Stock Items', component: ItemBulkScreen, access: 'masters.create', feature: 'inventory' },
    { id: 'inventory.group.list', title: 'Stock Groups', component: GroupListScreen, access: 'masters.view', feature: 'inventory' },
    { id: 'inventory.group.form', title: 'Stock Group', component: GroupFormScreen, access: 'masters.view', feature: 'inventory', presentation: 'dialog' },
    { id: 'inventory.category.list', title: 'Stock Categories', component: CategoryListScreen, access: 'masters.view', feature: 'inventory' },
    { id: 'inventory.category.form', title: 'Stock Category', component: CategoryFormScreen, access: 'masters.view', feature: 'inventory', presentation: 'dialog' },
    { id: 'inventory.unit.list', title: 'Units of Measure', component: UnitListScreen, access: 'masters.view', feature: 'inventory', keywords: ['uom', 'uqc'] },
    { id: 'inventory.unit.form', title: 'Unit', component: UnitFormScreen, access: 'masters.view', feature: 'inventory', presentation: 'dialog' },
    { id: 'inventory.godown.list', title: 'Godowns', component: GodownListScreen, access: 'masters.view', feature: 'multipleGodowns', keywords: ['warehouse', 'location', 'store'] },
    { id: 'inventory.godown.form', title: 'Godown', component: GodownFormScreen, access: 'masters.view', feature: 'multipleGodowns', presentation: 'dialog' },
    { id: 'inventory.priceList', title: 'Price Lists', component: PriceListScreen, access: 'masters.view', feature: 'priceLevels', keywords: ['price level', 'wholesale', 'retail', 'rate'] },
  ],
  menu: [
    { section: 'masters', label: 'Stock Items', screen: 'inventory.item.list', order: 30, description: 'Goods and services you buy and sell', keywords: ['products'] },
    { section: 'masters', label: 'Create Stock Item', screen: 'inventory.item.form', order: 31, access: 'masters.create', description: 'Add a new item with GST, prices and opening stock' },
    { section: 'masters', label: 'Multiple Stock Items', screen: 'inventory.item.bulk', order: 32, description: 'Create many items at once in a grid' },
    { section: 'masters', label: 'Stock Groups', screen: 'inventory.group.list', order: 33, description: 'Organise items; set one GST rate for a whole group' },
    { section: 'masters', label: 'Stock Categories', screen: 'inventory.category.list', order: 34, description: 'Classify items by brand, size or any other way' },
    { section: 'masters', label: 'Units of Measure', screen: 'inventory.unit.list', order: 35, description: 'Nos, Kg, Box of 12 Nos — with GST UQC' },
    { section: 'masters', label: 'Godowns', screen: 'inventory.godown.list', order: 36, description: 'Warehouses, shops and other stock locations' },
    { section: 'masters', label: 'Price Lists', screen: 'inventory.priceList', order: 37, description: 'Rates by price level and quantity slab' },
  ],
};

// ───────────────────────────── Go To: stock items ─────────────────────────────

let registeredScreens: Set<string> | null = null;

/** Screen ids of every module (read lazily: the module list imports this file). */
async function screenExists(id: string): Promise<boolean> {
  if (!registeredScreens) {
    try {
      const { modules } = await import('../index.ts');
      registeredScreens = new Set(modules.flatMap((m) => m.screens.map((s) => s.id)));
    } catch {
      return false;
    }
  }
  return registeredScreens.has(id);
}

registerGotoProvider({
  id: 'items',
  label: 'Stock Items',
  minQuery: 2,
  search: async (query, signal) => {
    // Providers cannot read React state: ask for the company's features (a local call) so items are
    // not offered while Inventory is turned off in F11.
    const [features, rows] = await Promise.all([api('company.features.get'), api('inventory.item.picker', { search: query, limit: 8 })]);
    if (!features.inventory || signal.aborted) return [];
    const hasStockItem = await screenExists('stock.item');
    return itemGotoResults(rows, (id) => id === 'stock.item' && hasStockItem, formatQty);
  },
});
