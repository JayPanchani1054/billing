/**
 * TDS/TCS masters: natures (with effective-dated rates), ledger TDS details, company setup and the
 * filing status of quarterly statements. Every mutation is audited.
 */
import { randomUUID } from 'node:crypto';
import { formatDate } from '../../../shared/dates.ts';
import { DEDUCTEE_LABEL, normalizePan, panStatus, quarterRange, statementDueDate, TAN_RE, taxYear, type Quarter, type TdsForm } from '../../../shared/tds/rules.ts';
import type {
  TdsKind,
  TdsLedgerDetails,
  TdsLedgerSaveInput,
  TdsNature,
  TdsNatureSaveInput,
  TdsSettings,
} from '../../../shared/types/tds.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { Masters, type LedgerInfo } from '../vouchers/masters.ts';
import { getTdsSettings, rateFromRow, writeTdsSettings, type LedgerDetailRow, type NatureRow, type RateRow } from './store.ts';

// ───────────────────────────── Natures ─────────────────────────────

function toNature(n: NatureRow, rates: RateRow[], asOf: string | null, usage?: number): TdsNature {
  const list = rates.map(rateFromRow);
  let current = null;
  if (asOf) for (const r of list) if (r.applicableFrom <= asOf) current = r;
  const out: TdsNature = {
    id: n.id,
    guid: n.guid,
    kind: n.kind,
    name: n.name,
    section: n.section,
    section2025: n.section_2025,
    forNonResidents: n.for_non_residents === 1,
    isSystem: n.is_system === 1,
    isActive: n.is_active === 1,
    rates: list,
    current,
  };
  if (usage !== undefined) out.usage = usage;
  return out;
}

export function listNatures(db: Db, opts: { kind?: TdsKind; asOf?: string; includeInactive?: boolean } = {}): TdsNature[] {
  const natures = opts.kind
    ? db.all<NatureRow>('SELECT * FROM tds_natures WHERE kind = :kind ORDER BY section, name', { kind: opts.kind })
    : db.all<NatureRow>('SELECT * FROM tds_natures ORDER BY kind DESC, section, name');
  const rates = db.all<RateRow>('SELECT * FROM tds_nature_rates ORDER BY nature_id, applicable_from');
  const usage = new Map(
    db
      .all<{ id: number; n: number }>(
        `SELECT nature_id AS id, COUNT(*) AS n FROM (
           SELECT nature_id FROM tds_ledger_details WHERE nature_id IS NOT NULL
           UNION ALL SELECT nature_id FROM tds_lines) GROUP BY nature_id`,
      )
      .map((r) => [r.id, r.n]),
  );
  const byNature = new Map<number, RateRow[]>();
  for (const r of rates) {
    const l = byNature.get(r.nature_id) ?? [];
    l.push(r);
    byNature.set(r.nature_id, l);
  }
  return natures
    .filter((n) => opts.includeInactive === true || n.is_active === 1)
    .map((n) => toNature(n, byNature.get(n.id) ?? [], opts.asOf ?? null, usage.get(n.id) ?? 0));
}

export function getNature(db: Db, id: number, asOf?: string): TdsNature {
  const n = db.get<NatureRow>('SELECT * FROM tds_natures WHERE id = :id', { id });
  if (!n) throw notFound('Nature of payment', id);
  const rates = db.all<RateRow>('SELECT * FROM tds_nature_rates WHERE nature_id = :id ORDER BY applicable_from', { id });
  return toNature(n, rates, asOf ?? null);
}

export function saveNature(ctx: CompanyCtx, input: TdsNatureSaveInput): TdsNature {
  const { db } = ctx;
  const name = input.name.trim();
  const section = input.section.trim().toUpperCase().replace(/\s+/g, '');
  const issues: Array<{ path: string; message: string }> = [];
  if (!name) issues.push({ path: 'name', message: 'Enter the name of the nature.' });
  if (!/^[0-9]{3}[A-Z0-9()]*$/.test(section)) issues.push({ path: 'section', message: 'Enter the section as printed in the Act, e.g. 194C, 194J(b), 206C(1F).' });
  const dates = new Set<string>();
  input.rates.forEach((r, i) => {
    if (dates.has(r.applicableFrom)) issues.push({ path: `rates[${i}].applicableFrom`, message: `Two rates apply from ${formatDate(r.applicableFrom)}. Keep one.` });
    dates.add(r.applicableFrom);
    if (r.thresholdBasis === 'excess' && r.thresholdAggregate === null) {
      issues.push({ path: `rates[${i}].thresholdBasis`, message: 'Tax on the excess needs an aggregate threshold.' });
    }
  });
  if (issues.length > 0) throw validation(issues);
  const clash = db.value<number>('SELECT id FROM tds_natures WHERE kind = :kind AND name = :name COLLATE NOCASE AND id <> :id', {
    kind: input.kind,
    name,
    id: input.id ?? 0,
  });
  if (clash !== undefined) throw validation([{ path: 'name', message: `A ${input.kind.toUpperCase()} nature named "${name}" already exists.` }]);

  const now = ctx.clock.now().toISOString();
  let id: number;
  let before: TdsNature | null = null;
  if (input.id) {
    before = getNature(db, input.id);
    if (before.kind !== input.kind) throw validation([{ path: 'kind', message: 'A TDS nature cannot become a TCS nature. Create a new one.' }]);
    if (before.section !== section && db.value('SELECT 1 FROM tds_lines WHERE nature_id = :id LIMIT 1', { id: input.id }) !== undefined) {
      throw validation([{ path: 'section', message: 'Vouchers already use this nature: its section cannot change. Create a new nature instead.' }]);
    }
    id = input.id;
    db.run(
      `UPDATE tds_natures SET name = :name, section = :section, section_2025 = :s2025, for_non_residents = :nr, is_active = :active, updated_at = :now
        WHERE id = :id`,
      { id, name, section, s2025: input.section2025?.trim() || null, nr: input.forNonResidents ? 1 : 0, active: input.isActive === false ? 0 : 1, now },
    );
    db.run('DELETE FROM tds_nature_rates WHERE nature_id = :id', { id });
  } else {
    id = db.run(
      `INSERT INTO tds_natures (guid, kind, name, section, section_2025, for_non_residents, is_system, is_active, created_at, updated_at)
       VALUES (:guid, :kind, :name, :section, :s2025, :nr, 0, :active, :now, :now)`,
      {
        guid: randomUUID(),
        kind: input.kind,
        name,
        section,
        s2025: input.section2025?.trim() || null,
        nr: input.forNonResidents ? 1 : 0,
        active: input.isActive === false ? 0 : 1,
        now,
      },
    ).lastInsertRowid;
  }
  for (const r of [...input.rates].sort((a, b) => (a.applicableFrom < b.applicableFrom ? -1 : 1))) {
    db.run(
      `INSERT INTO tds_nature_rates (nature_id, applicable_from, rate_individual, rate_company, rate_others, rate_no_pan, threshold_single,
              threshold_aggregate, aggregate_period, threshold_basis, base_includes_gst, note)
       VALUES (:id, :from, :ind, :co, :oth, :noPan, :single, :agg, :period, :basis, :gst, :note)`,
      {
        id,
        from: r.applicableFrom,
        ind: r.rateIndividual,
        co: r.rateCompany,
        oth: r.rateOthers,
        noPan: r.rateNoPan,
        single: r.thresholdSingle,
        agg: r.thresholdAggregate,
        period: r.aggregatePeriod,
        basis: r.thresholdBasis,
        gst: r.baseIncludesGst ? 1 : 0,
        note: r.note?.trim() || null,
      },
    );
  }
  const after = getNature(db, id);
  ctx.audit({
    action: before ? 'alter' : 'create',
    entityType: 'tds_nature',
    entityId: id,
    entityGuid: after.guid,
    entityLabel: `${after.section} ${after.name}`,
    before: before ?? undefined,
    after,
  });
  return after;
}

export function deleteNature(ctx: CompanyCtx, id: number): { id: number } {
  const { db } = ctx;
  const n = getNature(db, id);
  if (n.isSystem) throw rule(`${n.section} ${n.name} came with the app and cannot be deleted. Mark it inactive instead.`);
  const used =
    db.value<number>('SELECT COUNT(*) FROM tds_lines WHERE nature_id = :id', { id }) ?? 0;
  if (used > 0) throw rule(`${used} voucher line${used === 1 ? '' : 's'} use ${n.name}. Mark it inactive instead.`);
  db.run('UPDATE tds_ledger_details SET nature_id = NULL WHERE nature_id = :id', { id });
  db.run('UPDATE tds_ledger_details SET cert_nature_id = NULL WHERE cert_nature_id = :id', { id });
  db.run('DELETE FROM tds_natures WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'tds_nature', entityId: id, entityGuid: n.guid, entityLabel: `${n.section} ${n.name}`, before: n });
  return { id };
}

// ───────────────────────────── Ledger TDS details ─────────────────────────────

export type LedgerRoleFilter = 'party' | 'expense' | 'income' | 'all';

function roleOf(L: LedgerInfo): TdsLedgerDetails['role'] | null {
  if (L.isDebtor || L.isCreditor) return 'party';
  if (L.isCashBank) return null;
  if (L.nature === 'expenses' || L.isFixedAsset || L.isPurchaseAccount) return 'expense';
  if (L.nature === 'income' || L.isSalesAccount) return 'income';
  // Other balance-sheet ledgers (loans, capital — partners' accounts for 194T, unsecured loans for 194A).
  if (L.nature === 'liabilities' && !L.groupCodes.has('DUTIES_TAXES')) return 'party';
  return null;
}

function detailOf(L: LedgerInfo, role: TdsLedgerDetails['role'], d: LedgerDetailRow | null, groupName: string): TdsLedgerDetails {
  const pan = normalizePan(L.row.pan) || null;
  return {
    ledgerId: L.id,
    ledgerName: L.name,
    groupName,
    role,
    // A party without TDS details is a deductee by default (the hook deducts from it); only a saved
    // "does not apply" exempts it.
    applicable: d ? d.applicable === 1 : role === 'party',
    natureId: d?.nature_id ?? null,
    deducteeType: d?.deductee_type ?? null,
    nonResident: d?.non_resident === 1,
    pan,
    panStatus: role === 'party' ? panStatus(pan) : 'not_applicable',
    certificate:
      d?.cert_number && d.cert_rate !== null && d.cert_from && d.cert_to
        ? { number: d.cert_number, rate: d.cert_rate, validFrom: d.cert_from, validTo: d.cert_to, limit: d.cert_limit, natureId: d.cert_nature_id }
        : null,
    deductorTan: d?.deductor_tan ?? null,
    legacySection: (L.row as typeof L.row & { tds_section?: string | null }).tds_section ?? null,
  };
}

export function listLedgerDetails(db: Db, opts: { role?: LedgerRoleFilter; search?: string; onlyConfigured?: boolean } = {}): TdsLedgerDetails[] {
  const m = new Masters(db);
  const rows = db.all<{ id: number; group_name: string }>(
    `SELECT l.id, g.name AS group_name FROM ledgers l JOIN groups g ON g.id = l.group_id
      WHERE l.is_active = 1 ORDER BY l.name COLLATE NOCASE`,
  );
  m.preloadLedgers(rows.map((r) => r.id));
  const details = new Map(db.all<LedgerDetailRow>('SELECT * FROM tds_ledger_details').map((d) => [d.ledger_id, d]));
  const q = opts.search?.trim().toLowerCase() ?? '';
  const out: TdsLedgerDetails[] = [];
  for (const r of rows) {
    const L = m.ledger(r.id);
    const role = roleOf(L);
    if (!role) continue;
    if (opts.role && opts.role !== 'all' && opts.role !== role) continue;
    const d = details.get(r.id) ?? null;
    if (d?.payable_kind) continue;
    if (opts.onlyConfigured && !d) continue;
    if (q && !L.name.toLowerCase().includes(q)) continue;
    out.push(detailOf(L, role, d, r.group_name));
  }
  return out;
}

export function getLedgerDetails(db: Db, ledgerId: number): TdsLedgerDetails {
  const m = new Masters(db);
  const L = m.ledgerOrNull(ledgerId);
  if (!L) throw notFound('Ledger', ledgerId);
  const role = roleOf(L);
  if (!role) throw rule(`${L.name} is not a party, expense or income ledger; TDS/TCS details do not apply to it.`);
  const d = db.get<LedgerDetailRow>('SELECT * FROM tds_ledger_details WHERE ledger_id = :id', { id: ledgerId }) ?? null;
  const groupName = db.value<string>('SELECT name FROM groups WHERE id = :id', { id: L.row.group_id }) ?? '';
  return detailOf(L, role, d, groupName);
}

export function saveLedgerDetails(ctx: CompanyCtx, input: TdsLedgerSaveInput): TdsLedgerDetails {
  const { db } = ctx;
  const before = getLedgerDetails(db, input.ledgerId);
  const issues: Array<{ path: string; message: string }> = [];
  // undefined = keep; null / '' = clear (a PAN typed in error must be removable).
  const pan = normalizePan(input.pan === undefined ? before.pan : input.pan);
  if (before.role === 'party' && pan && panStatus(pan) !== 'valid') {
    issues.push({ path: 'pan', message: `${pan} is not a valid PAN: 5 letters, 4 digits and a letter (e.g. AAAPA1234A), the 4th letter being the holder's status (P, C, H, F, …).` });
  }
  const natureId = input.natureId ?? null;
  if (natureId !== null) {
    const n = db.get<NatureRow>('SELECT * FROM tds_natures WHERE id = :id', { id: natureId });
    if (!n) issues.push({ path: 'natureId', message: 'The nature no longer exists. Choose it again.' });
    else if (before.role === 'expense' && n.kind !== 'tds') issues.push({ path: 'natureId', message: `${n.name} is a TCS nature of goods; an expense ledger takes a TDS nature of payment.` });
    else if (before.role === 'income' && n.kind !== 'tcs') issues.push({ path: 'natureId', message: `${n.name} is a TDS nature of payment; a sales ledger takes a TCS nature of goods.` });
  }
  if (before.role !== 'party' && input.applicable && natureId === null) {
    issues.push({ path: 'natureId', message: 'Choose the nature so the tax can be calculated on vouchers.' });
  }
  const cert = input.certificate ?? null;
  if (cert) {
    if (cert.validTo < cert.validFrom) issues.push({ path: 'certificate.validTo', message: 'The certificate ends before it starts.' });
  }
  const tan = ((input.deductorTan === undefined ? before.deductorTan : input.deductorTan) ?? '').trim().toUpperCase();
  if (tan && !TAN_RE.test(tan)) issues.push({ path: 'deductorTan', message: `${tan} is not a valid TAN (4 letters, 5 digits, 1 letter, e.g. MUMA12345B).` });
  if (issues.length > 0) throw validation(issues);

  const now = ctx.clock.now().toISOString();
  if (before.role === 'party' && (pan || null) !== before.pan) {
    db.run('UPDATE ledgers SET pan = :pan, updated_at = :now WHERE id = :id', { pan: pan || null, now, id: input.ledgerId });
  }
  db.run(
    `INSERT INTO tds_ledger_details (ledger_id, applicable, nature_id, deductee_type, non_resident, cert_number, cert_rate, cert_from, cert_to,
            cert_limit, cert_nature_id, deductor_tan, updated_at)
     VALUES (:id, :applicable, :natureId, :type, :nr, :certNo, :certRate, :certFrom, :certTo, :certLimit, :certNature, :tan, :now)
     ON CONFLICT(ledger_id) DO UPDATE SET applicable = excluded.applicable, nature_id = excluded.nature_id,
            deductee_type = excluded.deductee_type, non_resident = excluded.non_resident, cert_number = excluded.cert_number,
            cert_rate = excluded.cert_rate, cert_from = excluded.cert_from, cert_to = excluded.cert_to, cert_limit = excluded.cert_limit,
            cert_nature_id = excluded.cert_nature_id, deductor_tan = excluded.deductor_tan, updated_at = excluded.updated_at`,
    {
      id: input.ledgerId,
      applicable: input.applicable ? 1 : 0,
      natureId,
      type: before.role === 'party' ? (input.deducteeType ?? null) : null,
      nr: before.role === 'party' && input.nonResident ? 1 : 0,
      certNo: cert?.number.trim() || null,
      certRate: cert ? cert.rate : null,
      certFrom: cert?.validFrom ?? null,
      certTo: cert?.validTo ?? null,
      certLimit: cert?.limit ?? null,
      certNature: cert?.natureId ?? null,
      tan: tan || null,
      now,
    },
  );
  // Keep the ledger master's own "TDS applicable / TDS section" fields (Ledger form › Other settings)
  // in step, so the master shows what the deduction uses.
  const section = natureId !== null ? (db.value<string>('SELECT section FROM tds_natures WHERE id = :id', { id: natureId }) ?? null) : null;
  db.run('UPDATE ledgers SET tds_applicable = :applicable, tds_section = :section, updated_at = :now WHERE id = :id', {
    applicable: input.applicable ? 1 : 0,
    section: input.applicable ? section : null,
    now,
    id: input.ledgerId,
  });
  const after = getLedgerDetails(db, input.ledgerId);
  const guid = db.value<string>('SELECT guid FROM ledgers WHERE id = :id', { id: input.ledgerId }) ?? '';
  ctx.audit({
    action: 'alter',
    entityType: 'ledger',
    entityId: input.ledgerId,
    entityGuid: guid,
    entityLabel: `${after.ledgerName} (TDS/TCS details)`,
    before: tdsSnapshot(before),
    after: tdsSnapshot(after),
  });
  return after;
}

function tdsSnapshot(d: TdsLedgerDetails): Record<string, unknown> {
  return {
    tdsApplicable: d.applicable,
    natureId: d.natureId,
    deducteeType: d.deducteeType ? DEDUCTEE_LABEL[d.deducteeType] : null,
    nonResident: d.nonResident,
    pan: d.pan,
    certificate: d.certificate,
    deductorTan: d.deductorTan,
  };
}

// ───────────────────────────── Settings ─────────────────────────────

export function saveSettings(ctx: CompanyCtx, input: TdsSettings): TdsSettings {
  const tan = input.tan.trim().toUpperCase();
  if (tan && !TAN_RE.test(tan)) throw validation([{ path: 'tan', message: `${tan} is not a valid TAN (4 letters, 5 digits, 1 letter, e.g. MUMA12345B).` }]);
  const before = getTdsSettings(ctx.db);
  const next: TdsSettings = { ...input, tan, responsiblePerson: input.responsiblePerson.trim(), responsibleDesignation: input.responsibleDesignation.trim() };
  writeTdsSettings(ctx.db, next, ctx.clock.now());
  ctx.audit({ action: 'settings', entityType: 'settings', entityLabel: 'TDS/TCS setup', before, after: next });
  return getTdsSettings(ctx.db);
}

// ───────────────────────────── Quarterly statements (filing status) ─────────────────────────────

export interface StatementStatusRow {
  form: TdsForm;
  fyStart: number;
  quarter: Quarter;
  filedOn: string | null;
  tokenNo: string | null;
  note: string | null;
}

export function getStatementStatus(db: Db, form: TdsForm, fyStart: number, quarter: Quarter): StatementStatusRow {
  const r = db.get<{ filed_on: string | null; token_no: string | null; note: string | null }>(
    'SELECT filed_on, token_no, note FROM tds_statements WHERE form = :form AND fy_start = :fy AND quarter = :q',
    { form, fy: fyStart, q: quarter },
  );
  return { form, fyStart, quarter, filedOn: r?.filed_on ?? null, tokenNo: r?.token_no ?? null, note: r?.note ?? null };
}

export function saveStatementStatus(
  ctx: CompanyCtx,
  input: { form: TdsForm; fyStart: number; quarter: Quarter; filedOn: string | null; tokenNo?: string | null; note?: string | null },
): StatementStatusRow {
  const { db } = ctx;
  const range = quarterRange(input.fyStart, input.quarter);
  if (input.filedOn && input.filedOn <= range.to) {
    throw validation([{ path: 'filedOn', message: `A statement for the quarter ending ${formatDate(range.to)} is filed after the quarter ends.` }]);
  }
  const before = getStatementStatus(db, input.form, input.fyStart, input.quarter);
  db.run(
    `INSERT INTO tds_statements (form, fy_start, quarter, filed_on, token_no, note, updated_at)
     VALUES (:form, :fy, :q, :filedOn, :token, :note, :now)
     ON CONFLICT(form, fy_start, quarter) DO UPDATE SET filed_on = excluded.filed_on, token_no = excluded.token_no, note = excluded.note,
            updated_at = excluded.updated_at`,
    {
      form: input.form,
      fy: input.fyStart,
      q: input.quarter,
      filedOn: input.filedOn,
      token: input.tokenNo?.trim() || null,
      note: input.note?.trim() || null,
      now: ctx.clock.now().toISOString(),
    },
  );
  const after = getStatementStatus(db, input.form, input.fyStart, input.quarter);
  ctx.audit({
    action: 'alter',
    entityType: 'tds_statement',
    entityLabel: `Form ${input.form} Q${input.quarter} FY ${taxYear(input.fyStart).label} (due ${formatDate(statementDueDate(input.form, input.fyStart, input.quarter))})`,
    before,
    after,
  });
  return after;
}
