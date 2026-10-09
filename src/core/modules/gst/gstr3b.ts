/**
 * GSTR-3B from gst_lines (+ manual adjustments per period).
 *
 *   3.1(a) osup_det      outward taxable supplies other than zero-rated: B2B, B2CL, B2CS, deemed exports
 *                        (taxable lines; credit notes subtract, debit notes add). Supplies on which the
 *                        RECIPIENT pays tax (GSTR-1 4B) are excluded.
 *   3.1(b) osup_zero     exports and SEZ supplies (with and without payment): taxable value, IGST, cess
 *   3.1(c) osup_nil_exmp nil-rated and exempt outward lines (any document)
 *   3.1(d) isup_rev      inward supplies liable to reverse charge: domestic RCM + import of services
 *   3.1(e) osup_nongst   non-GST outward lines
 *   3.2                  inter-state taxable supplies to unregistered persons, composition dealers and
 *                        UIN holders, by place of supply (taxable value + IGST)
 *   4(A)(1) IMPG import of goods (+ SEZ goods) · (2) IMPS import of services · (3) ISRC other RCM inward ·
 *   (4) ISD (manual) · (5) OTH all other ITC (+ ITC reclaimed, manual), all net of purchase returns.
 *   4(A) includes credit blocked under s.17(5) (itc_eligibility 'ineligible'); the same amount is
 *   reversed in 4(B)(1) together with manual rule 38/42/43 reversals (CBIC circular 170/02/2022).
 *   4(B)(2) other reversals (manual) · 4(C) = 4(A) − 4(B) · 4(D)(1) reclaimed (manual, info) ·
 *   4(D)(2) ineligible under s.16(4) / PoS rules (manual).
 *   5     inward exempt / nil-rated / composition-supplier (GST) and non-GST supplies, inter / intra.
 *   5.1   interest and late fee (manual).
 *   6.1   forward-charge liability (3.1(a) + 3.1(b) tax) set off against 4(C) + the electronic credit
 *         ledger balance brought forward — the credit left after the previous period's set-off, chained
 *         from the books beginning (creditBroughtForward) — + manual credit not in the books (setoff.ts);
 *         reverse-charge tax (3.1(d)) is paid in cash.
 */
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { formatMoney } from '../../../shared/format.ts';
import { stateName } from '../../../shared/gst/index.ts';
import type {
  Gstr3bAdjustmentKey,
  Gstr3bAdjustments,
  Gstr3bAdjustmentsInput,
  Gstr3bInterStateRow,
  Gstr3bInwardRow,
  Gstr3bItcRow,
  Gstr3bItcType,
  Gstr3bPaymentRow,
  Gstr3bSummary,
  Gstr3bSupplyRow,
  GstJsonFile,
  ReturnPeriodRef,
  TaxAmounts,
  TaxHead,
  TaxValue,
} from '../../../shared/types/gst-returns.ts';
import { GSTR3B_ADJUSTMENT_KEYS, TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import { addMonths } from '../../../shared/dates.ts';
import { assertDateUnlocked, getCompanyProfile } from '../company/service.ts';
import type { GstCompany, GstDoc, GstDocLine } from './docs.ts';
import { addTax, addTV, cleanTax, lineTV, loadDocs, rupees, zeroTax, zeroTV } from './docs.ts';
import { monthPeriodKey, parsePeriodKey, quarterPeriodKey } from './period.ts';
import { setOff } from './setoff.ts';

// ───────────────────────────── Adjustments ─────────────────────────────

export const ADJUSTMENT_LABELS: Readonly<Record<Gstr3bAdjustmentKey, string>> = {
  itcIsd: '4(A)(4) Inward supplies from ISD',
  itcReversalRules: '4(B)(1) ITC reversed as per rules 38, 42 and 43 (s.17(5) blocked credit is added from the books)',
  itcReversalOthers: '4(B)(2) ITC reversed — others',
  itcReclaimed: '4(D)(1) ITC reclaimed which was reversed under 4(B)(2) earlier (also added to 4(A)(5))',
  itcIneligibleOthers: '4(D)(2) Ineligible ITC under s.16(4) and ITC restricted due to PoS rules',
  interest: '5.1 Interest',
  lateFee: '5.1 Late fee (CGST and SGST only)',
  creditLedgerBalance: 'Electronic credit ledger: credit not in the books (e.g. the opening balance when you started), added to the credit brought forward for the 6.1 set-off',
};

export function emptyAdjustments(): Gstr3bAdjustments {
  const out = {} as Gstr3bAdjustments;
  for (const k of GSTR3B_ADJUSTMENT_KEYS) out[k] = zeroTax();
  return out;
}

function parseStoredAdjustments(raw: string | undefined): Gstr3bAdjustments {
  const out = emptyAdjustments();
  if (!raw) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  for (const k of GSTR3B_ADJUSTMENT_KEYS) {
    const src = (v as Record<string, unknown>)[k];
    if (!src || typeof src !== 'object') continue;
    for (const h of TAX_HEADS) {
      const n = (src as Record<string, unknown>)[h];
      if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) out[k][h] = n;
    }
  }
  return out;
}

export function readAdjustments(db: Db, periodKey: string): { values: Gstr3bAdjustments; updatedAt: string | null } {
  const row = db.get<{ data: string; updated_at: string }>(
    `SELECT data, updated_at FROM gst_adjustments WHERE form = 'gstr3b' AND return_period = :p`,
    { p: periodKey },
  );
  return { values: parseStoredAdjustments(row?.data), updatedAt: row?.updated_at ?? null };
}

/** Save (merge) manual GSTR-3B entries for a period. Audited; refused for a locked period. */
export function saveAdjustments(ctx: CompanyCtx, period: ReturnPeriodRef & { key: string }, input: Gstr3bAdjustmentsInput['values']): Gstr3bAdjustments {
  assertDateUnlocked(ctx.db, period.to);
  const before = readAdjustments(ctx.db, period.key);
  const next = structuredClone(before.values);
  const issues: Array<{ path: string; message: string }> = [];
  for (const [k, val] of Object.entries(input)) {
    if (!(GSTR3B_ADJUSTMENT_KEYS as readonly string[]).includes(k)) {
      issues.push({ path: `values.${k}`, message: `Unknown GSTR-3B entry "${k}"` });
      continue;
    }
    const key = k as Gstr3bAdjustmentKey;
    if (!val) continue;
    for (const h of TAX_HEADS) {
      const n = val[h];
      if (n === undefined) continue;
      if (!Number.isSafeInteger(n) || n < 0) {
        issues.push({ path: `values.${k}.${h}`, message: `${ADJUSTMENT_LABELS[key]}: ${h.toUpperCase()} must be zero or a positive amount` });
        continue;
      }
      if (key === 'lateFee' && (h === 'igst' || h === 'cess') && n !== 0) {
        issues.push({ path: `values.${k}.${h}`, message: 'Late fee is levied only under CGST and SGST — leave IGST and cess at zero' });
        continue;
      }
      next[key][h] = n;
    }
  }
  if (issues.length > 0) throw validation(issues);
  const ts = ctx.clock.now().toISOString();
  ctx.db.run(
    `INSERT INTO gst_adjustments (form, return_period, data, updated_at, updated_by) VALUES ('gstr3b', :p, :data, :ts, :uid)
     ON CONFLICT(form, return_period) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    { p: period.key, data: JSON.stringify(next), ts, uid: ctx.session.userId },
  );
  ctx.audit({
    action: before.updatedAt ? 'alter' : 'create',
    entityType: 'gst_adjustments',
    entityLabel: `GSTR-3B manual entries ${period.label}`,
    before: before.updatedAt ? before.values : undefined,
    after: next,
  });
  return next;
}

// ───────────────────────────── Computation ─────────────────────────────

const SUPPLY_ROWS: ReadonlyArray<{ key: Gstr3bSupplyRow['key']; row: string; label: string }> = [
  { key: 'osup_det', row: '3.1(a)', label: 'Outward taxable supplies (other than zero rated, nil rated and exempted)' },
  { key: 'osup_zero', row: '3.1(b)', label: 'Outward taxable supplies (zero rated)' },
  { key: 'osup_nil_exmp', row: '3.1(c)', label: 'Other outward supplies (nil rated, exempted)' },
  { key: 'isup_rev', row: '3.1(d)', label: 'Inward supplies (liable to reverse charge)' },
  { key: 'osup_nongst', row: '3.1(e)', label: 'Non-GST outward supplies' },
];

const ITC_AVAILABLE: ReadonlyArray<{ ty: Gstr3bItcType; row: string; label: string }> = [
  { ty: 'IMPG', row: '4(A)(1)', label: 'Import of goods' },
  { ty: 'IMPS', row: '4(A)(2)', label: 'Import of services' },
  { ty: 'ISRC', row: '4(A)(3)', label: 'Inward supplies liable to reverse charge (other than 1 & 2 above)' },
  { ty: 'ISD', row: '4(A)(4)', label: 'Inward supplies from ISD' },
  { ty: 'OTH', row: '4(A)(5)', label: 'All other ITC' },
];

const HEAD_LABELS: Readonly<Record<TaxHead, string>> = { igst: 'Integrated tax', cgst: 'Central tax', sgst: 'State/UT tax', cess: 'Cess' };

interface Accumulators {
  supplies: Record<Gstr3bSupplyRow['key'], TaxValue>;
  outwardRcm: TaxValue;
  inter: { unregistered: Map<string, Gstr3bInterStateRow>; composition: Map<string, Gstr3bInterStateRow>; uin: Map<string, Gstr3bInterStateRow> };
  itc: Record<'IMPG' | 'IMPS' | 'ISRC' | 'OTH', TaxAmounts>;
  blocked: TaxAmounts;
  inward: { GST: { inter: number; intra: number }; NONGST: { inter: number; intra: number } };
}

function addInter(map: Map<string, Gstr3bInterStateRow>, pos: string, l: GstDocLine, sign: number): void {
  const r = map.get(pos) ?? { pos, posName: stateName(pos) || pos, taxable: 0, igst: 0 };
  r.taxable += sign * l.taxable;
  r.igst += sign * l.igst;
  map.set(pos, r);
}

function accumulate(docs: readonly GstDoc[]): Accumulators {
  const a: Accumulators = {
    supplies: { osup_det: zeroTV(), osup_zero: zeroTV(), osup_nil_exmp: zeroTV(), isup_rev: zeroTV(), osup_nongst: zeroTV(), eco_sup: zeroTV(), eco_reg_sup: zeroTV() },
    outwardRcm: zeroTV(),
    inter: { unregistered: new Map(), composition: new Map(), uin: new Map() },
    itc: { IMPG: zeroTax(), IMPS: zeroTax(), ISRC: zeroTax(), OTH: zeroTax() },
    blocked: zeroTax(),
    inward: { GST: { inter: 0, intra: 0 }, NONGST: { inter: 0, intra: 0 } },
  };
  for (const d of docs) {
    const s = d.sign;
    if (d.direction === 'outward') {
      if (d.nature === 'composition_outward' || d.nature === 'no_gst') continue;
      const zero = d.nature.startsWith('export') || d.nature.startsWith('sez');
      for (const l of d.lines) {
        if (l.taxability === 'nil_rated' || l.taxability === 'exempt') {
          a.supplies.osup_nil_exmp.taxable += s * l.taxable;
          continue;
        }
        if (l.taxability === 'non_gst') {
          a.supplies.osup_nongst.taxable += s * l.taxable;
          continue;
        }
        if (d.reverseCharge || l.reverseCharge) {
          addTV(a.outwardRcm, lineTV(l), s);
          continue;
        }
        addTV(zero ? a.supplies.osup_zero : a.supplies.osup_det, lineTV(l), s);
        if (!zero && d.interState && d.pos && d.pos !== '96') {
          const reg = d.party.registration;
          if (reg === 'unregistered' || reg === 'consumer') addInter(a.inter.unregistered, d.pos, l, s);
          else if (reg === 'composition') addInter(a.inter.composition, d.pos, l, s);
          else if (reg === 'uin') addInter(a.inter.uin, d.pos, l, s);
        }
      }
      continue;
    }
    // Inward
    const side = d.interState ? 'inter' : 'intra';
    for (const l of d.lines) {
      if (l.taxability !== 'taxable') {
        a.inward[l.taxability === 'non_gst' ? 'NONGST' : 'GST'][side] += s * l.taxable;
        continue;
      }
      if (d.nature === 'inward_composition') {
        a.inward.GST[side] += s * l.taxable;
        continue;
      }
      const rcm = l.reverseCharge || d.nature === 'inward_rcm' || d.nature === 'import_services';
      if (rcm) addTV(a.supplies.isup_rev, lineTV(l), s);
      let ty: 'IMPG' | 'IMPS' | 'ISRC' | 'OTH';
      if (d.nature === 'import_goods') ty = 'IMPG';
      else if (d.nature === 'import_services') ty = 'IMPS';
      else if (d.nature === 'inward_sez') ty = l.supplyType === 'goods' ? 'IMPG' : 'OTH';
      else if (rcm) ty = 'ISRC';
      else ty = 'OTH';
      addTax(a.itc[ty], l, s);
      if (l.itcEligibility === 'ineligible') addTax(a.blocked, l, s);
    }
  }
  return a;
}

const supplyRow = (key: Gstr3bSupplyRow['key'], row: string, label: string, t: TaxValue): Gstr3bSupplyRow => cleanTax({ key, row, label, ...t });

const sortInter = (m: Map<string, Gstr3bInterStateRow>): Gstr3bInterStateRow[] =>
  [...m.values()].filter((r) => r.taxable !== 0 || r.igst !== 0).sort((a, b) => a.pos.localeCompare(b.pos));

// ───────────────────────────── Electronic credit ledger brought forward ─────────────────────────────

type PeriodWithKey = ReturnPeriodRef & { key: string; fp: string };

/** The month / quarter (same kind as `kind`) that contains `iso`. */
function periodOf(kind: 'month' | 'quarter', iso: string): PeriodWithKey {
  return parsePeriodKey(kind === 'month' ? monthPeriodKey(iso) : quarterPeriodKey(iso)) as PeriodWithKey;
}

/**
 * First date of the GST credit chain: the books beginning, or the first GST document if one is dated
 * earlier. Before it nothing is carried; its own credit (portal balance when the books started) is a
 * manual entry (`creditLedgerBalance`) of the first period.
 */
function chainStart(db: Db): string {
  const booksFrom = getCompanyProfile(db).booksFrom;
  const first = db.value<string>(
    `SELECT MIN(date) FROM vouchers WHERE base_type IN ('sales','purchase','credit_note','debit_note') AND affects_books = 1`,
  );
  return first && first < booksFrom ? first : booksFrom;
}

/**
 * Per connection: the closing credit (after set-off) of every chained period computed so far, with the
 * fingerprint of the data it was computed from. A save rewrites a voucher's gst_lines, so only the
 * periods from the first changed one onwards are recomputed — not the whole history since the books
 * began (≈1.6 s for 18 months / 35,000 GST lines). Nothing is re-read at all while nothing has been
 * written (total_changes() for this connection, PRAGMA data_version for others).
 */
interface ChainEntry {
  fp: string;
  closing: TaxAmounts;
  /** Write stamp at which `fp` was last checked against the data. */
  stamp: string;
}
interface ChainCache {
  scope: string;
  entries: Map<string, ChainEntry>;
}
const chainCache = new WeakMap<Db, ChainCache>();

/**
 * Fingerprint of everything a month's GSTR-3B set-off depends on: its gst_lines (amounts, rate and
 * flags, position-weighted so moving a value between lines changes it), its GST vouchers (count, ids,
 * totals, status, last change) and the manual entries of the month. Months without data have none.
 * Amounts are reduced modulo a prime before weighting so the sums can never overflow (SUM() raises an
 * error on 64-bit overflow).
 */
function monthFingerprints(db: Db, from: string, to: string, today: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (ym: string, part: string): void => {
    out.set(ym, `${out.get(ym) ?? ''}${part};`);
  };
  for (const r of db.all<{ ym: string; f: string }>(
    `SELECT substr(g.date, 1, 7) AS ym,
            COUNT(*) || ':' || SUM(g.id) || ':' || SUM(g.voucher_id) || ':' ||
            SUM((g.taxable_value % 1000000007) * (g.id % 997 + 1)) || ':' ||
            SUM(((g.igst + 3 * g.cgst + 7 * g.sgst + 11 * g.cess) % 1000000007) * (g.id % 991 + 1)) || ':' ||
            SUM(CAST(g.rate * 1000 AS INTEGER) * (g.id % 983 + 1)) || ':' ||
            SUM((g.is_reverse_charge + 2 * g.affects_books + 4 * (g.is_post_dated = 1 AND g.date > :today)
                 + 8 * (CASE g.itc_eligibility WHEN 'inputs' THEN 1 WHEN 'capital_goods' THEN 2 WHEN 'input_services' THEN 3 WHEN 'ineligible' THEN 4 ELSE 0 END)
                 + 64 * (CASE g.taxability WHEN 'taxable' THEN 1 WHEN 'exempt' THEN 2 WHEN 'nil_rated' THEN 3 ELSE 4 END)
                 + 512 * (g.supply_type = 'goods')) * (g.id % 977 + 1)) AS f
       FROM gst_lines g
      WHERE g.date >= :from AND g.date <= :to
      GROUP BY ym`,
    { from, to, today },
  )) {
    add(r.ym, `g${r.f}`);
  }
  for (const r of db.all<{ ym: string; f: string }>(
    `SELECT substr(v.date, 1, 7) AS ym,
            COUNT(*) || ':' || SUM(v.id) || ':' || SUM((v.total_amount % 1000000007) * (v.id % 997 + 1)) || ':' ||
            SUM((v.tax_amount % 1000000007) * (v.id % 991 + 1)) || ':' ||
            SUM((v.affects_books + 2 * v.is_cancelled + 4 * v.is_optional + 8 * (v.is_post_dated = 1 AND v.date > :today)
                 + 16 * v.is_reverse_charge + 32 * length(COALESCE(v.gst_nature, ''))) * (v.id % 983 + 1)) || ':' ||
            MAX(v.updated_at) AS f
       FROM vouchers v
      WHERE v.base_type IN ('sales', 'purchase', 'credit_note', 'debit_note') AND v.date >= :from AND v.date <= :to
      GROUP BY ym`,
    { from, to, today },
  )) {
    add(r.ym, `v${r.f}`);
  }
  return out;
}

/** Fingerprint per chained period: its months' data + the manual entries saved under its key. */
function periodFingerprints(db: Db, chain: readonly PeriodWithKey[], today: string): string[] {
  const months = monthFingerprints(db, chain[0].from, chain[chain.length - 1].to, today);
  const adjustments = new Map(
    db.all<{ p: string; data: string }>(`SELECT return_period AS p, data FROM gst_adjustments WHERE form = 'gstr3b'`).map((r) => [r.p, r.data]),
  );
  return chain.map((p) => {
    let f = `a${adjustments.get(p.key) ?? ''}|`;
    for (let d = p.from; d <= p.to; d = addMonths(d, 1)) f += `${d.slice(0, 7)}=${months.get(d.slice(0, 7)) ?? ''}|`;
    return f;
  });
}

/**
 * Credit carried into `period` by the electronic credit ledger: the credit left after the 6.1 set-off of
 * the previous return period, which itself started with the credit left by the one before it — chained
 * month by month (or quarter by quarter for a quarter) from the books beginning, each period with its
 * own manual entries. Zero for a date range (a review, not a return) and for the first period.
 * Reverse-charge tax never uses credit, so it does not affect the chain.
 */
export function creditBroughtForward(db: Db, company: GstCompany, period: ReturnPeriodRef, today: string): TaxAmounts {
  if (period.kind === 'range' || !period.key) return zeroTax();
  const kind = period.kind;
  const start = periodOf(kind, chainStart(db));
  if (period.from <= start.from) return zeroTax();
  const step = kind === 'month' ? 1 : 3;
  const chain: PeriodWithKey[] = [];
  for (let d = start.from; d < period.from; d = addMonths(d, step)) chain.push(periodOf(kind, d));
  const ck = (p: PeriodWithKey): string => `${kind}|${p.key}`;
  const last = chain[chain.length - 1];

  // Cache scope: the working date (post-dated vouchers fall due) and what classifies every document.
  const scope = JSON.stringify([today, start.from, company.registration, company.stateCode, company.gstin, company.features.gst]);
  const stamp = `${db.value<number>('SELECT total_changes()') ?? 0}|${db.value<number>('PRAGMA data_version') ?? 0}`;
  let cache = chainCache.get(db);
  if (!cache || cache.scope !== scope) {
    cache = { scope, entries: new Map() };
    chainCache.set(db, cache);
  }
  // Fast path: the previous period was computed or checked since the last write. (Its closing credit
  // depends on every period before it, which were checked in the same pass.)
  const hit = cache.entries.get(ck(last));
  if (hit && hit.stamp === stamp) return { ...hit.closing };

  // Reuse the longest prefix of periods whose data has not changed; recompute from the first that has.
  const fps = periodFingerprints(db, chain, today);
  let i = 0;
  let carry: TaxAmounts = zeroTax();
  for (; i < chain.length; i++) {
    const e = cache.entries.get(ck(chain[i]));
    if (!e || e.fp !== fps[i]) break;
    e.stamp = stamp;
    carry = { ...e.closing };
  }
  if (i < chain.length) {
    const todo = chain.slice(i);
    const byPeriod = new Map<string, GstDoc[]>(todo.map((p) => [p.key, []]));
    for (const d of loadDocs(db, company, { from: todo[0].from, to: last.to, today, lean: true })) {
      if (!d.inBooks) continue;
      byPeriod.get(periodOf(kind, d.date).key)?.push(d);
    }
    todo.forEach((p, j) => {
      const s = computeGstr3b(db, company, p, today, undefined, byPeriod.get(p.key) ?? [], { broughtForward: carry });
      carry = { ...s.payment.setOff.creditBalance };
      cache.entries.set(ck(p), { fp: fps[i + j], closing: carry, stamp });
    });
  }
  return { ...carry };
}

/**
 * GSTR-3B for a period (month or quarter; a date range works for review). `preloaded` (optional): the
 * period's documents from loadDocs() — cancelled ones (inBooks = false) are ignored.
 * `opts.broughtForward`: the electronic credit ledger balance carried in (default: computed from the
 * books by `creditBroughtForward`; callers walking periods in order pass the previous closing credit).
 */
export function computeGstr3b(
  db: Db,
  company: GstCompany,
  period: ReturnPeriodRef,
  today: string,
  issueCount = { errors: 0, warnings: 0 },
  preloaded?: readonly GstDoc[],
  opts: { broughtForward?: TaxAmounts } = {},
): Gstr3bSummary {
  const docs = (preloaded ?? loadDocs(db, company, { from: period.from, to: period.to, today })).filter((d) => d.inBooks);
  const a = accumulate(docs);
  const adj = period.key ? readAdjustments(db, period.key) : { values: emptyAdjustments(), updatedAt: null };
  const v = adj.values;
  const notes: string[] = [];
  const broughtForward = { ...(opts.broughtForward ?? creditBroughtForward(db, company, period, today)) };

  const supplies = SUPPLY_ROWS.map((r) => supplyRow(r.key, r.row, r.label, a.supplies[r.key]));
  const eco = [
    supplyRow('eco_sup', '3.1.1(i)', 'Taxable supplies on which an e-commerce operator pays tax u/s 9(5)', zeroTV()),
    supplyRow('eco_reg_sup', '3.1.1(ii)', 'Taxable supplies made by a registered person through an e-commerce operator u/s 9(5)', zeroTV()),
  ];

  const available: Gstr3bItcRow[] = ITC_AVAILABLE.map((r) => {
    const amounts = zeroTax();
    let source: Gstr3bItcRow['source'] = 'books';
    if (r.ty === 'ISD') {
      addTax(amounts, v.itcIsd);
      source = 'manual';
    } else {
      addTax(amounts, a.itc[r.ty as 'IMPG' | 'IMPS' | 'ISRC' | 'OTH']);
      if (r.ty === 'OTH' && (v.itcReclaimed.igst || v.itcReclaimed.cgst || v.itcReclaimed.sgst || v.itcReclaimed.cess)) {
        addTax(amounts, v.itcReclaimed);
        source = 'both';
      }
    }
    return cleanTax({ ty: r.ty, row: r.row, label: r.label, source, ...amounts });
  });
  const rul = zeroTax();
  addTax(rul, a.blocked);
  addTax(rul, v.itcReversalRules);
  const reversed: Gstr3bItcRow[] = [
    cleanTax({ ty: 'RUL', row: '4(B)(1)', label: 'As per rules 38, 42 & 43 of CGST Rules and section 17(5)', source: 'both', ...rul }),
    cleanTax({ ty: 'OTH', row: '4(B)(2)', label: 'Others', source: 'manual', ...v.itcReversalOthers }),
  ];
  const net = zeroTax();
  for (const r of available) addTax(net, r);
  for (const r of reversed) addTax(net, r, -1);
  const ineligible: Gstr3bItcRow[] = [
    cleanTax({ ty: 'RUL', row: '4(D)(1)', label: 'ITC reclaimed which was reversed under Table 4(B)(2) in an earlier tax period', source: 'manual', ...v.itcReclaimed }),
    cleanTax({ ty: 'OTH', row: '4(D)(2)', label: 'Ineligible ITC under section 16(4) & ITC restricted due to PoS rules', source: 'manual', ...v.itcIneligibleOthers }),
  ];

  const inward: Gstr3bInwardRow[] = [
    { ty: 'GST', label: 'From a supplier under composition scheme, exempt and nil rated supply', inter: a.inward.GST.inter, intra: a.inward.GST.intra },
    { ty: 'NONGST', label: 'Non-GST supply', inter: a.inward.NONGST.inter, intra: a.inward.NONGST.intra },
  ];

  // 6.1 Payment of tax.
  const liability = zeroTax();
  addTax(liability, a.supplies.osup_det);
  addTax(liability, a.supplies.osup_zero);
  const rcm = zeroTax();
  addTax(rcm, a.supplies.isup_rev);
  const creditAvailable = zeroTax();
  const payable = zeroTax();
  for (const h of TAX_HEADS) {
    // Electronic credit ledger: this period's net ITC + the credit carried from the previous period
    // (books) + credit the books do not hold (manual entry).
    creditAvailable[h] = Math.max(0, net[h]) + broughtForward[h] + v.creditLedgerBalance[h];
    // A negative 4(C) (reversals exceed credit) is added to the liability, as the portal does.
    payable[h] = Math.max(0, liability[h]) + Math.max(0, -net[h]);
    if (liability[h] < 0) {
      notes.push(`${HEAD_LABELS[h]} on outward supplies is negative (credit notes exceed supplies); it is treated as zero for payment.`);
    }
    if (net[h] < 0) notes.push(`Net ITC for ${HEAD_LABELS[h]} is negative (reversals exceed credit): the excess is added to the tax payable.`);
  }
  const so = setOff(payable, creditAvailable);
  const rows: Gstr3bPaymentRow[] = TAX_HEADS.map((h) => {
    const rcmCash = Math.max(0, rcm[h]);
    return {
      head: h,
      label: HEAD_LABELS[h],
      liability: payable[h],
      paidIgst: so.utilisation.igst[h],
      paidCgst: so.utilisation.cgst[h],
      paidSgst: so.utilisation.sgst[h],
      paidCess: so.utilisation.cess[h],
      cash: so.cash[h],
      rcmLiability: rcmCash,
      interest: v.interest[h],
      lateFee: v.lateFee[h],
      totalCash: so.cash[h] + rcmCash + v.interest[h] + v.lateFee[h],
    };
  });
  const itcUsed = zeroTax();
  for (const h of TAX_HEADS) for (const t of TAX_HEADS) itcUsed[h] += so.utilisation[h][t];

  if (a.outwardRcm.taxable !== 0) {
    notes.push(
      `Outward supplies on which the recipient pays tax (reverse charge): taxable value ${formatMoney(a.outwardRcm.taxable, { symbol: true })} — reported in GSTR-1 table 4B, not in 3.1(a).`,
    );
  }
  if (a.blocked.igst || a.blocked.cgst || a.blocked.sgst || a.blocked.cess) {
    notes.push('ITC blocked under s.17(5) (purchases marked "ineligible") is included in 4(A) and reversed in 4(B)(1), as GSTR-3B now requires.');
  }
  if (TAX_HEADS.some((h) => broughtForward[h] !== 0)) {
    const parts = TAX_HEADS.filter((h) => broughtForward[h] !== 0).map((h) => `${HEAD_LABELS[h]} ${formatMoney(broughtForward[h], { symbol: true })}`);
    notes.push(
      `Credit brought forward from the previous return period (unused after its set-off, per the books): ${parts.join(', ')}. ` +
        'Compare it with the electronic credit ledger on the portal; enter any credit the books do not hold under "Your entries".',
    );
  } else if (period.kind === 'range') {
    notes.push('A date range is a review, not a return: no credit is brought forward from earlier periods.');
  }
  if (company.registration === 'composition') notes.push('Composition taxpayers file CMP-08, not GSTR-3B. Reverse-charge tax shown here is payable through CMP-08.');
  notes.push('3.1.1 (supplies through e-commerce operators u/s 9(5)) is not recorded in the books and is shown as zero.');

  return {
    period,
    gstin: company.gstin,
    companyName: company.name,
    supplies,
    eco,
    interState: {
      unregistered: sortInter(a.inter.unregistered),
      composition: sortInter(a.inter.composition),
      uin: sortInter(a.inter.uin),
    },
    itc: { available, reversed, net: cleanTax(net), ineligible, blocked: cleanTax(a.blocked) },
    inward,
    interest: { ...v.interest },
    lateFee: { ...v.lateFee },
    payment: { rows, setOff: so, creditAvailable, broughtForward, itcUsed, cashTotal: rows.reduce((s, r) => s + r.totalCash, 0) },
    adjustments: v,
    adjustmentsUpdatedAt: adj.updatedAt,
    notes,
    issueCount,
  };
}

// ───────────────────────────── JSON ─────────────────────────────

type Json = Record<string, unknown>;

/** GSTR-3B offline-utility JSON. Negative values are not accepted by GSTN: they are written as 0 with a warning. */
export function buildGstr3bJson(s: Gstr3bSummary): GstJsonFile {
  const warnings: string[] = [];
  if (!s.gstin) throw new Error('GSTR-3B JSON needs the company GSTIN');
  const fp = s.period.fp as string;
  const nn = (p: number, where: string): number => {
    if (p < 0) {
      warnings.push(`${where} is negative (${formatMoney(p, { symbol: true })}) and was written as 0 — adjust it on the portal.`);
      return 0;
    }
    return rupees(p);
  };
  const sup = (key: Gstr3bSupplyRow['key'], heads: Array<'txval' | 'iamt' | 'camt' | 'samt' | 'csamt'>): Json => {
    const r = [...s.supplies, ...s.eco].find((x) => x.key === key) as Gstr3bSupplyRow;
    const map = { txval: r.taxable, iamt: r.igst, camt: r.cgst, samt: r.sgst, csamt: r.cess };
    const o: Json = {};
    for (const h of heads) o[h] = nn(map[h], `${r.row} ${h}`);
    return o;
  };
  const all5: Array<'txval' | 'iamt' | 'camt' | 'samt' | 'csamt'> = ['txval', 'iamt', 'camt', 'samt', 'csamt'];
  const tax = (t: TaxAmounts, where: string): Json => ({ iamt: nn(t.igst, where), camt: nn(t.cgst, where), samt: nn(t.sgst, where), csamt: nn(t.cess, where) });
  const inter = (rows: Gstr3bInterStateRow[], where: string): Json[] =>
    rows.filter((r) => r.taxable > 0 || r.igst > 0).map((r) => ({ pos: r.pos, txval: nn(r.taxable, `${where} ${r.pos}`), iamt: nn(r.igst, `${where} ${r.pos} IGST`) }));

  const json: Json = {
    gstin: s.gstin,
    ret_period: fp,
    sup_details: {
      osup_det: sup('osup_det', all5),
      osup_zero: sup('osup_zero', ['txval', 'iamt', 'csamt']),
      osup_nil_exmp: sup('osup_nil_exmp', ['txval']),
      isup_rev: sup('isup_rev', all5),
      osup_nongst: sup('osup_nongst', ['txval']),
    },
    eco_dtls: { eco_sup: sup('eco_sup', all5), eco_reg_sup: sup('eco_reg_sup', ['txval']) },
    inter_sup: {
      unreg_details: inter(s.interState.unregistered, '3.2 unregistered'),
      comp_details: inter(s.interState.composition, '3.2 composition'),
      uin_details: inter(s.interState.uin, '3.2 UIN'),
    },
    itc_elg: {
      itc_avl: s.itc.available.map((r) => ({ ty: r.ty, ...tax(r, r.row) })),
      itc_rev: s.itc.reversed.map((r) => ({ ty: r.ty, ...tax(r, r.row) })),
      itc_net: tax(s.itc.net, '4(C)'),
      itc_inelg: s.itc.ineligible.map((r) => ({ ty: r.ty, ...tax(r, r.row) })),
    },
    inward_sup: {
      isup_details: s.inward.map((r) => ({ ty: r.ty, inter: nn(r.inter, `5 ${r.ty} inter-state`), intra: nn(r.intra, `5 ${r.ty} intra-state`) })),
    },
    intr_ltfee: {
      intr_details: tax(s.interest, '5.1 interest'),
      ltfee_details: { camt: nn(s.lateFee.cgst, '5.1 late fee'), samt: nn(s.lateFee.sgst, '5.1 late fee') },
    },
  };
  return { fileName: `GSTR3B_${s.gstin}_${fp}.json`, json: JSON.stringify(json), warnings };
}
