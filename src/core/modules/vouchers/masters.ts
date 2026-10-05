/**
 * Master lookups for the posting engine. The vouchers module does its own SQL (it must not depend on
 * the accounts/inventory modules). A `Masters` instance is a per-call cache: create one per
 * preview/save, never keep it across calls (masters can change between calls).
 */
import { GROUP_CODES, type GstDutyHead, type LedgerCode } from '../../../shared/constants.ts';
import type { Db } from '../../db/db.ts';
import { notFound } from '../../lib/errors.ts';

export interface GroupNode {
  id: number;
  name: string;
  parentId: number | null;
  reservedCode: string | null;
  nature: string;
}

/** Raw ledger row (subset of columns the engine needs). */
export interface LedgerRow {
  id: number;
  guid: string;
  name: string;
  group_id: number;
  reserved_code: string | null;
  is_active: number;
  opening_balance: number;
  maintain_bill_wise: number;
  default_credit_days: number | null;
  credit_limit: number | null;
  cost_centres_applicable: number;
  mailing_name: string | null;
  address: string | null;
  state_code: string | null;
  pincode: string | null;
  email: string | null;
  mobile: string | null;
  pan: string | null;
  gst_registration_type: string | null;
  gstin: string | null;
  tax_type: string | null;
  gst_duty_head: string | null;
  gst_tax_direction: string | null;
  gst_applicable: string;
  gst_taxability: string | null;
  gst_rate: number | null;
  cess_rate: number | null;
  hsn_sac: string | null;
  gst_supply_type: string | null;
  is_reverse_charge: number;
  itc_eligibility: string | null;
  include_in_assessable: string | null;
  appropriate_by: string | null;
}

export interface LedgerInfo {
  row: LedgerRow;
  id: number;
  name: string;
  /** Reserved codes of the ledger's group and every ancestor. */
  groupCodes: ReadonlySet<string>;
  primaryGroupId: number;
  nature: string;
  isCash: boolean;
  /** Bank Accounts or Bank OD. */
  isBank: boolean;
  isCashBank: boolean;
  isDebtor: boolean;
  isCreditor: boolean;
  isSalesAccount: boolean;
  isPurchaseAccount: boolean;
  isFixedAsset: boolean;
  /** A GST duty ledger (Output/Input/RCM IGST/CGST/SGST/Cess or user-created GST tax ledger). */
  isGstDuty: boolean;
  gstDutyHead: GstDutyHead | null;
  billWise: boolean;
}

export interface ItemRow {
  id: number;
  name: string;
  group_id: number | null;
  unit_id: number;
  unit_symbol: string;
  unit_uqc: string | null;
  unit_decimals: number;
  maintain_batches: number;
  is_service: number;
  is_active: number;
  gst_applicable: string;
  hsn_sac: string | null;
  gst_taxability: string | null;
  gst_rate: number | null;
  cess_rate: number | null;
  cess_per_unit: number;
  rate_inclusive_of_tax: number;
}

export interface StockGroupRow {
  id: number;
  name: string;
  parent_id: number | null;
  gst_applicable: string;
  hsn_sac: string | null;
  gst_taxability: string | null;
  gst_rate: number | null;
  cess_rate: number | null;
}

export interface GodownRow {
  id: number;
  name: string;
}

const DUTY_HEADS: readonly string[] = ['IGST', 'CGST', 'SGST', 'CESS'];

export class Masters {
  readonly db: Db;
  private groups: Map<number, GroupNode> | null = null;
  private stockGroups: Map<number, StockGroupRow> | null = null;
  private readonly ledgerCache = new Map<number, LedgerInfo>();
  private readonly itemCache = new Map<number, ItemRow>();
  private readonly godownCache = new Map<number, GodownRow>();
  private readonly costCentreCache = new Map<number, string | null>();
  private readonly reservedCache = new Map<string, number | null>();
  private mainGodown: number | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  groupMap(): Map<number, GroupNode> {
    if (!this.groups) {
      this.groups = new Map();
      for (const g of this.db.all<{ id: number; name: string; parent_id: number | null; reserved_code: string | null; nature: string }>(
        'SELECT id, name, parent_id, reserved_code, nature FROM groups',
      )) {
        this.groups.set(g.id, { id: g.id, name: g.name, parentId: g.parent_id, reservedCode: g.reserved_code, nature: g.nature });
      }
    }
    return this.groups;
  }

  /** Reserved codes along the chain (the group itself first) and the primary (root) group id. */
  groupChain(groupId: number): { codes: Set<string>; primaryId: number; nature: string } {
    const map = this.groupMap();
    const codes = new Set<string>();
    let cur = map.get(groupId);
    let primaryId = groupId;
    let nature = cur?.nature ?? 'assets';
    const seen = new Set<number>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.reservedCode) codes.add(cur.reservedCode);
      primaryId = cur.id;
      nature = cur.nature;
      cur = cur.parentId !== null ? map.get(cur.parentId) : undefined;
    }
    return { codes, primaryId, nature };
  }

  private toInfo(row: LedgerRow, billWiseFeature: boolean): LedgerInfo {
    const chain = this.groupChain(row.group_id);
    const has = (c: string): boolean => chain.codes.has(c);
    const isCash = has(GROUP_CODES.CASH_IN_HAND);
    const isBank = has(GROUP_CODES.BANK_ACCOUNTS) || has(GROUP_CODES.BANK_OD);
    const head = row.gst_duty_head && DUTY_HEADS.includes(row.gst_duty_head) ? (row.gst_duty_head as GstDutyHead) : null;
    return {
      row,
      id: row.id,
      name: row.name,
      groupCodes: chain.codes,
      primaryGroupId: chain.primaryId,
      nature: chain.nature,
      isCash,
      isBank,
      isCashBank: isCash || isBank,
      isDebtor: has(GROUP_CODES.SUNDRY_DEBTORS),
      isCreditor: has(GROUP_CODES.SUNDRY_CREDITORS),
      isSalesAccount: has(GROUP_CODES.SALES_ACCOUNTS),
      isPurchaseAccount: has(GROUP_CODES.PURCHASE_ACCOUNTS),
      isFixedAsset: has(GROUP_CODES.FIXED_ASSETS),
      isGstDuty: head !== null || (row.tax_type === 'GST' && has(GROUP_CODES.DUTIES_TAXES)),
      gstDutyHead: head,
      billWise: billWiseFeature && row.maintain_bill_wise === 1,
    };
  }

  private billWiseFeature = true;

  /** Tell the cache whether the Bill-wise feature is on (affects LedgerInfo.billWise). */
  setBillWiseFeature(on: boolean): void {
    if (on !== this.billWiseFeature) this.ledgerCache.clear();
    this.billWiseFeature = on;
  }

  /** Load many ledgers in one query (missing ids are simply not cached). */
  preloadLedgers(ids: Iterable<number>): void {
    const want = [...new Set(ids)].filter((id) => !this.ledgerCache.has(id));
    if (want.length === 0) return;
    const rows = this.db.all<LedgerRow>('SELECT * FROM ledgers WHERE id IN (SELECT value FROM json_each(:ids))', { ids: JSON.stringify(want) });
    for (const r of rows) this.ledgerCache.set(r.id, this.toInfo(r, this.billWiseFeature));
  }

  ledgerOrNull(id: number): LedgerInfo | null {
    let info = this.ledgerCache.get(id);
    if (!info) {
      const row = this.db.get<LedgerRow>('SELECT * FROM ledgers WHERE id = :id', { id });
      if (!row) return null;
      info = this.toInfo(row, this.billWiseFeature);
      this.ledgerCache.set(id, info);
    }
    return info;
  }

  ledger(id: number): LedgerInfo {
    const info = this.ledgerOrNull(id);
    if (!info) throw notFound('Ledger', id);
    return info;
  }

  reservedLedgerId(code: LedgerCode): number | null {
    if (!this.reservedCache.has(code)) {
      this.reservedCache.set(code, this.db.value<number>('SELECT id FROM ledgers WHERE reserved_code = :code', { code }) ?? null);
    }
    return this.reservedCache.get(code) ?? null;
  }

  preloadItems(ids: Iterable<number>): void {
    const want = [...new Set(ids)].filter((id) => !this.itemCache.has(id));
    if (want.length === 0) return;
    const rows = this.db.all<ItemRow>(
      `SELECT si.id, si.name, si.group_id, si.unit_id, u.symbol AS unit_symbol, u.uqc AS unit_uqc, u.decimal_places AS unit_decimals,
              si.maintain_batches, si.is_service, si.is_active, si.gst_applicable, si.hsn_sac, si.gst_taxability, si.gst_rate,
              si.cess_rate, si.cess_per_unit, si.rate_inclusive_of_tax
         FROM stock_items si JOIN units u ON u.id = si.unit_id
        WHERE si.id IN (SELECT value FROM json_each(:ids))`,
      { ids: JSON.stringify(want) },
    );
    for (const r of rows) this.itemCache.set(r.id, r);
  }

  item(id: number): ItemRow {
    this.preloadItems([id]);
    const row = this.itemCache.get(id);
    if (!row) throw notFound('Stock item', id);
    return row;
  }

  stockGroupMap(): Map<number, StockGroupRow> {
    if (!this.stockGroups) {
      this.stockGroups = new Map();
      for (const g of this.db.all<StockGroupRow>(
        'SELECT id, name, parent_id, gst_applicable, hsn_sac, gst_taxability, gst_rate, cess_rate FROM stock_groups',
      )) {
        this.stockGroups.set(g.id, g);
      }
    }
    return this.stockGroups;
  }

  mainGodownId(): number {
    if (this.mainGodown === null) {
      const id =
        this.db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ??
        this.db.value<number>('SELECT id FROM godowns ORDER BY id LIMIT 1');
      if (id === undefined) throw notFound('Godown (Main Location)');
      this.mainGodown = id;
    }
    return this.mainGodown;
  }

  godown(id: number): GodownRow {
    let g = this.godownCache.get(id);
    if (!g) {
      g = this.db.get<GodownRow>('SELECT id, name FROM godowns WHERE id = :id', { id });
      if (!g) throw notFound('Godown', id);
      this.godownCache.set(id, g);
    }
    return g;
  }

  costCentreName(id: number): string | null {
    if (!this.costCentreCache.has(id)) {
      this.costCentreCache.set(id, this.db.value<string>('SELECT name FROM cost_centres WHERE id = :id', { id }) ?? null);
    }
    return this.costCentreCache.get(id) ?? null;
  }
}
