/**
 * Pure helpers of the final-wave GST screens: changes after GSTR-3B is filed ('gst.gstr3b.changes')
 * and the Rule 37 180-day check ('gst.rule37'). Amounts stay in paise. Tests: gaps.test.ts.
 */
import type { Gstr3bChangeRow, Rule37Result, Rule37Row } from '../../../../shared/types/gst-plus.ts';
import type { TaxAmounts } from '../../../../shared/types/gst-returns.ts';
import type { TableExportDef } from '../../../app/lib/exportFormat.ts';

type ExportBody = Omit<TableExportDef, 'title' | 'company' | 'period'>;

const sum = (t: TaxAmounts): number => t.igst + t.cgst + t.sgst + t.cess;

export const CHANGE_KIND_LABELS: Readonly<Record<Gstr3bChangeRow['kind'], string>> = {
  altered: 'Altered',
  added: 'Added late',
  removed: 'Deleted / cancelled',
};

export function gstr3bChangesExport(rows: readonly Gstr3bChangeRow[]): ExportBody {
  return {
    subtitle: 'Vouchers of periods whose GSTR-3B was filed, changed afterwards',
    columns: [
      { header: 'Change' },
      { header: 'Voucher' },
      { header: 'Date', kind: 'date' },
      { header: 'Filed in' },
      { header: 'Reported in' },
      { header: 'Δ Tax payable', kind: 'amount' },
      { header: 'Δ Net ITC', kind: 'amount' },
    ],
    rows: rows.map((r) => [CHANGE_KIND_LABELS[r.kind], r.label, r.docDate, r.originalPeriod, r.reportPeriod, sum(r.liabilityDelta), sum(r.itcDelta)]),
  };
}

/** Rows with something to post for the chosen action. */
export function rule37Actionable(r: Rule37Result, kind: 'reversal' | 'reclaim'): Rule37Row[] {
  return r.rows.filter((row) => sum(kind === 'reversal' ? row.toReverse : row.toReclaim) > 0);
}

export function rule37Export(r: Rule37Result): ExportBody {
  return {
    subtitle: `Purchases not paid within 180 days (as on ${r.asOf})`,
    columns: [
      { header: 'Supplier' },
      { header: 'Voucher no.' },
      { header: 'Supplier invoice' },
      { header: 'Date', kind: 'date' },
      { header: '180 days on', kind: 'date' },
      { header: 'Reverse in' },
      { header: 'Invoice value', kind: 'amount' },
      { header: 'Unpaid', kind: 'amount' },
      { header: 'ITC taken', kind: 'amount' },
      { header: 'Already reversed', kind: 'amount' },
      { header: 'Reverse now', kind: 'amount' },
      { header: 'Reclaim now', kind: 'amount' },
    ],
    rows: r.rows.map((x) => [
      x.partyName,
      x.number ?? '',
      x.referenceNo ?? '',
      x.date,
      x.deadline,
      x.reportPeriodLabel,
      x.value,
      x.unpaid,
      sum(x.itc),
      sum(x.reversed),
      sum(x.toReverse),
      sum(x.toReclaim),
    ]),
    totals: ['Total', '', '', '', '', '', null, r.totals.unpaid, null, null, sum(r.totals.toReverse), sum(r.totals.toReclaim)],
  };
}
