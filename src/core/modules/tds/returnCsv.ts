/**
 * Quarterly statement data (26Q / 27Q / 27EQ) as two CSV files: deductee (or collectee) rows and
 * challan rows.
 *
 * IMPORTANT — format: this is NOT the NSDL/Protean FVU text file and NOT a verbatim copy of the RPU
 * (Return Preparation Utility) sheets. The column ORDER of the RPU deductee annexure has changed between
 * RPU versions and is not reproduced here with certainty; instead the files carry, under plain headers,
 * every field the RPU deductee / challan sheets ask for (challan serial, BSR code, deposit date, challan
 * serial number, section, deductee code, PAN, name, payment date, amount paid/credited, tax, deposited,
 * deduction date, rate, reason code, certificate number). Copy the columns into the RPU — or give the
 * files to your tax practitioner. Reason codes: A = lower/nil deduction under a s.197 certificate,
 * C = higher rate because the deductee has no valid PAN (as used in the 26Q annexure; verify against
 * the current FVU before filing). Amounts are rupees with two decimals.
 */
import { formatDate } from '../../../shared/dates.ts';
import type { Paise } from '../../../shared/money.ts';
import type { TdsReturnData } from '../../../shared/types/tds.ts';
import { toCsv } from '../../lib/csv.ts';

const rupees = (p: Paise): string => (p / 100).toFixed(2);
const d = (iso: string | null): string => (iso ? formatDate(iso, 'DD/MM/YYYY') : '');

export const DEDUCTEE_HEADERS = [
  'Sr. No.',
  'Challan Sr. No.',
  'BSR Code',
  'Date of Deposit',
  'Challan Serial No.',
  'Section Code',
  'Deductee Code (01 Company / 02 Other than company)',
  'PAN of Deductee',
  'Name of Deductee',
  'Date of Payment / Credit',
  'Amount Paid / Credited',
  'TDS',
  'Surcharge',
  'Education Cess',
  'Total Tax Deducted',
  'Total Tax Deposited',
  'Date of Deduction',
  'Rate of Deduction (%)',
  'Reason for Lower / Higher / Non-deduction',
  'Certificate No. (s.197)',
  'Voucher No.',
] as const;

export const CHALLAN_HEADERS = [
  'Challan Sr. No.',
  'Section Code',
  'Month of Deduction',
  'BSR Code',
  'Date of Deposit',
  'Challan Serial No.',
  'Minor Head',
  'TDS / TCS',
  'Surcharge',
  'Education Cess',
  'Interest',
  'Fee (s.234E)',
  'Others',
  'Total Deposited',
  'Allocated to Deductees',
] as const;

export function deducteeCsv(r: TdsReturnData): string {
  const rows = r.deductees.map((x, i) => [
    i + 1,
    x.challanSr ?? '',
    x.bsrCode ?? '',
    d(x.depositDate),
    x.challanNo ?? '',
    x.section,
    x.deducteeCode,
    x.pan,
    x.name,
    d(x.paymentDate),
    rupees(x.amountPaid),
    rupees(x.tax),
    '0.00',
    '0.00',
    rupees(x.tax),
    rupees(x.deposited),
    d(x.deductionDate),
    x.rate.toFixed(4).replace(/\.?0+$/, ''),
    x.reasonCode,
    x.certificateNo ?? '',
    x.voucherNumber ?? '',
  ]);
  return toCsv([[...DEDUCTEE_HEADERS], ...rows], { bom: true });
}

export function challanCsv(r: TdsReturnData): string {
  const rows = r.challans.map((c) => [
    c.sr,
    c.section,
    c.period,
    c.bsrCode,
    d(c.depositDate),
    c.challanNo,
    c.minorHead,
    rupees(c.tax),
    rupees(c.surcharge),
    rupees(c.cess),
    rupees(c.interest),
    rupees(c.fee),
    rupees(c.others),
    rupees(c.total),
    rupees(c.allocated),
  ]);
  return toCsv([[...CHALLAN_HEADERS], ...rows], { bom: true });
}

export function returnFileName(r: TdsReturnData, part: 'deductees' | 'challans'): string {
  const tan = r.tan || 'TAN';
  return `${tan}_${r.form}_Q${r.quarter}_${r.fyStart}-${String(r.fyStart + 1).slice(-2)}_${part}.csv`;
}
