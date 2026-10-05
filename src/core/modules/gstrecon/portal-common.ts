/**
 * Types and helpers shared by the portal-file parsers (portal-json.ts, portal-xlsx.ts, parsers.ts).
 */
import type { PortalDocType, PortalFileFormat, PortalSection, ReconSource } from '../../../shared/types/gstrecon.ts';

/** One document parsed from a portal file. Amounts are paise, as on the document (unsigned). */
export interface ParsedPortalDoc {
  section: PortalSection;
  /** Counterparty GSTIN (supplier for 2A/2B, customer for GSTR-1); '' for B2CL / exports / CDNUR. */
  gstin: string;
  name: string | null;
  docType: PortalDocType;
  docNo: string;
  docDate: string;
  pos: string | null;
  reverseCharge: boolean;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoiceValue: number;
  rates: number[];
  itcAvailable: boolean | null;
  itcReason: string | null;
  filingStatus: string | null;
  supplierPeriod: string | null;
  filingDate: string | null;
  invoiceType: string | null;
  original: { docNo: string; docDate: string | null } | null;
  applicablePct: number | null;
  irn: string | null;
  irnDate: string | null;
  sourceType: string | null;
  /** Original data (JSON object or Excel row values) kept in gst_portal_docs.raw. */
  raw: unknown;
}

export interface ParsedPortalFile {
  kind: ReconSource;
  format: PortalFileFormat;
  /** GSTIN the return belongs to (the company's own), when the file says. */
  gstin: string | null;
  /** MMYYYY when the file says. */
  period: string | null;
  generatedOn: string | null;
  docs: ParsedPortalDoc[];
  /** Documents per section. */
  sections: Record<string, number>;
  /** Sections present but not reconciled, with their document counts. */
  skipped: Record<string, number>;
  warnings: string[];
}

export const KIND_LABELS: Readonly<Record<ReconSource, string>> = { gstr2b: 'GSTR-2B', gstr2a: 'GSTR-2A', gstr1: 'GSTR-1' };

/**
 * Collects warnings by category so a file with 2 000 similar problems produces one readable line
 * ("… (and 1 999 more like it)") instead of 2 000.
 */
export class Warnings {
  private readonly byKey = new Map<string, { first: string; count: number }>();
  private readonly order: string[] = [];

  add(key: string, message: string): void {
    const cur = this.byKey.get(key);
    if (cur) cur.count++;
    else {
      this.byKey.set(key, { first: message, count: 1 });
      this.order.push(key);
    }
  }

  list(): string[] {
    return this.order.map((k) => {
      const w = this.byKey.get(k) as { first: string; count: number };
      return w.count > 1 ? `${w.first} (and ${w.count - 1} more like it)` : w.first;
    });
  }
}

/** Increment a counter in a plain record. */
export function bump(rec: Record<string, number>, key: string, n = 1): void {
  if (n === 0) return;
  rec[key] = (rec[key] ?? 0) + n;
}

/** Distinct rates, ascending. */
export function uniqueRates(rates: readonly number[]): number[] {
  return [...new Set(rates)].sort((a, b) => a - b);
}
