/**
 * Stock Item form, 2.1 (SPEC-21 §1.8, D23): which fields are Essentials (always on the page) and which
 * sit behind the "More details" line (Ctrl+I, Alt+F1 alias), and when that line must open by itself.
 * Pure, tested in itemEssentials.test.ts. The form (ItemForm.tsx) renders exactly these lists.
 *
 * - Essentials: Name, Unit, Under, the GST switch ("No — inherit") with its rate and HSN (GST on),
 *   "Applicable from" while a change of GST details is being made (gstDraft.ts `showApplicableFrom`),
 *   Selling price, Barcode (only when POS is on) and the opening stock grid (goods).
 * - More details: everything else (aliases, part no., description, category, service switch, alternate
 *   unit, active, taxability and cess, rate history, prices include GST, MRP, purchase price, costing
 *   method — Standard cost appears only for the Standard cost method —, reorder, batches).
 * - A collapsed "More details" never hides data: it opens by itself when one of its fields holds a value
 *   other than its default or has an error (ui/lib/disclosure.ts `shouldReveal`). Otherwise its open
 *   state is the one remembered on this computer (`pevqori.ui` `moreDetails.stockItem`).
 */
import { revealingFields, shouldReveal } from '../../../ui/lib/disclosure.ts';
import type { ActionRailItem } from '../../../ui/ActionRail.tsx';
import type { ItemDraft } from './itemForm.ts';

/** The form kind under which `pevqori.ui` remembers whether "More details" is open. */
export const MORE_DETAILS_KIND = 'stockItem';

/** Ctrl+I toggles "More details"; Alt+F1 is its alias (SPEC-21 §3.5). */
export const MORE_DETAILS_KEYS = 'Ctrl+I, Alt+F1';

/** What decides the field lists. */
export interface EssentialsContext {
  /** The company uses GST (F11). */
  gstEnabled: boolean;
  /** POS invoicing is on (F11): the barcode is scanned at the counter, so it is an Essential. */
  pos: boolean;
  /** Alteration (the Active switch exists only there). */
  existing: boolean;
}

/** A form field by its draft key (plus `inactive`, the reveal view of `isActive`). */
export type ItemFieldKey = keyof ItemDraft | 'inactive';

/** Essentials, in the order the form shows them (the GST rows only while they apply). */
export function itemEssentialFields(d: Pick<ItemDraft, 'isService' | 'gstApplicable' | 'taxability'>, ctx: EssentialsContext): ItemFieldKey[] {
  const out: ItemFieldKey[] = ['name', 'unitId', 'groupId'];
  if (ctx.gstEnabled) {
    out.push('gstApplicable');
    if (d.gstApplicable && d.taxability === 'taxable') out.push('gstRate');
    out.push('hsnSac', 'gstApplicableFrom');
  }
  out.push('sellingPrice');
  if (ctx.pos) out.push('barcode');
  if (!d.isService) out.push('openings');
  return out;
}

/** The fields behind "More details" (whatever applies to the draft). */
export function itemDetailFields(d: Pick<ItemDraft, 'isService' | 'gstApplicable' | 'taxability' | 'costingMethod' | 'standardCost' | 'maintainBatches'>, ctx: EssentialsContext): ItemFieldKey[] {
  const out: ItemFieldKey[] = ['alias', 'moreAliases', 'partNo'];
  if (!ctx.pos) out.push('barcode');
  out.push('description', 'categoryId', 'isService');
  if (!d.isService) out.push('altUnitId', 'altConversion');
  if (ctx.existing) out.push('inactive');
  if (ctx.gstEnabled) {
    if (d.gstApplicable) out.push('taxability');
    if (d.gstApplicable && d.taxability === 'taxable') out.push('cessRate', 'cessPerUnit');
    out.push('rateInclusiveOfTax');
  }
  out.push('mrp', 'purchasePrice');
  if (!d.isService) {
    out.push('costingMethod');
    if (showStandardCost(d)) out.push('standardCost');
    out.push('reorderLevel', 'minOrderQty', 'maintainBatches');
    if (d.maintainBatches) out.push('trackMfgDate', 'useExpiry');
  }
  return out;
}

/**
 * "Standard cost" is shown only with the Standard cost method — or while it still holds a value (switching
 * the method away never hides a figure the item carries).
 */
export function showStandardCost(d: Pick<ItemDraft, 'costingMethod' | 'standardCost'>): boolean {
  return d.costingMethod === 'std_cost' || (d.standardCost !== null && d.standardCost !== 0);
}

/** Values of the detail fields that count as "nothing to show" (a new item's defaults). */
export const ITEM_DETAIL_DEFAULTS: Readonly<Record<string, unknown>> = {
  taxability: 'taxable',
  costingMethod: 'avg_cost',
};

/** Server/client error keys folded onto the field that shows them ('aliases.0' → 'moreAliases'). */
function errorField(key: string): string {
  if (key.startsWith('aliases')) return 'moreAliases';
  if (key === 'isActive') return 'inactive';
  return key;
}

/** The draft as the reveal rule reads it: `inactive` instead of `isActive` (true is the default). */
function revealValues(d: ItemDraft): Record<string, unknown> {
  return { ...d, inactive: !d.isActive };
}

function errorMap(errors: Readonly<Record<string, string | undefined>> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!errors) return out;
  for (const [k, v] of Object.entries(errors)) if (v) out[errorField(k)] = v;
  return out;
}

/** The detail fields that keep "More details" open (a value other than the default, or an error). */
export function revealingDetailFields(d: ItemDraft, errors: Readonly<Record<string, string | undefined>> | null | undefined, ctx: EssentialsContext): string[] {
  return revealingFields(itemDetailFields(d, ctx), revealValues(d), errorMap(errors), { defaults: ITEM_DETAIL_DEFAULTS });
}

/** True when "More details" must be open whatever the remembered state says. */
export function itemDetailsForced(d: ItemDraft, errors: Readonly<Record<string, string | undefined>> | null | undefined, ctx: EssentialsContext): boolean {
  return shouldReveal(itemDetailFields(d, ctx), revealValues(d), errorMap(errors), { defaults: ITEM_DETAIL_DEFAULTS });
}

/**
 * The muted words after the closed line: a short taste of what is inside, by the item's kind (the full
 * list is in the user guide; a long summary would wrap the line and lengthen its accessible name).
 */
export function moreDetailsSummary(d: Pick<ItemDraft, 'isService'>): string {
  const parts = d.isService ? ['alias', 'category', 'MRP', 'purchase price'] : ['alias', 'category', 'alternate unit', 'MRP', 'purchase price', 'costing', 'reorder'];
  return `${parts.join(', ')} …`;
}

/**
 * The More ▾ item that toggles the section (checked while open). `demoted`: Ctrl+I is a command-bar
 * convention key, but on a master form the "More details" line in the page is the visible control
 * (SPEC-21 §3.1 rule 2b); the keys stay registered.
 */
export function moreDetailsAction(open: boolean, onToggle: () => void): ActionRailItem {
  return { key: MORE_DETAILS_KEYS, label: 'More details', onClick: onToggle, group: 'view', checked: open, demoted: true };
}

/** What a press of Ctrl+I / Alt+F1 (or a click on the line) does. */
export interface DetailsToggle {
  /** The open state to remember on this computer, or null to leave it as it is. */
  remember: boolean | null;
  /** Where the cursor goes after the render: the section's first field, the line, or nowhere. */
  focus: 'section' | 'line' | null;
}

/**
 * Ctrl+I / Alt+F1 and the line. Normally they open or close the section (remembered), and the keys move
 * the cursor with it: into the first field on opening, onto the line when closing from inside. While the
 * section is held open by a value or an error it cannot close, so a key press is never a silent no-op:
 * it jumps between the line and the section's first field, and nothing is remembered (the held-open
 * state belongs to this record, not to the next one).
 */
export function detailsToggle(s: { open: boolean; forced: boolean; fromKey: boolean; focusInside: boolean }): DetailsToggle {
  if (s.forced) return { remember: null, focus: s.fromKey ? (s.focusInside ? 'line' : 'section') : null };
  const next = !s.open;
  if (!s.fromKey) return { remember: next, focus: null };
  return { remember: next, focus: next ? 'section' : s.focusInside ? 'line' : null };
}

/** What decides the Stock Item form's title-row actions. */
export interface ItemFormActionContext {
  /** Alteration (false = Creation). */
  existing: boolean;
  /** Opened from a picker (pushForResult): saving returns the item. */
  forResult: boolean;
  readOnly: boolean;
  detailsOpen: boolean;
  priceLevels: boolean;
  canDelete: boolean;
  /** The item is used in vouchers (it cannot be deleted). */
  hasTransactions: boolean;
}

export interface ItemFormHandlers {
  save: () => void;
  saveClose: () => void;
  toggleDetails: () => void;
  priceLists: () => void;
  remove: () => void;
}

/**
 * The commit label (D5, SPEC-21 §1.8): "Save & create next" on Creation — its accessible name, the same as
 * the ledger form's (the command bar names a button by its label) —, "Save" on Alteration, "Save & return"
 * when opened from a picker.
 */
export function itemSaveLabel(ctx: Pick<ItemFormActionContext, 'existing' | 'forResult'>): string {
  return ctx.forResult ? 'Save & return' : ctx.existing ? 'Save' : 'Save & create next';
}

/**
 * The form's actions: the one filled button (Ctrl+A) and, under More ▾ with their keys, Save & close
 * (Alt+S, Creation only), More details (Ctrl+I / Alt+F1), Price lists (Alt+L), Edit history (Alt+H) and
 * Delete (Alt+D). Only permissions and the record's state hide an action (hidden = no key). Edit history
 * (Alt+H) is the form's own literal action, passed in (app/lib/keyConventions.test.ts reads it from
 * ItemForm.tsx), and sits before Delete.
 */
export function itemFormActions(ctx: ItemFormActionContext, h: ItemFormHandlers, history: ActionRailItem): ActionRailItem[] {
  const saveHint = ctx.readOnly ? 'View only' : ctx.forResult ? 'Saves and returns the item' : ctx.existing ? 'Saves the changes and goes back' : 'Saves and opens a blank form for the next item';
  return [
    { key: 'Ctrl+A', label: itemSaveLabel(ctx), icon: 'save', primary: true, onClick: h.save, disabled: ctx.readOnly, hint: saveHint },
    { key: 'Alt+S', label: 'Save & close', icon: 'check', onClick: h.saveClose, hidden: ctx.existing || ctx.forResult || ctx.readOnly },
    moreDetailsAction(ctx.detailsOpen, h.toggleDetails),
    { key: 'Alt+L', label: 'Price lists', icon: 'tag', onClick: h.priceLists, hidden: !ctx.existing || !ctx.priceLevels, group: 'more' },
    history,
    {
      key: 'Alt+D',
      label: 'Delete',
      icon: 'trash',
      onClick: h.remove,
      hidden: !ctx.existing || !ctx.canDelete,
      disabled: ctx.hasTransactions,
      hint: ctx.hasTransactions ? 'Used in vouchers — cannot be deleted' : undefined,
      group: 'danger',
    },
  ];
}

/** The context run of Alteration: the stock group (or Primary), and "Inactive" for an inactive item. */
export function itemAlterContext(saved: { groupName: string | null; isActive: boolean }): string {
  return [saved.groupName ?? 'Primary', saved.isActive ? '' : 'Inactive'].filter(Boolean).join(' · ');
}
