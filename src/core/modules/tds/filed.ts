/**
 * Filed quarterly statements (Form 26Q / 27Q / 27EQ marked filed under TDS/TCS › Quarterly Return)
 * and the vouchers they were filed with — the TDS counterpart of the GST hook's filed GSTR-1 rule.
 *
 *   - Saving a voucher (new or altered) whose reported TDS / TCS (deductee rows: tax deducted or a
 *     lower / nil certificate) or challan changes in a quarter whose statement is marked filed needs
 *     confirmation ('confirm' warning): the filed statement no longer matches the books, and a
 *     correction statement must be filed on TRACES. A save that leaves the reported figures as they
 *     were (narration, reference…) is not asked about.
 *   - Deleting or cancelling such a voucher is refused (beforeRemove): the deduction / deposit stays
 *     on record. A statement marked filed by mistake can be unmarked (audited) on that screen.
 *
 * Cheap gate: nothing is looked at unless some statement is marked filed.
 */
import { formatDate } from '../../../shared/dates.ts';
import { quarterOf, taxYear, taxYearOf, type Quarter, type TdsForm } from '../../../shared/tds/rules.ts';
import type { TdsKind, TdsVoucherLine, VoucherTdsChallanInput } from '../../../shared/types/tds.ts';
import type { Db } from '../../db/db.ts';
import { rule } from '../../lib/errors.ts';
import { formOf } from './reports.ts';

/** One reported figure of a voucher: the statements it belongs to and a comparable signature. */
interface Reported {
  forms: readonly TdsForm[];
  date: string;
  sig: string;
}

interface FiledStatement {
  form: TdsForm;
  fyStart: number;
  quarter: Quarter;
  filedOn: string;
  tokenNo: string | null;
}

/** True when any quarterly statement is marked filed. */
export function anyStatementFiled(db: Db): boolean {
  return db.value('SELECT 1 FROM tds_statements WHERE filed_on IS NOT NULL LIMIT 1') !== undefined;
}

const challanForms = (kind: TdsKind): readonly TdsForm[] => (kind === 'tcs' ? ['27EQ'] : ['26Q', '27Q']);

function challanSig(c: {
  kind: TdsKind;
  section: string;
  period: string;
  bsrCode: string;
  challanNo: string;
  depositDate: string;
  tax: number;
  surcharge: number;
  cess: number;
  interest: number;
  fee: number;
  others: number;
}): Reported {
  return {
    forms: challanForms(c.kind),
    date: `${c.period}-01`,
    sig: JSON.stringify(['challan', c.kind, c.section, c.period, c.bsrCode, c.challanNo, c.depositDate, c.tax, c.surcharge, c.cess, c.interest, c.fee, c.others]),
  };
}

function lineSig(l: { kind: TdsKind; section: string; party: number | null; amount: number; base: number; status: string; date: string; nonResident: boolean; forNonResidents: boolean }): Reported {
  return {
    forms: [formOf(l)],
    date: l.date,
    sig: JSON.stringify(['line', l.kind, l.section, l.party, l.amount, l.base, l.status, l.date]),
  };
}

/** What the voucher reports now (rows in tds_lines / tds_challans that count in the books). */
export function storedReported(db: Db, voucherId: number): Reported[] {
  const out: Reported[] = [];
  for (const r of db.all<{ kind: TdsKind; section: string; party: number | null; amount: number; base: number; status: string; date: string; nr: number; for_nr: number }>(
    `SELECT tl.kind, tl.section, tl.party_ledger_id AS party, tl.amount, tl.base, tl.status, tl.date, tl.non_resident AS nr,
            COALESCE(n.for_non_residents, 0) AS for_nr
       FROM tds_lines tl LEFT JOIN tds_natures n ON n.id = tl.nature_id
      WHERE tl.voucher_id = :id AND tl.affects_books = 1 AND (tl.amount <> 0 OR tl.status = 'certificate')`,
    { id: voucherId },
  )) {
    out.push(lineSig({ ...r, nonResident: r.nr === 1, forNonResidents: r.for_nr === 1 }));
  }
  for (const c of db.all<{
    kind: TdsKind;
    section: string;
    period: string;
    bsr_code: string;
    challan_no: string;
    deposit_date: string;
    tax: number;
    surcharge: number;
    cess: number;
    interest: number;
    fee: number;
    others: number;
  }>(
    `SELECT kind, section, period, bsr_code, challan_no, deposit_date, tax, surcharge, cess, interest, fee, others
       FROM tds_challans WHERE voucher_id = :id AND affects_books = 1`,
    { id: voucherId },
  )) {
    out.push(challanSig({ ...c, bsrCode: c.bsr_code, challanNo: c.challan_no, depositDate: c.deposit_date }));
  }
  return out;
}

/** What the voucher will report after this save (nothing when it is optional: it does not count). */
export function newReported(db: Db, p: { date: string; isOptional: boolean; lines: readonly TdsVoucherLine[]; challan: VoucherTdsChallanInput | null }): Reported[] {
  if (p.isOptional) return [];
  const out: Reported[] = [];
  for (const l of p.lines) {
    if (l.amount === 0 && l.status !== 'certificate') continue;
    const nonResident = l.partyLedgerId !== null && db.value<number>('SELECT non_resident FROM tds_ledger_details WHERE ledger_id = :id', { id: l.partyLedgerId }) === 1;
    const forNonResidents = db.value<number>('SELECT for_non_residents FROM tds_natures WHERE id = :id', { id: l.natureId }) === 1;
    out.push(lineSig({ kind: l.kind, section: l.section, party: l.partyLedgerId, amount: l.amount, base: l.base, status: l.status, date: p.date, nonResident, forNonResidents }));
  }
  const c = p.challan;
  if (c) {
    out.push(
      challanSig({
        kind: c.kind,
        section: c.section,
        period: c.period,
        bsrCode: c.bsrCode,
        challanNo: c.challanNo,
        depositDate: c.depositDate,
        tax: c.tax,
        surcharge: c.surcharge ?? 0,
        cess: c.cess ?? 0,
        interest: c.interest ?? 0,
        fee: c.fee ?? 0,
        others: c.others ?? 0,
      }),
    );
  }
  return out;
}

/** Filed statements touched by the figures in `items`, in a stable order, each once. */
function filedFor(db: Db, items: readonly Reported[]): FiledStatement[] {
  const seen = new Set<string>();
  const out: FiledStatement[] = [];
  for (const it of items) {
    const fyStart = taxYearOf(it.date).startYear;
    const quarter = quarterOf(it.date);
    for (const form of it.forms) {
      const key = `${form}|${fyStart}|${quarter}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = db.get<{ filed_on: string; token_no: string | null }>(
        'SELECT filed_on, token_no FROM tds_statements WHERE form = :form AND fy_start = :fy AND quarter = :q AND filed_on IS NOT NULL',
        { form, fy: fyStart, q: quarter },
      );
      if (r) out.push({ form, fyStart, quarter, filedOn: r.filed_on, tokenNo: r.token_no });
    }
  }
  return out;
}

function label(s: FiledStatement): string {
  return `Form ${s.form} for Q${s.quarter} of FY ${taxYear(s.fyStart).label} (marked filed on ${formatDate(s.filedOn)}${s.tokenNo ? `, token ${s.tokenNo}` : ''})`;
}

/**
 * The filed statements whose reported figures this save changes (figures before vs after, compared as
 * multisets; only the changed ones count). Empty when nothing reported changes.
 */
export function changedFiledStatements(db: Db, before: readonly Reported[], after: readonly Reported[]): FiledStatement[] {
  const left = new Map<string, number>();
  for (const b of before) left.set(b.sig, (left.get(b.sig) ?? 0) + 1);
  const added: Reported[] = [];
  for (const a of after) {
    const n = left.get(a.sig) ?? 0;
    if (n > 0) left.set(a.sig, n - 1);
    else added.push(a);
  }
  const removed = before.filter((b) => {
    const n = left.get(b.sig) ?? 0;
    if (n <= 0) return false;
    left.set(b.sig, n - 1);
    return true;
  });
  if (added.length === 0 && removed.length === 0) return [];
  return filedFor(db, [...removed, ...added]);
}

export function filedChangeWarning(s: FiledStatement, isNew: boolean): string {
  return isNew
    ? `${label(s)} has already been filed without this ${s.form === '27EQ' ? 'collection' : 'deduction'}. Save it only if it really belongs to that quarter, then file a correction statement on TRACES.`
    : `${label(s)} was filed with the figures of this voucher. Saving changes the TDS / TCS reported in it: file a correction statement on TRACES for this change.`;
}

/** Refuse deleting / cancelling a voucher whose deduction, collection or challan is in a filed statement. */
export function assertNotInFiledStatement(db: Db, voucherId: number, action: 'delete' | 'cancel'): void {
  if (!anyStatementFiled(db)) return;
  const filed = filedFor(db, storedReported(db, voucherId));
  if (filed.length === 0) return;
  throw rule(
    `${label(filed[0])} was filed with the TDS / TCS of this voucher, so it cannot be ${action === 'delete' ? 'deleted' : 'cancelled'}. ` +
      'Alter it instead and file a correction statement on TRACES. If the statement was marked filed by mistake, remove the filing record on the TDS / TCS Quarterly Return screen (Alt+R) first.',
  );
}
