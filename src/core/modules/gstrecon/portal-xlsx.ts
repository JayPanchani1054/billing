/**
 * GSTR-2B (and GSTR-2A) Excel workbook as downloaded from the GST portal.
 *
 * Sheets used: 'B2B', 'B2BA', 'B2B-CDNR', 'B2B-CDNRA' (names matched loosely). Headers span two rows
 * with merged group cells ('Invoice Details' over 'Invoice number | Invoice type | Invoice Date |
 * Invoice Value (₹)', 'Tax Amount' over 'Integrated Tax(₹) | Central Tax(₹) | State/UT Tax(₹) | Cess(₹)'),
 * below a few title rows. The header block is found by fuzzy header matching, never fixed positions:
 * every row (alone, or combined with the row below it) is scored by how many known columns it names.
 * Rows of the same document (one row per tax rate) are aggregated: amounts summed, value taken once.
 *
 * The return period and GSTIN are read from the 'Read me' sheet ('Financial Year' + 'Tax Period',
 * 'GSTIN') when present.
 */
import { normalizeGstin } from '../../../shared/gst/index.ts';
import type { PortalDocType, PortalSection, ReconSource } from '../../../shared/types/gstrecon.ts';
import { FileFormatError } from '../../lib/text.ts';
import { readXlsx, type XlsxValue } from '../../lib/xlsx.ts';
import { bump, KIND_LABELS, type ParsedPortalDoc, type ParsedPortalFile, uniqueRates, Warnings } from './portal-common.ts';
import {
  ITC_REASONS,
  isMonthPeriod,
  parseItcAvailability,
  parsePortalAmount,
  parsePortalDate,
  parseRate,
  parseStateCode,
  parseSupplierPeriod,
  parseYes,
  periodFromFyMonth,
} from './values.ts';

export type HeaderField =
  | 'gstin'
  | 'name'
  | 'docNo'
  | 'docType'
  | 'docDate'
  | 'value'
  | 'pos'
  | 'rcm'
  | 'rate'
  | 'taxable'
  | 'igst'
  | 'cgst'
  | 'sgst'
  | 'cess'
  | 'supplierPeriod'
  | 'filingDate'
  | 'itcAvailability'
  | 'reason'
  | 'applicablePct'
  | 'sourceType'
  | 'irn'
  | 'irnDate'
  | 'origNo'
  | 'origDate'
  | 'noteSupplyType';

/** Lower-case letters and digits only ('Invoice Value (₹)' → 'invoicevalue'). */
export function headerNorm(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const DOC_WORD = /invoice|note|document|doc/;

/** Map a header label to a field (null when not recognised). Order matters: most specific first. */
export function matchHeader(label: unknown): HeaderField | null {
  const h = headerNorm(label);
  if (!h) return null;
  if (h.includes('gstin')) return 'gstin';
  if (h.includes('tradelegalname') || h.includes('tradename') || h.includes('legalname') || (h.includes('name') && /supplier|party|trade/.test(h))) return 'name';
  if (h.includes('original') || h.startsWith('orig')) {
    if (h.includes('date')) return 'origDate';
    if (h.includes('number') || h.endsWith('no') || h.includes('num')) return 'origNo';
    return null;
  }
  if (h === 'irndate' || h.includes('irndate')) return 'irnDate';
  if (h === 'irn') return 'irn';
  if (h.includes('filingdate')) return 'filingDate';
  if (h.includes('period')) return 'supplierPeriod';
  if (h.includes('placeofsupply') || h === 'pos') return 'pos';
  if (h.includes('reversecharge')) return 'rcm';
  if (h.includes('taxablevalue') || h === 'taxable') return 'taxable';
  if (h.includes('integratedtax') || h.startsWith('igst')) return 'igst';
  if (h.includes('centraltax') || h.startsWith('cgst')) return 'cgst';
  if (h.includes('stateuttax') || h.includes('statetax') || h.startsWith('sgst') || h.startsWith('utgst')) return 'sgst';
  if (h.includes('cess')) return 'cess';
  if (h.includes('itcavailab')) return 'itcAvailability';
  if (h.includes('applicable')) return 'applicablePct';
  if (h.startsWith('reason')) return 'reason';
  if (h === 'source') return 'sourceType';
  if (h.includes('supplytype')) return 'noteSupplyType';
  if (DOC_WORD.test(h)) {
    if (h.includes('type')) return 'docType';
    if (h.includes('date')) return 'docDate';
    if (h.includes('value')) return 'value';
    if (h.includes('number') || h.endsWith('no') || h.includes('num')) return 'docNo';
    return null;
  }
  if (h === 'rate' || h === 'ratepercent' || h === 'taxrate' || h === 'rateofta' || h.startsWith('rate')) return 'rate';
  return null;
}

type Cells = readonly XlsxValue[];

interface HeaderMap {
  /** Index of the last header row. */
  end: number;
  cols: Map<HeaderField, number>;
}

const REQUIRED: readonly HeaderField[] = ['gstin', 'docNo', 'docDate'];

function mapRow(labels: readonly unknown[]): Map<HeaderField, number> {
  const cols = new Map<HeaderField, number>();
  labels.forEach((l, c) => {
    const f = matchHeader(l);
    if (f && !cols.has(f)) cols.set(f, c);
  });
  return cols;
}

/** Locate the header block in the first 40 rows (single row or two rows combined). */
export function findHeader(rows: readonly Cells[]): HeaderMap | null {
  let best: HeaderMap | null = null;
  const limit = Math.min(rows.length, 40);
  for (let r = 0; r < limit; r++) {
    const top = rows[r] ?? [];
    const candidates: HeaderMap[] = [{ end: r, cols: mapRow(top) }];
    if (r + 1 < rows.length) {
      const below = rows[r + 1] ?? [];
      const width = Math.max(top.length, below.length);
      const merged: unknown[] = [];
      for (let c = 0; c < width; c++) {
        const b = below[c];
        merged.push(b !== null && b !== undefined && String(b).trim() !== '' ? b : top[c]);
      }
      candidates.push({ end: r + 1, cols: mapRow(merged) });
    }
    for (const cand of candidates) {
      if (!REQUIRED.every((f) => cand.cols.has(f))) continue;
      if (!cand.cols.has('taxable') && !cand.cols.has('igst') && !cand.cols.has('cgst')) continue;
      if (!best || cand.cols.size > best.cols.size) best = cand;
    }
  }
  return best;
}

type SheetRole = { section: PortalSection; notes: boolean } | 'summary' | 'skip' | null;

function sheetRole(name: string): SheetRole {
  const n = headerNorm(name);
  if (n === 'b2b') return { section: 'b2b', notes: false };
  if (n === 'b2ba') return { section: 'b2ba', notes: false };
  if (n === 'b2bcdnr' || n === 'cdnr' || n === 'b2bcdn' || n === 'cdn') return { section: 'cdnr', notes: true };
  if (n === 'b2bcdnra' || n === 'cdnra' || n === 'b2bcdna' || n === 'cdna') return { section: 'cdnra', notes: true };
  if (/readme|itcavailable|itcnotavailable|itcreversal|itcrejected|summary|partb|parta|taxpayerdetails/.test(n)) return 'summary';
  if (/^(isd|isda|impg|impga|impgsez|impgseza|ecom|ecoma|tds|tcs|tdsa|tcsa)$/.test(n)) return 'skip';
  return null;
}

function cellText(v: XlsxValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

/** Return period / GSTIN from 'label | value' pairs in the first rows of any sheet. */
function workbookMeta(sheets: ReadonlyArray<{ name: string; rows: Cells[] }>): { period: string | null; gstin: string | null } {
  let fy: string | null = null;
  let month: string | null = null;
  let period: string | null = null;
  let gstin: string | null = null;
  for (const s of sheets) {
    for (const row of s.rows.slice(0, 15)) {
      for (let c = 0; c < row.length; c++) {
        const raw = cellText(row[c]);
        if (!raw) continue;
        let label = raw;
        let value = '';
        const colon = raw.indexOf(':');
        if (colon > 0) {
          label = raw.slice(0, colon);
          value = raw.slice(colon + 1).trim();
        }
        if (!value) {
          for (let k = c + 1; k < row.length; k++) {
            const t = cellText(row[k]);
            if (t) {
              value = t;
              break;
            }
          }
        }
        if (!value) continue;
        const key = headerNorm(label);
        if (key === 'financialyear' && !fy) fy = value;
        else if ((key === 'taxperiod' || key === 'returnperiod' || key === 'period') && !month) month = value;
        else if (key === 'gstin' && !gstin && normalizeGstin(value).length === 15) gstin = normalizeGstin(value);
      }
    }
  }
  if (month) {
    period = parseSupplierPeriod(month);
    if (!period && fy) period = periodFromFyMonth(month, fy);
  }
  return { period: period && isMonthPeriod(period) ? period : null, gstin };
}

interface Agg {
  doc: ParsedPortalDoc;
  rates: number[];
  rows: number[];
}

/** Parse a GSTR-2B / GSTR-2A Excel workbook. */
export function parsePortalXlsx(bytes: Uint8Array, kind: ReconSource): ParsedPortalFile {
  const label = `${KIND_LABELS[kind]} Excel`;
  const wb = readXlsx(bytes, { maxCells: 5_000_000 });
  const warn = new Warnings();
  const sections: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const docs: ParsedPortalDoc[] = [];
  let usable = 0;

  for (const sheet of wb.sheets) {
    const role = sheetRole(sheet.name);
    if (role === 'summary' || role === null) continue;
    const header = findHeader(sheet.rows);
    if (role === 'skip') {
      if (header) {
        const n = sheet.rows.slice(header.end + 1).filter((r) => r.some((v) => cellText(v) !== '')).length;
        if (n > 0) bump(skipped, sheet.name.toUpperCase(), n);
      }
      continue;
    }
    usable++;
    if (!header) {
      if (sheet.rows.some((r, i) => i > 3 && r.some((v) => cellText(v) !== ''))) {
        throw new FileFormatError(
          label,
          `Sheet "${sheet.name}": the column headings were not recognised (need at least GSTIN of supplier, invoice/note number, date and taxable value). Use the Excel file downloaded from the GST portal without editing the headings.`,
        );
      }
      continue;
    }
    const col = (f: HeaderField): number => header.cols.get(f) ?? -1;
    const get = (row: Cells, f: HeaderField): XlsxValue | undefined => {
      const i = col(f);
      return i < 0 ? undefined : row[i];
    };
    const byKey = new Map<string, Agg>();
    for (let r = header.end + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const excelRow = r + 1;
      const gstinText = cellText(get(row, 'gstin'));
      const docNo = cellText(get(row, 'docNo'));
      if (!gstinText && !docNo) continue;
      if (/^(grand\s*)?total/i.test(gstinText) || /^(grand\s*)?total/i.test(cellText(row[0]))) continue;
      const where = `Sheet "${sheet.name}", row ${excelRow}`;
      const gstin = normalizeGstin(gstinText);
      if (!/^[0-9A-Z]{15}$/.test(gstin)) {
        warn.add(`${sheet.name}:gstin`, `${where}: "${gstinText}" is not a GSTIN; the row was skipped`);
        continue;
      }
      if (!docNo) {
        warn.add(`${sheet.name}:docno`, `${where}: no document number; the row was skipped`);
        continue;
      }
      const dateRaw = get(row, 'docDate');
      const docDate = parsePortalDate(dateRaw);
      if (!docDate) {
        warn.add(`${sheet.name}:date`, `${where}: date "${cellText(dateRaw)}" is not a valid date; the row was skipped`);
        continue;
      }
      let docType: PortalDocType = 'invoice';
      if (role.notes) {
        const t = cellText(get(row, 'docType')).toUpperCase();
        if (t === 'C' || t.startsWith('CREDIT')) docType = 'credit_note';
        else if (t === 'D' || t.startsWith('DEBIT')) docType = 'debit_note';
        else {
          warn.add(`${sheet.name}:ntty`, `${where}: note type "${t}" is neither Credit Note nor Debit Note; the row was skipped`);
          continue;
        }
      }
      const amt = (f: HeaderField, what: string): number => {
        const v = get(row, f);
        const p = parsePortalAmount(v);
        if (p === null) throw new FileFormatError(label, `${where}: ${what} "${cellText(v)}" is not an amount`);
        return p;
      };
      const taxable = amt('taxable', 'taxable value');
      const igst = amt('igst', 'integrated tax');
      const cgst = amt('cgst', 'central tax');
      const sgst = amt('sgst', 'state/UT tax');
      const cess = amt('cess', 'cess');
      const value = amt('value', 'document value');
      const rate = parseRate(get(row, 'rate'));
      const key = [docType, gstin, docNo.toUpperCase(), docDate].join('|');
      const cur = byKey.get(key);
      if (cur) {
        cur.doc.taxable += taxable;
        cur.doc.igst += igst;
        cur.doc.cgst += cgst;
        cur.doc.sgst += sgst;
        cur.doc.cess += cess;
        if (value > cur.doc.invoiceValue) cur.doc.invoiceValue = value;
        if (rate !== null && taxable !== 0) cur.rates.push(rate);
        cur.rows.push(excelRow);
        continue;
      }
      const posRaw = get(row, 'pos');
      const pos = parseStateCode(posRaw);
      if (cellText(posRaw) && pos === null) warn.add(`${sheet.name}:pos`, `${where}: place of supply "${cellText(posRaw)}" is not a known state`);
      const reason = cellText(get(row, 'reason'));
      const pctRaw = get(row, 'applicablePct');
      const pct = pctRaw === null || pctRaw === undefined || cellText(pctRaw) === '' ? null : Number(String(pctRaw).replace('%', ''));
      const origNo = cellText(get(row, 'origNo'));
      const values: Record<string, XlsxValue> = {};
      for (const [f, i] of header.cols) values[f] = row[i] ?? null;
      const doc: ParsedPortalDoc = {
        section: role.section,
        gstin,
        name: cellText(get(row, 'name')) || null,
        docType,
        docNo,
        docDate,
        pos,
        reverseCharge: parseYes(get(row, 'rcm')),
        taxable,
        igst,
        cgst,
        sgst,
        cess,
        invoiceValue: value,
        rates: [],
        itcAvailable: parseItcAvailability(get(row, 'itcAvailability')),
        itcReason: reason ? (ITC_REASONS[reason.toUpperCase()] ? `${reason}: ${ITC_REASONS[reason.toUpperCase()]}` : reason) : null,
        filingStatus: null,
        supplierPeriod: parseSupplierPeriod(get(row, 'supplierPeriod')),
        filingDate: parsePortalDate(get(row, 'filingDate')),
        invoiceType: cellText(get(row, role.notes ? 'noteSupplyType' : 'docType')) || null,
        original: origNo ? { docNo: origNo, docDate: parsePortalDate(get(row, 'origDate')) } : null,
        applicablePct: pct !== null && Number.isFinite(pct) ? (pct <= 1 ? Math.round(pct * 10000) / 100 : pct) : null,
        irn: cellText(get(row, 'irn')) || null,
        irnDate: parsePortalDate(get(row, 'irnDate')),
        sourceType: cellText(get(row, 'sourceType')) || null,
        raw: { sheet: sheet.name, rows: [excelRow], values },
      };
      byKey.set(key, { doc, rates: rate !== null && taxable !== 0 ? [rate] : [], rows: [excelRow] });
    }
    for (const agg of byKey.values()) {
      agg.doc.rates = uniqueRates(agg.rates);
      (agg.doc.raw as { rows: number[] }).rows = agg.rows;
      docs.push(agg.doc);
      bump(sections, role.section);
    }
  }
  if (usable === 0) {
    throw new FileFormatError(
      label,
      `No "B2B" or "B2B-CDNR" sheet was found. Use the ${KIND_LABELS[kind]} Excel file downloaded from the GST portal (it has sheets named B2B and B2B-CDNR).`,
    );
  }
  if (docs.length === 0) warn.add('empty', 'The workbook has no documents to reconcile');
  const meta = workbookMeta(wb.sheets);
  return {
    kind,
    format: 'xlsx',
    gstin: meta.gstin,
    period: meta.period,
    generatedOn: null,
    docs,
    sections,
    skipped,
    warnings: warn.list(),
  };
}
