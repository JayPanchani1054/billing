/**
 * The top bar's "Create ▾" menu (SPEC §3.1) — pure, tested in createMenu.test.ts; rendered by
 * Workspace.tsx. No new keys: each voucher item shows the key it already has.
 *
 *   Sales invoice F8 · Receipt F6 · Purchase F9 · Payment F5 · Credit note Ctrl+F8
 *   ─ Customer · Supplier · Item ─ Other voucher… F10
 *
 * Visibility follows the product's layers (no trace of what the user cannot use, like the menus):
 * - a voucher item only when its F-key would open it (`shell.voucherAvailability` — permission and
 *   F11 features, the same check as the keys);
 * - Customer / Supplier only with the Create masters permission and an openable ledger form; Item also
 *   needs inventory (F11) and an openable item form;
 * - Other voucher… (F10) only with the Create vouchers permission.
 * Nothing left → no Create button at all.
 */
import type { GroupCode, VoucherBaseType } from '../../../shared/constants.ts';
import { PREDEFINED_VOUCHER_TYPES } from '../../../shared/constants.ts';
import type { IconName } from '../../ui/icons.ts';

export type CreateTarget = { kind: 'voucher'; baseType: VoucherBaseType } | { kind: 'ledger'; groupCode: GroupCode } | { kind: 'item' } | { kind: 'other-voucher' };

export interface CreateMenuItem {
  key: string;
  label: string;
  icon: IconName;
  /** The existing key of the target (display only). */
  shortcut?: string;
  target: CreateTarget;
}

export interface CreateMenuContext {
  /** shell.voucherAvailability — the check the voucher keys use. */
  voucherAvailable: (baseType: VoucherBaseType) => boolean;
  canCreateVouchers: boolean;
  canCreateMasters: boolean;
  /** nav.canOpen of the ledger form / item form (registered, permitted, feature on). */
  ledgerFormOpenable: boolean;
  itemFormOpenable: boolean;
  inventory: boolean;
}

/** The everyday vouchers, in menu order. */
export const CREATE_VOUCHERS: ReadonlyArray<{ baseType: VoucherBaseType; label: string; icon: IconName }> = [
  { baseType: 'sales', label: 'Sales invoice', icon: 'invoice' },
  { baseType: 'receipt', label: 'Receipt', icon: 'receipt' },
  { baseType: 'purchase', label: 'Purchase', icon: 'cart' },
  { baseType: 'payment', label: 'Payment', icon: 'wallet' },
  { baseType: 'credit_note', label: 'Credit note', icon: 'undo' },
];

const hotkeyOf = (b: VoucherBaseType): string | undefined => PREDEFINED_VOUCHER_TYPES.find((t) => t.baseType === b)?.hotkey;

/** The menu's groups (separators go between them); empty groups are left out, so `[]` = no menu. */
export function createMenuGroups(ctx: CreateMenuContext): CreateMenuItem[][] {
  const vouchers: CreateMenuItem[] = CREATE_VOUCHERS.filter((v) => ctx.voucherAvailable(v.baseType)).map((v) => ({
    key: v.baseType,
    label: v.label,
    icon: v.icon,
    shortcut: hotkeyOf(v.baseType),
    target: { kind: 'voucher', baseType: v.baseType },
  }));
  const masters: CreateMenuItem[] = [];
  if (ctx.canCreateMasters && ctx.ledgerFormOpenable) {
    masters.push({ key: 'customer', label: 'Customer', icon: 'user', target: { kind: 'ledger', groupCode: 'SUNDRY_DEBTORS' } });
    masters.push({ key: 'supplier', label: 'Supplier', icon: 'building', target: { kind: 'ledger', groupCode: 'SUNDRY_CREDITORS' } });
  }
  if (ctx.canCreateMasters && ctx.inventory && ctx.itemFormOpenable) masters.push({ key: 'item', label: 'Item', icon: 'box', target: { kind: 'item' } });
  const other: CreateMenuItem[] = ctx.canCreateVouchers ? [{ key: 'other', label: 'Other voucher…', icon: 'journal', shortcut: 'F10', target: { kind: 'other-voucher' } }] : [];
  return [vouchers, masters, other].filter((g) => g.length > 0);
}
