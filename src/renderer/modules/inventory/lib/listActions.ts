/**
 * Title-row actions of the inventory master lists, 2.1 (SPEC-21 §1.7, D5, D22): pure, tested in
 * keys21.test.ts with the command-bar rule (app/lib/commandBar.ts). The lists render them through
 * ReportScreen with `outputInMore`, so Print (Alt+P) and Export (Alt+E) sit under More ▾ with their keys.
 *
 * - "Create …" (Alt+C) is the one visible secondary button (`prominent`, not filled — D5).
 * - Stock Items: "Create several" (Alt+M, and Alt+B — the Ledgers list's key for the same thing).
 * - Tree lists (groups, categories, godowns): "Create under selected" (Alt+Shift+C) and the list's own
 *   extras go to More ▾.
 * - Delete is Alt+D (Ctrl+D also works on lists), under More ▾.
 *
 * Keys never change here (§3.1): moving an action out of sight is dropping `primary`/`prominent`, never
 * `hidden` (hidden actions register no key).
 */
import type { ActionRailItem } from '../../../ui/ActionRail.tsx';

export interface ListActionContext {
  canCreate: boolean;
  canDelete: boolean;
  /** A row is selected (Delete / Create under selected need one). */
  hasCurrent: boolean;
  /** Why the selected row cannot be deleted (tooltip of the disabled-looking item). */
  deleteHint?: string;
  busy?: boolean;
}

export interface ItemListHandlers {
  create: () => void;
  createSeveral: () => void;
  remove: () => void;
}

/** Stock Items: Create stock item · More ▾ (Create several, Delete; Print and Export added by ReportScreen). */
export function itemListActions(ctx: ListActionContext, h: ItemListHandlers): ActionRailItem[] {
  return [
    {
      key: 'Alt+C',
      label: 'Create stock item',
      onClick: h.create,
      hidden: !ctx.canCreate,
      prominent: true,
    },
    { key: 'Alt+M, Alt+B', label: 'Create several', onClick: h.createSeveral, hidden: !ctx.canCreate, group: 'create' },
    { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', onClick: h.remove, hidden: !ctx.canDelete, disabled: !ctx.hasCurrent || ctx.busy, hint: ctx.deleteHint, group: 'danger' },
  ];
}

export interface TreeListHandlers {
  create: () => void;
  createUnder: () => void;
  remove: () => void;
}

/** Groups, categories, godowns: Create <noun> · More ▾ (Create under selected, the extras, Delete). */
export function treeListActions(noun: string, ctx: ListActionContext, h: TreeListHandlers, extras: readonly ActionRailItem[] = []): ActionRailItem[] {
  return [
    {
      key: 'Alt+C',
      label: `Create ${noun}`,
      onClick: h.create,
      hidden: !ctx.canCreate,
      prominent: true,
    },
    { key: 'Alt+Shift+C', label: 'Create under selected', onClick: h.createUnder, hidden: !ctx.canCreate, disabled: !ctx.hasCurrent, group: 'create' },
    ...extras,
    { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', onClick: h.remove, hidden: !ctx.canDelete, disabled: !ctx.hasCurrent || ctx.busy, hint: ctx.deleteHint, group: 'danger' },
  ];
}

/** "4 items", "1 stock category", "12 of 5,000 items" — the context run of a list. */
export function countText(shown: number, singular: string, plural: string, total: number = shown): string {
  const n = (x: number) => x.toLocaleString('en-IN');
  if (total > shown) return `${n(shown)} of ${n(total)} ${plural}`;
  return `${n(shown)} ${shown === 1 ? singular : plural}`;
}

/** English plural of a master's noun ("stock category" → "stock categories", "godown" → "godowns"). */
export function pluralOf(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}
