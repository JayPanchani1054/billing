/**
 * Pure logic of the XML data export screen (data.xmlExport): what is wrong with the choices, and
 * the result summary rows. Tested in xmlExportView.test.ts.
 */
import type { XmlExportMasterCounts, XmlExportResult } from '../../../../shared/types/data.ts';

export interface XmlExportChoices {
  masters: boolean;
  vouchers: boolean;
  from: string | null;
  to: string | null;
}

/** Why the export cannot run yet (null = ready), written for the user. */
export function xmlExportProblem(c: XmlExportChoices): string | null {
  if (!c.masters && !c.vouchers) return 'Tick masters, vouchers or both.';
  if (c.vouchers) {
    if (!c.from || !c.to) return 'Enter both dates of the period.';
    if (c.from > c.to) return 'The “from” date is after the “to” date.';
  }
  return null;
}

const MASTER_ROWS: ReadonlyArray<[keyof XmlExportMasterCounts, string]> = [
  ['groups', 'Groups (your own)'],
  ['ledgers', 'Ledgers'],
  ['costCategories', 'Cost categories'],
  ['costCentres', 'Cost centres'],
  ['units', 'Units'],
  ['godowns', 'Godowns'],
  ['stockGroups', 'Stock groups'],
  ['stockCategories', 'Stock categories'],
  ['stockItems', 'Stock items'],
  ['voucherTypes', 'Voucher types (your own)'],
];

export interface XmlExportSummaryRow {
  key: string;
  label: string;
  value: string;
}

const n = (x: number): string => x.toLocaleString('en-IN');

/** 'YYYY-MM-DD' → '01-Oct-2026'. */
function dayText(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d}-${months[Number(m) - 1] ?? m}-${y}`;
}

/**
 * The date the masters' opening balances will be written at (null without masters): the period's
 * first day when vouchers of a period after the books beginning go with them, else the books beginning.
 */
export function openingsDate(c: XmlExportChoices, booksFrom: string): string | null {
  if (!c.masters) return null;
  return c.vouchers && c.from && c.from > booksFrom ? c.from : booksFrom;
}

/** One line under the choices: what the opening balances in the file will be. */
export function openingsNote(c: XmlExportChoices, booksFrom: string): string | null {
  const at = openingsDate(c, booksFrom);
  if (at === null) return null;
  return at === booksFrom
    ? `Opening balances, bills and stock as entered at the books beginning (${dayText(booksFrom)}).`
    : `Opening balances, pending bills and stock as on ${dayText(at)} (the start of the period), so that the company you load it into can begin its books on that date.`;
}

/** What went into the file: masters by kind (non-zero ones), vouchers, and what was left out and why. */
export function xmlExportSummary(r: Pick<XmlExportResult, 'masters' | 'vouchers' | 'skipped'> & { openingsAsOf?: string | null }, vouchersAsked: boolean): XmlExportSummaryRow[] {
  const rows: XmlExportSummaryRow[] = [];
  if (r.openingsAsOf) rows.push({ key: 'openings', label: 'Opening balances as on', value: dayText(r.openingsAsOf) });
  if (r.masters) {
    for (const [k, label] of MASTER_ROWS) if (r.masters[k] > 0) rows.push({ key: `m:${k}`, label, value: n(r.masters[k]) });
  }
  if (vouchersAsked) rows.push({ key: 'vouchers', label: 'Vouchers', value: n(r.vouchers) });
  for (const s of r.skipped) rows.push({ key: `skip:${s.reason}`, label: `Not exported: ${s.reason}`, value: n(s.count) });
  return rows;
}

/** The steps to load the file in the other accounting program (shown after saving). */
export function xmlImportSteps(isZip: boolean, openingsAsOf: string | null = null): string[] {
  return [
    ...(isZip ? ['Extract the .zip file (right-click › Extract All).'] : []),
    openingsAsOf
      ? `Open the company in the other accounting program (create it first, with books beginning on ${dayText(openingsAsOf)} and the same GST details).`
      : 'Open the company in the other accounting program (create it first, with the same books beginning date and GST details).',
    ...(isZip
      ? ['In that program choose Import › Masters and pick 1-Masters.xml (skip this when you exported vouchers only).', 'Then Import › Transactions: choose 2-Vouchers.xml (or Vouchers.xml).']
      : ['In that program choose Import › Masters and pick the .xml file.']),
    'Check the Trial Balance and Stock Summary there against this app for the same period.',
  ];
}
