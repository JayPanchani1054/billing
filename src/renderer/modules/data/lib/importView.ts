/**
 * Pure logic of the Excel/CSV import wizard and the Tally migration wizard (tested in
 * importView.test.ts).
 */
import type {
  ImportCommitResult,
  ImportKind,
  ImportOptions,
  ImportPreviewResult,
  ImportRowResult,
  ImportRowStatus,
  TallyImportOptions,
  TallyImportResult,
  TallyIssue,
  TallyObjectType,
  TallyPreviewResult,
  TallyProgress,
} from '../../../../shared/types/data.ts';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

// ───────────────────────────── Files ─────────────────────────────

export const SPREADSHEET_FILTERS = [
  { name: 'Excel or CSV', extensions: ['xlsx', 'csv', 'txt'] },
  { name: 'All files', extensions: ['*'] },
];
export const TALLY_FILTERS = [
  { name: 'Tally XML export', extensions: ['xml'] },
  { name: 'All files', extensions: ['*'] },
];
export const BACKUP_FILTERS = [
  { name: 'Bahi backup', extensions: ['bahibak'] },
  { name: 'All files', extensions: ['*'] },
];

/** Problem with a chosen file before it is sent (wrong type), or null. */
export function spreadsheetFileProblem(fileName: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  if (ext === 'xlsx' || ext === 'csv' || ext === 'txt') return null;
  if (ext === 'xls') return 'Old Excel files (.xls) cannot be read. In Excel use File › Save As › Excel Workbook (.xlsx), then choose that file.';
  if (ext === 'ods') return 'Save the sheet as .xlsx or .csv first (File › Save As).';
  return 'Choose an Excel (.xlsx) or CSV file.';
}

export function tallyFileProblem(fileName: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  if (ext === 'xml') return null;
  if (ext === 'json') return 'Tally JSON exports are not supported. In Tally choose the XML (Data Interchange) format when exporting.';
  if (ext === '900' || ext === 'tsf' || ext === 'zip') return 'This looks like Tally’s own data folder or a backup. Export the data from Tally as XML instead (Gateway › Export).';
  return 'Choose the .xml file exported from Tally.';
}

// ───────────────────────────── Import preview ─────────────────────────────

export type RowFilter = 'all' | 'problems' | 'error' | 'warning' | 'duplicate' | 'ok';

export function filterRows(rows: readonly ImportRowResult[], filter: RowFilter): ImportRowResult[] {
  if (filter === 'all') return [...rows];
  if (filter === 'problems') return rows.filter((r) => r.status !== 'ok');
  return rows.filter((r) => r.status === filter);
}

export function statusBadge(status: ImportRowStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'ok':
      return { label: 'Ready', tone: 'success' };
    case 'warning':
      return { label: 'Check', tone: 'warning' };
    case 'duplicate':
      return { label: 'Exists', tone: 'neutral' };
    default:
      return { label: 'Error', tone: 'danger' };
  }
}

export function actionText(r: ImportRowResult): string {
  if (r.status === 'error') return 'Not imported';
  switch (r.action) {
    case 'create':
      return 'Will be created';
    case 'update':
      return 'Will be updated';
    case 'skip':
      return 'Skipped (already exists)';
    default:
      return '—';
  }
}

/** Plain-English summary of a preview. */
export function previewSummaryText(p: ImportPreviewResult): string {
  const s = p.summary;
  const parts = [`${s.total} record${s.total === 1 ? '' : 's'} read`];
  if (s.willCreate) parts.push(`${s.willCreate} to create`);
  if (s.willUpdate) parts.push(`${s.willUpdate} to update`);
  if (s.willSkip) parts.push(`${s.willSkip} already exist${s.willSkip === 1 ? 's' : ''}`);
  if (s.warning) parts.push(`${s.warning} to check`);
  if (s.error) parts.push(`${s.error} with errors`);
  return parts.join(' · ');
}

/**
 * Why the import cannot run with these options (null = it can). All-or-nothing with errors present,
 * nothing to do, or vouchers with warnings not yet acknowledged.
 */
export function commitBlockReason(p: ImportPreviewResult, opts: ImportOptions): string | null {
  const s = p.summary;
  if (s.total === 0) return 'The file has no rows to import.';
  if (s.error > 0 && !opts.skipInvalid) {
    return `${s.error} record${s.error === 1 ? ' has' : 's have'} errors. Correct the file and choose it again, or tick “Skip rows with errors”.`;
  }
  // The preview is re-run whenever "update existing" changes, so its counts match the options.
  if (s.willCreate + s.willUpdate === 0) {
    return s.duplicate > 0 && !opts.updateExisting
      ? 'Nothing to import — every record already exists. Tick “Update existing records” to change them.'
      : 'Nothing to import.';
  }
  if (s.warning > 0 && isVoucherKind(p.kind) && !opts.acknowledgeWarnings) {
    return `${s.warning} voucher${s.warning === 1 ? ' needs' : 's need'} checking. Read the messages, then tick “Save vouchers with warnings”.`;
  }
  return null;
}

export function isVoucherKind(kind: ImportKind): boolean {
  return kind === 'sales_invoices' || kind === 'purchase_invoices' || kind === 'vouchers_ledger';
}

/** Cache groups to refresh after an import of this kind. */
export function invalidatesFor(kind: ImportKind): string[] {
  return isVoucherKind(kind) ? ['vouchers', 'reports', 'gst', 'outstanding', 'stock', 'dashboard', 'banking'] : ['accounts', 'inventory', 'reports', 'stock', 'outstanding', 'dashboard'];
}

export function commitResultText(r: ImportCommitResult): { tone: 'success' | 'warning'; title: string; message: string } {
  const done = r.created + r.updated;
  const parts: string[] = [];
  if (r.created) parts.push(`${r.created} created`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.skipped) parts.push(`${r.skipped} skipped (already existed)`);
  if (r.failed) parts.push(`${r.failed} not imported because of errors`);
  return {
    tone: r.failed > 0 ? 'warning' : 'success',
    title: done === 0 ? 'Nothing was imported' : `Imported ${done} of ${r.total} record${r.total === 1 ? '' : 's'}`,
    message: parts.join(' · ') || 'The file had no new records.',
  };
}

// ───────────────────────────── Tally ─────────────────────────────

const TALLY_LABELS: Readonly<Record<TallyObjectType, string>> = {
  GROUP: 'Groups',
  LEDGER: 'Ledgers',
  COSTCATEGORY: 'Cost categories',
  COSTCENTRE: 'Cost centres',
  CURRENCY: 'Currencies',
  UNIT: 'Units',
  GODOWN: 'Godowns',
  STOCKGROUP: 'Stock groups',
  STOCKCATEGORY: 'Stock categories',
  STOCKITEM: 'Stock items',
  VOUCHERTYPE: 'Voucher types',
  VOUCHER: 'Vouchers',
};

export interface TallyCountRow {
  key: TallyObjectType;
  label: string;
  count: number;
  /** Already in this company (masters only), or null when not reported. */
  existing: number | null;
}

/** Rows of the "what is in the file" table, non-zero only, in import order. */
export function tallyCountRows(p: TallyPreviewResult): TallyCountRow[] {
  const existing: Partial<Record<TallyObjectType, number>> = {
    GROUP: p.existing.groups,
    LEDGER: p.existing.ledgers,
    STOCKITEM: p.existing.stockItems,
    UNIT: p.existing.units,
    GODOWN: p.existing.godowns,
  };
  const order: TallyObjectType[] = ['GROUP', 'LEDGER', 'COSTCATEGORY', 'COSTCENTRE', 'CURRENCY', 'UNIT', 'GODOWN', 'STOCKGROUP', 'STOCKCATEGORY', 'STOCKITEM', 'VOUCHERTYPE', 'VOUCHER'];
  return order.filter((k) => (p.counts[k] ?? 0) > 0).map((k) => ({ key: k, label: TALLY_LABELS[k], count: p.counts[k], existing: existing[k] ?? null }));
}

export function issueCounts(issues: readonly TallyIssue[]): { error: number; warning: number; info: number } {
  const out = { error: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity]++;
  return out;
}

export function issueTone(severity: TallyIssue['severity']): BadgeTone {
  return severity === 'error' ? 'danger' : severity === 'warning' ? 'warning' : 'info';
}

/** Problem with the chosen Tally import options, or null. */
export function tallyOptionsProblem(p: TallyPreviewResult, o: TallyImportOptions): string | null {
  const masters = o.masters !== false;
  if (!masters && !o.vouchers) return 'Choose masters, vouchers or both.';
  if (o.vouchers && p.counts.VOUCHER === 0) return 'The file has no vouchers. Untick “Vouchers” or choose a Day Book export.';
  const mastersInFile = (Object.keys(p.counts) as TallyObjectType[]).some((k) => k !== 'VOUCHER' && p.counts[k] > 0);
  if (masters && !o.vouchers && !mastersInFile) return 'The file has no masters. Export “All Masters” from Tally, or import the vouchers.';
  if (o.from && o.to && o.from > o.to) return 'The “from” date is after the “to” date.';
  return null;
}

/** Progress as a percentage (null while the total is unknown). */
export function progressPercent(p: TallyProgress | null | undefined): number | null {
  if (!p || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

export function tallyResultSummary(r: TallyImportResult): { tone: 'success' | 'warning' | 'danger'; title: string; lines: string[] } {
  const m = Object.values(r.masters).reduce(
    (s, c) => ({ created: s.created + c.created, updated: s.updated + c.updated, skipped: s.skipped + c.skipped, failed: s.failed + c.failed }),
    { created: 0, updated: 0, skipped: 0, failed: 0 },
  );
  const lines = [
    `Masters: ${m.created} created, ${m.updated} updated, ${m.skipped} already existed${m.failed ? `, ${m.failed} failed` : ''}.`,
    `Vouchers: ${r.vouchers.created} created, ${r.vouchers.updated} updated, ${r.vouchers.skipped} skipped (already here — see the notes)${r.vouchers.failed ? `, ${r.vouchers.failed} not imported` : ''}.`,
  ];
  const errors = r.issues.filter((i) => i.severity === 'error').length;
  if (r.stopped) return { tone: 'danger', title: 'The import stopped part-way', lines: [...lines, 'Everything up to the problem was saved. Fix the cause and import the same file again — existing records are skipped.'] };
  if (errors > 0 || m.failed > 0 || r.vouchers.failed > 0) return { tone: 'warning', title: 'Imported, with some records left out', lines };
  return { tone: 'success', title: 'Your Tally data is in Bahi ERP', lines };
}
