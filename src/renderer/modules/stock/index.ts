/**
 * Stock (inventory reports) UI — Gateway section "Inventory Reports". Every screen needs the
 * Inventory feature (F11); godowns, batches and pending orders also need Multiple godowns, Batches
 * and Order processing. Screens and params:
 *
 *   'stock.summary'          { from?, to?, groupId?, categoryId?, godownId? }  Stock Summary (groups → items)
 *   'stock.categories'       { from?, to? }                                   Stock Summary by category
 *   'stock.item'             { itemId, from?, to?, godownId? }                Stock Item Vouchers (Enter → vouchers.view)
 *   'stock.godowns'          { godownId? }                                    Godown Summary (as on)
 *   'stock.movement'         { itemId?, groupId?, from?, to? }                Movement Analysis by party
 *   'stock.ageing'           { groupId? }                                     Stock Ageing (as on)
 *   'stock.reorder'                                                           Reorder Status (as on)
 *   'stock.negative'                                                          Negative Stock (as on)
 *   'stock.batches'          { itemId? }                                      Batch Summary / expiry (as on)
 *   'stock.pendingOrders'    { kind?: 'sales' | 'purchase' }                  Pending Sales / Purchase Orders (as on)
 *   'stock.profitability'    { groupId?, from?, to? }                         Item Profitability
 *   'stock.physicalVariance' { from?, to? }                                   Physical Stock Register
 *
 * Go To: the inventory module's 'items' provider already opens 'stock.item' for items (it checks
 * that this screen is registered), so this module does not register another one.
 */
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { ModuleDef } from '../../app/registry.ts';
import './stock.css';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const AgeingScreen = lazyScreen(() => import('./AnalysisScreens.tsx').then((m) => m.AgeingScreen));
const BatchesScreen = lazyScreen(() => import('./AnalysisScreens.tsx').then((m) => m.BatchesScreen));
const NegativeStockScreen = lazyScreen(() => import('./AnalysisScreens.tsx').then((m) => m.NegativeStockScreen));
const ReorderScreen = lazyScreen(() => import('./AnalysisScreens.tsx').then((m) => m.ReorderScreen));
const GodownsScreen = lazyScreen(() => import('./GodownsScreen.tsx').then((m) => m.GodownsScreen));
const StockItemScreen = lazyScreen(() => import('./ItemScreen.tsx').then((m) => m.StockItemScreen));
const MovementScreen = lazyScreen(() => import('./MovementScreen.tsx').then((m) => m.MovementScreen));
const PendingOrdersScreen = lazyScreen(() => import('./RegisterScreens.tsx').then((m) => m.PendingOrdersScreen));
const PhysicalVarianceScreen = lazyScreen(() => import('./RegisterScreens.tsx').then((m) => m.PhysicalVarianceScreen));
const ProfitabilityScreen = lazyScreen(() => import('./RegisterScreens.tsx').then((m) => m.ProfitabilityScreen));
const StockCategoriesScreen = lazyScreen(() => import('./SummaryScreens.tsx').then((m) => m.StockCategoriesScreen));
const StockSummaryScreen = lazyScreen(() => import('./SummaryScreens.tsx').then((m) => m.StockSummaryScreen));

export const stockModule: ModuleDef = {
  id: 'stock',
  screens: [
    { id: 'stock.summary', title: 'Stock Summary', component: StockSummaryScreen, access: 'reports.view', feature: 'inventory', goto: true, keywords: ['inventory', 'closing stock', 'stock value', 'godown'] },
    { id: 'stock.categories', title: 'Stock Categories Summary', component: StockCategoriesScreen, access: 'reports.view', feature: 'inventory', keywords: ['category summary', 'brand'] },
    { id: 'stock.item', title: 'Stock Item Vouchers', component: StockItemScreen, access: 'reports.view', feature: 'inventory', goto: true, keywords: ['item ledger', 'stock ledger', 'item movement'] },
    { id: 'stock.godowns', title: 'Godown Summary', component: GodownsScreen, access: 'reports.view', feature: 'multipleGodowns', keywords: ['location', 'warehouse', 'store'] },
    { id: 'stock.movement', title: 'Movement Analysis', component: MovementScreen, access: 'reports.view', feature: 'inventory', keywords: ['party-wise', 'supplier', 'customer', 'inward', 'outward'] },
    { id: 'stock.ageing', title: 'Stock Ageing', component: AgeingScreen, access: 'reports.view', feature: 'inventory', keywords: ['ageing analysis', 'old stock', 'slow moving', 'dead stock'] },
    { id: 'stock.reorder', title: 'Reorder Status', component: ReorderScreen, access: 'reports.view', feature: 'inventory', keywords: ['reorder level', 'minimum stock', 'shortfall'] },
    { id: 'stock.negative', title: 'Negative Stock', component: NegativeStockScreen, access: 'reports.view', feature: 'inventory', keywords: ['minus stock', 'exception'] },
    { id: 'stock.batches', title: 'Batch Summary', component: BatchesScreen, access: 'reports.view', feature: 'batches', keywords: ['expiry', 'expired', 'lot'] },
    { id: 'stock.pendingOrders', title: 'Pending Orders', component: PendingOrdersScreen, access: 'reports.view', feature: 'orderProcessing', keywords: ['order outstanding', 'sales order', 'purchase order', 'due'] },
    { id: 'stock.profitability', title: 'Item Profitability', component: ProfitabilityScreen, access: 'reports.financial', feature: 'inventory', keywords: ['gross profit', 'margin', 'item-wise profit', 'cogs'] },
    { id: 'stock.physicalVariance', title: 'Physical Stock Register', component: PhysicalVarianceScreen, access: 'reports.view', feature: 'inventory', keywords: ['stock count', 'shortage', 'excess', 'variance'] },
  ],
  menu: [
    { section: 'inventory_reports', label: 'Stock Summary', screen: 'stock.summary', order: 10, description: 'Opening, inward, outward and closing stock with values' },
    { section: 'inventory_reports', label: 'Stock Item Vouchers', screen: 'stock.item', order: 15, description: 'Every purchase, sale and movement of one item' },
    { section: 'inventory_reports', label: 'Godown Summary', screen: 'stock.godowns', order: 20, description: 'What is lying in each godown' },
    { section: 'inventory_reports', label: 'Category Summary', screen: 'stock.categories', order: 25, description: 'Stock by brand, size or other category' },
    { section: 'inventory_reports', label: 'Movement Analysis', screen: 'stock.movement', order: 30, description: 'Quantities bought from and sold to each party' },
    { section: 'inventory_reports', label: 'Item Profitability', screen: 'stock.profitability', order: 35, description: 'Sales, cost of goods sold and gross profit per item' },
    { section: 'inventory_reports', label: 'Stock Ageing', screen: 'stock.ageing', order: 40, keywords: ['ageing analysis', 'old stock'], description: 'How long your stock has been lying' },
    { section: 'inventory_reports', label: 'Reorder Status', screen: 'stock.reorder', order: 45, description: 'Items to buy before you run out' },
    { section: 'inventory_reports', label: 'Pending Sales Orders', screen: 'stock.pendingOrders', params: { kind: 'sales' }, order: 50, description: 'Customer orders not yet delivered' },
    { section: 'inventory_reports', label: 'Pending Purchase Orders', screen: 'stock.pendingOrders', params: { kind: 'purchase' }, order: 51, description: 'Supplier orders not yet received' },
    { section: 'inventory_reports', label: 'Batch Summary', screen: 'stock.batches', order: 55, description: 'Batch-wise stock with expiry dates' },
    { section: 'inventory_reports', label: 'Negative Stock', screen: 'stock.negative', order: 60, description: 'Items that went below zero' },
    { section: 'inventory_reports', label: 'Physical Stock Register', screen: 'stock.physicalVariance', order: 65, description: 'Stock counts and their differences from the books' },
  ],
};
