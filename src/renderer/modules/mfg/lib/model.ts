/**
 * Pure report helpers of the mfg screens (tested in model.test.ts): status texts and the export
 * tables of Pending Job Work, ITC-04 and the Production Register. Amounts in paise, dates ISO.
 */
import { formatDate } from '../../../../shared/dates.ts';
import { JOB_WORK_GOODS_LABELS, type JobWorkGoodsType, type ReturnStatus } from '../../../../shared/mfg/jobwork.ts';
import type {
  BomListRow,
  Itc04Result,
  JobWorkOrderListRow,
  PendingJobWorkResult,
  ProductionRegisterResult,
  StockJournalClass,
} from '../../../../shared/types/mfg.ts';

export interface ExportTable {
  title?: string;
  subtitle?: string;
  columns: Array<{ header: string; kind?: 'text' | 'amount' | 'qty' | 'number' | 'date' | 'percent'; decimals?: number; width?: number }>;
  rows: Array<Array<string | number | null>>;
  totals?: Array<string | number | null>;
  notes?: string;
  landscape?: boolean;
}

export const goodsTypeLabel = (g: JobWorkGoodsType): string => JOB_WORK_GOODS_LABELS[g];

/** "Overdue by 51 days" / "Due in 20 days" / "Due today" / "No time limit". */
export function returnStatusText(status: ReturnStatus, daysLeft: number | null): string {
  if (status === 'no_limit' || daysLeft === null) return 'No time limit';
  if (daysLeft < 0) return `Overdue by ${-daysLeft} day${daysLeft === -1 ? '' : 's'}`;
  if (daysLeft === 0) return 'Due today';
  return `Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
}

export const STATUS_TONE: Readonly<Record<ReturnStatus, 'danger' | 'warning' | 'neutral' | 'success'>> = {
  overdue: 'danger',
  due_soon: 'warning',
  ok: 'success',
  no_limit: 'neutral',
};

export function pendingJobWorkExport(res: PendingJobWorkResult, direction: 'out' | 'in'): ExportTable {
  return {
    title: direction === 'out' ? 'Pending Job Work — goods with job workers' : 'Pending Job Work — principals’ goods with us',
    columns: [
      { header: 'Challan no.' },
      { header: 'Sent on', kind: 'date' },
      { header: direction === 'out' ? 'Job worker' : 'Principal' },
      { header: 'Godown' },
      { header: 'Item' },
      { header: 'Goods' },
      { header: 'Unit' },
      { header: 'Sent', kind: 'qty', decimals: 3 },
      { header: 'Returned', kind: 'qty', decimals: 3 },
      { header: 'Pending', kind: 'qty', decimals: 3 },
      { header: 'Pending value', kind: 'amount' },
      { header: 'Return by', kind: 'date' },
      { header: 'Status' },
      { header: 'Order' },
    ],
    rows: res.rows.map((r) => [
      r.challanNo,
      r.sentOn,
      r.partyName,
      r.godownName,
      r.itemName,
      goodsTypeLabel(r.goodsType),
      r.unit,
      r.sentQty,
      r.returnedQty,
      r.pendingQty,
      r.pendingValue,
      r.dueDate,
      returnStatusText(r.status, r.daysLeft),
      r.orderNo,
    ]),
    totals: ['', '', 'Total', '', '', '', '', null, null, null, res.rows.reduce((s, r) => s + r.pendingValue, 0), '', `${res.counts.overdue} overdue`, ''],
    notes:
      'CGST Act s.143: inputs must come back within one year and capital goods within three years of being sent (moulds, dies, jigs, fixtures and tools are exempt); ' +
      'otherwise they are deemed supplied by the principal on the day they were sent out.',
    landscape: true,
  };
}

/** ITC-04 table 4 in the form's column order (a clean CSV; not the GST portal's JSON format). */
export function itc04SentExport(r: Itc04Result): ExportTable {
  return {
    title: 'ITC-04 — Table 4: inputs / capital goods sent for job work',
    columns: [
      { header: 'GSTIN of job worker' },
      { header: 'State of job worker (if unregistered)' },
      { header: 'Challan number' },
      { header: 'Challan date', kind: 'date' },
      { header: 'Types of goods' },
      { header: 'Description of goods' },
      { header: 'HSN' },
      { header: 'UQC' },
      { header: 'Quantity', kind: 'qty', decimals: 3 },
      { header: 'Taxable value', kind: 'amount' },
      { header: 'Integrated tax rate %', kind: 'percent' },
      { header: 'Central tax rate %', kind: 'percent' },
      { header: 'State/UT tax rate %', kind: 'percent' },
      { header: 'Cess rate %', kind: 'percent' },
    ],
    rows: r.sent.map((s) => [
      s.jobWorkerGstin ?? '',
      s.jobWorkerGstin ? '' : (s.jobWorkerState ?? ''),
      s.challanNo,
      s.challanDate,
      s.goodsType === 'capital_goods' ? 'Capital Goods' : 'Inputs',
      s.description,
      s.hsn,
      s.uqc,
      s.qty,
      s.taxableValue,
      s.igstRate,
      s.cgstRate,
      s.sgstRate,
      s.cessRate,
    ]),
    totals: ['Total', '', '', '', '', '', '', '', null, r.sent.reduce((s, x) => s + x.taxableValue, 0), null, null, null, null],
    notes: 'Moulds, dies, jigs, fixtures and tools are listed as Inputs here; check the portal’s offline tool for the current layout before uploading.',
    landscape: true,
  };
}

export function itc04ReturnedExport(r: Itc04Result): ExportTable {
  return {
    title: 'ITC-04 — Tables 5A / 5B / 5C: goods received back, sent on, or supplied from the job worker',
    columns: [
      { header: 'Table' },
      { header: 'GSTIN of job worker' },
      { header: 'State (if unregistered)' },
      { header: 'Challan / invoice no.' },
      { header: 'Date', kind: 'date' },
      { header: 'Original challan no.' },
      { header: 'Original challan date', kind: 'date' },
      { header: 'Description of goods' },
      { header: 'UQC' },
      { header: 'Quantity', kind: 'qty', decimals: 3 },
      { header: 'Goods received (after processing)' },
      { header: 'UQC received' },
      { header: 'Quantity received', kind: 'qty', decimals: 3 },
      { header: 'Losses & wastes qty', kind: 'qty', decimals: 3 },
      { header: 'Nature of job work' },
    ],
    rows: r.returned.map((x) => [
      x.table,
      x.jobWorkerGstin ?? '',
      x.jobWorkerGstin ? '' : (x.jobWorkerState ?? ''),
      x.docNo,
      x.docDate,
      x.originalChallanNo,
      x.originalChallanDate,
      x.description,
      x.uqc,
      x.qty,
      x.receivedDescription,
      x.receivedUqc,
      x.receivedQty,
      x.lossesQty,
      x.natureOfJobWork,
    ]),
    notes: 'Original challans are matched first-in-first-out per job worker godown and item. Enter losses and wastes in the offline tool where they apply.',
    landscape: true,
  };
}

export const CLASS_LABEL: Readonly<Record<StockJournalClass, string>> = {
  manufacturing: 'Manufacturing',
  material_out: 'Material Out',
  material_in: 'Received from job worker',
};

export function productionExport(r: ProductionRegisterResult): ExportTable {
  return {
    title: 'Production Register',
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Voucher' },
      { header: 'Kind' },
      { header: 'Item' },
      { header: 'Unit' },
      { header: 'Quantity', kind: 'qty', decimals: 3 },
      { header: 'BOM' },
      { header: 'Job worker' },
      { header: 'Components consumed', kind: 'amount' },
      { header: 'Additional cost', kind: 'amount' },
      { header: 'By-products / scrap', kind: 'amount' },
      { header: 'Cost of production', kind: 'amount' },
      { header: 'Rate', kind: 'number', decimals: 2 },
      { header: 'BOM estimate (today)', kind: 'amount' },
    ],
    rows: r.rows.map((x) => [
      x.date,
      `${x.typeName} ${x.number ?? ''}`.trim(),
      CLASS_LABEL[x.class],
      x.itemName,
      x.unit,
      x.qty,
      x.bomName,
      x.partyName,
      x.consumed,
      x.additional,
      x.byProducts,
      x.productValue,
      x.productRate,
      x.bomEstimate,
    ]),
    totals: ['', 'Total', '', '', '', null, '', '', r.totals.consumed, r.totals.additional, r.totals.byProducts, r.totals.productValue, null, null],
    landscape: true,
  };
}

/** Banner text for the s.143 alerts, or null when nothing needs attention. */
export function alertText(a: { overdue: number; dueSoon: number; nextDue: string | null }): string | null {
  if (a.overdue === 0 && a.dueSoon === 0) return null;
  const parts: string[] = [];
  if (a.overdue > 0) parts.push(`${a.overdue} challan line${a.overdue === 1 ? ' is' : 's are'} past the return date — GST is payable on them as a supply made on the day they were sent`);
  if (a.dueSoon > 0) parts.push(`${a.dueSoon} due within 30 days${a.nextDue ? ` (first on ${formatDate(a.nextDue)})` : ''}`);
  return `${parts.join('; ')}.`;
}

export function bomListExport(rows: readonly BomListRow[]): ExportTable {
  return {
    title: 'Bills of Materials',
    columns: [
      { header: 'Finished item' },
      { header: 'BOM' },
      { header: 'For quantity', kind: 'qty', decimals: 3 },
      { header: 'Unit' },
      { header: 'Default' },
      { header: 'Active' },
      { header: 'Components', kind: 'number' },
      { header: 'By-products / scrap', kind: 'number' },
      { header: 'Revision', kind: 'number' },
    ],
    rows: rows.map((r) => [r.itemName, r.name, r.outputQty, r.unit, r.isDefault ? 'Yes' : 'No', r.isActive ? 'Yes' : 'No', r.components, r.byProducts, r.revision]),
  };
}

export function jobWorkOrdersExport(rows: readonly JobWorkOrderListRow[], direction: 'out' | 'in'): ExportTable {
  return {
    title: direction === 'out' ? 'Job Work Out Orders' : 'Job Work In Orders',
    columns: [
      { header: 'Date', kind: 'date' },
      { header: 'Order no.' },
      { header: direction === 'out' ? 'Job worker' : 'Principal' },
      { header: 'Item' },
      { header: 'Ordered', kind: 'qty', decimals: 3 },
      { header: 'Done', kind: 'qty', decimals: 3 },
      { header: 'Pending', kind: 'qty', decimals: 3 },
      { header: 'Unit' },
      { header: 'Due', kind: 'date' },
      { header: 'Status' },
    ],
    rows: rows.map((r) => [r.date, r.number, r.partyName, r.itemName, r.qty, r.productDoneQty, r.pendingQty, r.unit, r.dueDate, orderStatusText(r)]),
  };
}

/** "Open", "Overdue", "Closed". */
export function orderStatusText(r: Pick<JobWorkOrderListRow, 'status' | 'overdue'>): string {
  if (r.status === 'closed') return 'Closed';
  return r.overdue ? 'Overdue' : 'Open';
}

/** ITC-04 file name stem for the period, e.g. "ITC-04 Apr-2026 to Sep-2026". */
export function itc04Title(from: string, to: string): string {
  const m = (iso: string): string => formatDate(iso).slice(3);
  return `ITC-04 ${m(from)} to ${m(to)}`;
}
