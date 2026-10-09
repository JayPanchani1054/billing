/**
 * Voucher types offered by F10 ("Other vouchers") and Go To — predefined AND company-defined
 * (Masters › Voucher Types, e.g. "Sales - Export" with its own series). Pure (tested in
 * voucherTypes.test.ts).
 *
 * Source: 'accounts.voucherType.list' (needs masters.view). Without it (no permission, still
 * loading, failed) the predefined list is used, so F10 always works.
 */
import { PREDEFINED_VOUCHER_TYPES, VOUCHER_BASE_TYPES } from '../../../shared/constants.ts';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { GotoItem } from './goto.ts';

/** The fields of VoucherTypeRow this needs. */
export interface VoucherTypeLike {
  id: number;
  name: string;
  alias: string | null;
  abbreviation: string | null;
  baseType: VoucherBaseType;
  isPredefined: boolean;
  isActive: boolean;
  hotkey: string | null;
}

export interface VoucherChoice {
  /** Unique: 'base:<baseType>' for a predefined type, 'type:<id>' for a company-defined one. */
  key: string;
  name: string;
  baseType: VoucherBaseType;
  /** Set for company-defined types (open entry with { baseType, voucherTypeId }). */
  voucherTypeId?: number;
  hotkey?: string;
  abbreviation?: string;
  alias?: string;
  custom: boolean;
  /** Name of the predefined type it belongs to ("Sales") — second line for custom types. */
  baseName: string;
}

const PREDEFINED_ORDER = new Map(PREDEFINED_VOUCHER_TYPES.map((t, i) => [t.baseType, i]));
const baseName = (b: VoucherBaseType): string => PREDEFINED_VOUCHER_TYPES.find((t) => t.baseType === b)?.name ?? b;

function predefinedChoice(t: (typeof PREDEFINED_VOUCHER_TYPES)[number]): VoucherChoice {
  return {
    key: `base:${t.baseType}`,
    name: t.name,
    baseType: t.baseType,
    hotkey: t.hotkey && t.hotkey !== 'F10' ? t.hotkey : undefined,
    abbreviation: t.abbreviation,
    custom: false,
    baseName: t.name,
  };
}

/**
 * Predefined types first (standard order, with their F-keys; ones the company deactivated are
 * dropped), then the company's own active types grouped by base type (in the same order) and name.
 */
export function voucherChoices(rows: readonly VoucherTypeLike[] | undefined | null): VoucherChoice[] {
  if (!rows || rows.length === 0) return PREDEFINED_VOUCHER_TYPES.map(predefinedChoice);
  const inactivePredefined = new Set(rows.filter((r) => r.isPredefined && !r.isActive).map((r) => r.baseType));
  const out: VoucherChoice[] = PREDEFINED_VOUCHER_TYPES.filter((t) => !inactivePredefined.has(t.baseType)).map(predefinedChoice);
  const custom = rows
    .filter((r) => !r.isPredefined && r.isActive && (VOUCHER_BASE_TYPES as readonly string[]).includes(r.baseType))
    .sort((a, b) => (PREDEFINED_ORDER.get(a.baseType) ?? 99) - (PREDEFINED_ORDER.get(b.baseType) ?? 99) || a.name.localeCompare(b.name, 'en-IN'));
  for (const r of custom) {
    out.push({
      key: `type:${r.id}`,
      name: r.name,
      baseType: r.baseType,
      voucherTypeId: r.id,
      hotkey: r.hotkey ?? undefined,
      abbreviation: r.abbreviation ?? undefined,
      alias: r.alias ?? undefined,
      custom: true,
      baseName: baseName(r.baseType),
    });
  }
  return out;
}

/** Go To entries for company-defined voucher types (predefined ones come from the Transactions menu). */
export function customVoucherGotoItems(choices: readonly VoucherChoice[]): GotoItem[] {
  return choices
    .filter((c) => c.custom && c.voucherTypeId !== undefined)
    .map((c) => ({
      id: `voucher-type:${c.voucherTypeId}`,
      label: c.name,
      group: 'Vouchers',
      description: `New voucher · ${c.baseName}`,
      keywords: ['voucher', 'entry', c.baseName, c.abbreviation ?? '', c.alias ?? ''].filter(Boolean),
      screen: '',
      command: voucherCommand(c.baseType, c.voucherTypeId),
    }));
}

/** 'voucher:<baseType>' or 'voucher-type:<baseType>:<id>' (Go To commands; kept in recents). */
export function voucherCommand(baseType: VoucherBaseType, voucherTypeId?: number): string {
  return voucherTypeId === undefined ? `voucher:${baseType}` : `voucher-type:${baseType}:${voucherTypeId}`;
}

export function parseVoucherCommand(command: string): { baseType: VoucherBaseType; voucherTypeId?: number } | null {
  const m = /^voucher:([a-z_]+)$/.exec(command) ?? /^voucher-type:([a-z_]+):(\d+)$/.exec(command);
  if (!m) return null;
  const baseType = m[1];
  if (!(VOUCHER_BASE_TYPES as readonly string[]).includes(baseType)) return null;
  if (m[2] === undefined) return { baseType: baseType as VoucherBaseType };
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { baseType: baseType as VoucherBaseType, voucherTypeId: id } : null;
}
