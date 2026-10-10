/**
 * Database access of the tds module: natures + effective-dated rates, ledger TDS details, the duty
 * ledgers it creates on demand, company TDS settings. `TdsStore` is a per-call cache (create one per
 * preview/save/report; never keep it across calls).
 */
import { randomUUID } from 'node:crypto';
import { GROUP_CODES } from '../../../shared/constants.ts';
import { normalizePan, panStatus } from '../../../shared/tds/rules.ts';
import type {
  DeducteeType,
  PanStatus,
  TdsKind,
  TdsNatureRate,
  TdsSettings,
} from '../../../shared/types/tds.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { readSetting, writeSetting } from '../company/service.ts';

// ───────────────────────────── Rows ─────────────────────────────

export interface NatureRow {
  id: number;
  guid: string;
  kind: TdsKind;
  name: string;
  section: string;
  section_2025: string | null;
  for_non_residents: number;
  is_system: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface RateRow {
  id: number;
  nature_id: number;
  applicable_from: string;
  rate_individual: number;
  rate_company: number;
  rate_others: number;
  rate_no_pan: number;
  threshold_single: number | null;
  threshold_aggregate: number | null;
  aggregate_period: 'fy' | 'month';
  threshold_basis: 'whole' | 'excess';
  base_includes_gst: number;
  note: string | null;
}

export interface LedgerDetailRow {
  ledger_id: number;
  applicable: number;
  nature_id: number | null;
  deductee_type: DeducteeType | null;
  non_resident: number;
  cert_number: string | null;
  cert_rate: number | null;
  cert_from: string | null;
  cert_to: string | null;
  cert_limit: number | null;
  cert_nature_id: number | null;
  payable_kind: 'tds' | 'tcs' | 'receivable' | null;
  payable_section: string | null;
  deductor_tan: string | null;
  updated_at: string;
}

export function rateFromRow(r: RateRow): TdsNatureRate {
  return {
    id: r.id,
    applicableFrom: r.applicable_from,
    rateIndividual: r.rate_individual,
    rateCompany: r.rate_company,
    rateOthers: r.rate_others,
    rateNoPan: r.rate_no_pan,
    thresholdSingle: r.threshold_single,
    thresholdAggregate: r.threshold_aggregate,
    aggregatePeriod: r.aggregate_period,
    thresholdBasis: r.threshold_basis,
    baseIncludesGst: r.base_includes_gst === 1,
    note: r.note,
  };
}

/** Deductee facts of a party ledger. */
export interface Deductee {
  ledgerId: number;
  name: string;
  type: DeducteeType;
  /** The type was not set on the ledger (taken from the PAN, else 'others'). */
  typeAssumed: boolean;
  pan: string | null;
  panStatus: PanStatus;
  nonResident: boolean;
  defaultNatureId: number | null;
  certificate: { number: string; rate: number; from: string; to: string; limit: number | null; natureId: number | null } | null;
}

// ───────────────────────────── Settings ─────────────────────────────

export const DEFAULT_TDS_SETTINGS: TdsSettings = {
  tan: '',
  deductorCategory: 'company',
  responsiblePerson: '',
  responsibleDesignation: '',
  buyer194Q: false,
  roundToRupee: true,
};

export function getTdsSettings(db: Db): TdsSettings {
  const raw = readSetting(db, 'tds');
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<TdsSettings>) : {};
  const out: TdsSettings = { ...DEFAULT_TDS_SETTINGS, ...stored };
  if (!out.tan) out.tan = db.value<string>('SELECT tan FROM company WHERE id = 1') ?? '';
  return out;
}

export function writeTdsSettings(db: Db, s: TdsSettings, now: Date): void {
  writeSetting(db, 'tds', s, now);
}

// ───────────────────────────── Store ─────────────────────────────

const PAYABLE_NAME: Record<'tds' | 'tcs', (section: string) => string> = {
  tds: (section) => `TDS Payable – ${section}`,
  tcs: () => 'TCS Payable',
};

/** The duty ledger section key: TDS per section, TCS one ledger. */
export function payableKey(kind: TdsKind, section: string): string {
  return kind === 'tcs' ? 'TCS' : section;
}

export class TdsStore {
  readonly db: Db;
  private readonly natures = new Map<number, NatureRow | null>();
  private readonly rates = new Map<number, RateRow[]>();
  private readonly details = new Map<number, LedgerDetailRow | null>();
  private readonly ledgerInfo = new Map<number, { name: string; pan: string | null } | null>();
  private settingsCache: TdsSettings | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  settings(): TdsSettings {
    if (!this.settingsCache) this.settingsCache = getTdsSettings(this.db);
    return this.settingsCache;
  }

  nature(id: number): NatureRow | null {
    if (!this.natures.has(id)) this.natures.set(id, this.db.get<NatureRow>('SELECT * FROM tds_natures WHERE id = :id', { id }) ?? null);
    return this.natures.get(id) ?? null;
  }

  /** Rate rows of a nature, ascending by date. */
  rateRows(natureId: number): RateRow[] {
    let rows = this.rates.get(natureId);
    if (!rows) {
      rows = this.db.all<RateRow>('SELECT * FROM tds_nature_rates WHERE nature_id = :id ORDER BY applicable_from', { id: natureId });
      this.rates.set(natureId, rows);
    }
    return rows;
  }

  /** The rate row in force on `date` (latest applicable_from ≤ date), else null. */
  rateOn(natureId: number, date: string): RateRow | null {
    let hit: RateRow | null = null;
    for (const r of this.rateRows(natureId)) if (r.applicable_from <= date) hit = r;
    return hit;
  }

  preloadDetails(ledgerIds: Iterable<number>): void {
    const want = [...new Set(ledgerIds)].filter((id) => !this.details.has(id));
    if (want.length === 0) return;
    const rows = this.db.all<LedgerDetailRow>('SELECT * FROM tds_ledger_details WHERE ledger_id IN (SELECT value FROM json_each(:ids))', {
      ids: JSON.stringify(want),
    });
    for (const id of want) this.details.set(id, null);
    for (const r of rows) this.details.set(r.ledger_id, r);
  }

  detail(ledgerId: number): LedgerDetailRow | null {
    if (!this.details.has(ledgerId)) this.preloadDetails([ledgerId]);
    return this.details.get(ledgerId) ?? null;
  }

  private ledger(ledgerId: number): { name: string; pan: string | null } | null {
    if (!this.ledgerInfo.has(ledgerId)) {
      this.ledgerInfo.set(ledgerId, this.db.get<{ name: string; pan: string | null }>('SELECT name, pan FROM ledgers WHERE id = :id', { id: ledgerId }) ?? null);
    }
    return this.ledgerInfo.get(ledgerId) ?? null;
  }

  deductee(ledgerId: number): Deductee | null {
    const l = this.ledger(ledgerId);
    if (!l) return null;
    const d = this.detail(ledgerId);
    const pan = normalizePan(l.pan) || null;
    const status = panStatus(pan);
    let type: DeducteeType | null = d?.deductee_type ?? null;
    let assumed = false;
    if (!type) {
      assumed = true;
      type = 'others';
      if (status === 'valid' && pan) {
        const c = pan[3];
        type = c === 'C' ? 'company' : c === 'P' || c === 'H' ? 'individual' : c === 'F' || c === 'E' ? 'firm' : 'others';
      }
    }
    const cert =
      d && d.cert_number && d.cert_rate !== null && d.cert_from && d.cert_to
        ? { number: d.cert_number, rate: d.cert_rate, from: d.cert_from, to: d.cert_to, limit: d.cert_limit, natureId: d.cert_nature_id }
        : null;
    return {
      ledgerId,
      name: l.name,
      type,
      typeAssumed: assumed,
      pan,
      panStatus: status,
      nonResident: d?.non_resident === 1,
      defaultNatureId: d?.nature_id ?? null,
      certificate: cert,
    };
  }

  /** Id of the duty ledger the module uses for this kind/section, or null when it does not exist yet. */
  payableLedgerId(kind: TdsKind, section: string): number | null {
    return (
      this.db.value<number>(
        `SELECT ledger_id FROM tds_ledger_details WHERE payable_kind = :kind AND payable_kind IN ('tds', 'tcs') AND payable_section = :section`,
        { kind, section: payableKey(kind, section) },
      ) ?? null
    );
  }
}

export function payableLedgerName(kind: TdsKind, section: string): string {
  return PAYABLE_NAME[kind](section);
}

/**
 * The 'TDS Payable – <section>' / 'TCS Payable' duty ledger (Duties & Taxes), created on demand. A
 * ledger of that name that already exists (made by hand) is adopted and marked. Audited.
 */
export function ensurePayableLedger(ctx: CompanyCtx, kind: TdsKind, section: string): number {
  const { db } = ctx;
  const key = payableKey(kind, section);
  const existing = db.value<number>(`SELECT ledger_id FROM tds_ledger_details WHERE payable_kind = :kind AND payable_kind IN ('tds', 'tcs') AND payable_section = :key`, { kind, key });
  if (existing !== undefined) return existing;
  const name = payableLedgerName(kind, section);
  return adoptOrCreateLedger(ctx, {
    name,
    groupCode: GROUP_CODES.DUTIES_TAXES,
    taxType: kind === 'tds' ? 'TDS' : 'TCS',
    mark: { payableKind: kind, payableSection: key },
  });
}

/** 'TDS Receivable' (Loans & Advances (Asset)) — tax deducted by customers, claimed against 26AS. */
export function ensureReceivableLedger(ctx: CompanyCtx): number {
  const existing = ctx.db.value<number>(`SELECT ledger_id FROM tds_ledger_details WHERE payable_kind = 'receivable' ORDER BY ledger_id LIMIT 1`);
  if (existing !== undefined) return existing;
  return adoptOrCreateLedger(ctx, { name: 'TDS Receivable', groupCode: GROUP_CODES.LOANS_ADVANCES_ASSET, taxType: null, mark: { payableKind: 'receivable', payableSection: null } });
}

/** Expense ledger for interest / late fee paid with a challan (Indirect Expenses; not deductible). */
export function ensureExpenseLedger(ctx: CompanyCtx, name: string): number {
  const id = ctx.db.value<number>('SELECT id FROM ledgers WHERE name = :name COLLATE NOCASE', { name });
  if (id !== undefined) return id;
  return adoptOrCreateLedger(ctx, { name, groupCode: GROUP_CODES.INDIRECT_EXPENSES, taxType: null, mark: null });
}

function adoptOrCreateLedger(
  ctx: CompanyCtx,
  spec: { name: string; groupCode: string; taxType: 'TDS' | 'TCS' | null; mark: { payableKind: 'tds' | 'tcs' | 'receivable'; payableSection: string | null } | null },
): number {
  const { db } = ctx;
  const now = ctx.clock.now().toISOString();
  let id = db.value<number>('SELECT id FROM ledgers WHERE name = :name COLLATE NOCASE', { name: spec.name });
  if (id === undefined) {
    const groupId = db.value<number>('SELECT id FROM groups WHERE reserved_code = :code', { code: spec.groupCode });
    if (groupId === undefined) throw new Error(`Group ${spec.groupCode} is missing`);
    const guid = randomUUID();
    id = db.run(
      `INSERT INTO ledgers (guid, name, group_id, tax_type, created_at, updated_at)
       VALUES (:guid, :name, :groupId, :taxType, :now, :now)`,
      { guid, name: spec.name, groupId, taxType: spec.taxType, now },
    ).lastInsertRowid;
    ctx.audit({
      action: 'create',
      entityType: 'ledger',
      entityId: id,
      entityGuid: guid,
      entityLabel: spec.name,
      after: { name: spec.name, group: spec.groupCode, taxType: spec.taxType, createdBy: 'tds' },
    });
  }
  if (spec.mark) {
    db.run(
      `INSERT INTO tds_ledger_details (ledger_id, payable_kind, payable_section, updated_at) VALUES (:id, :kind, :section, :now)
       ON CONFLICT(ledger_id) DO UPDATE SET payable_kind = excluded.payable_kind, payable_section = excluded.payable_section, updated_at = excluded.updated_at`,
      { id, kind: spec.mark.payableKind, section: spec.mark.payableSection, now },
    );
  }
  return id;
}
