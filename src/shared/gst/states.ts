/**
 * GST state / union-territory codes (first two digits of a GSTIN, and the place-of-supply code).
 * Alpha codes follow the GST portal's state list.
 *
 * UTGST (instead of SGST) applies to intra-state supplies in Union Territories WITHOUT a legislature:
 * CGST Act s.2(114) — Andaman & Nicobar, Lakshadweep, Dadra & Nagar Haveli and Daman & Diu, Ladakh,
 * Chandigarh and "other territory". Delhi, Puducherry and Jammu & Kashmir have legislatures → SGST.
 */
import type { GstState } from '../types/gst.ts';

type Row = [code: string, name: string, alpha: string, flags?: { ut?: boolean; utgst?: boolean; legacy?: boolean; special?: boolean }];

const ROWS: readonly Row[] = [
  ['01', 'Jammu and Kashmir', 'JK', { ut: true }],
  ['02', 'Himachal Pradesh', 'HP'],
  ['03', 'Punjab', 'PB'],
  ['04', 'Chandigarh', 'CH', { ut: true, utgst: true }],
  ['05', 'Uttarakhand', 'UT'],
  ['06', 'Haryana', 'HR'],
  ['07', 'Delhi', 'DL', { ut: true }],
  ['08', 'Rajasthan', 'RJ'],
  ['09', 'Uttar Pradesh', 'UP'],
  ['10', 'Bihar', 'BR'],
  ['11', 'Sikkim', 'SK'],
  ['12', 'Arunachal Pradesh', 'AR'],
  ['13', 'Nagaland', 'NL'],
  ['14', 'Manipur', 'MN'],
  ['15', 'Mizoram', 'MZ'],
  ['16', 'Tripura', 'TR'],
  ['17', 'Meghalaya', 'ML'],
  ['18', 'Assam', 'AS'],
  ['19', 'West Bengal', 'WB'],
  ['20', 'Jharkhand', 'JH'],
  ['21', 'Odisha', 'OD'],
  ['22', 'Chhattisgarh', 'CT'],
  ['23', 'Madhya Pradesh', 'MP'],
  ['24', 'Gujarat', 'GJ'],
  // Merged into 26 from 26-Jan-2020; old registrations and documents still carry 25.
  ['25', 'Daman and Diu', 'DD', { ut: true, utgst: true, legacy: true }],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu', 'DN', { ut: true, utgst: true }],
  ['27', 'Maharashtra', 'MH'],
  // Pre-2014 undivided Andhra Pradesh; current Andhra Pradesh is 37.
  ['28', 'Andhra Pradesh (Old)', 'AP', { legacy: true }],
  ['29', 'Karnataka', 'KA'],
  ['30', 'Goa', 'GA'],
  ['31', 'Lakshadweep', 'LD', { ut: true, utgst: true }],
  ['32', 'Kerala', 'KL'],
  ['33', 'Tamil Nadu', 'TN'],
  ['34', 'Puducherry', 'PY', { ut: true }],
  ['35', 'Andaman and Nicobar Islands', 'AN', { ut: true, utgst: true }],
  ['36', 'Telangana', 'TS'],
  ['37', 'Andhra Pradesh', 'AD'],
  ['38', 'Ladakh', 'LA', { ut: true, utgst: true }],
  ['96', 'Other Countries', 'OC', { special: true }],
  // Offshore areas beyond the territorial waters; a Union territory for GST purposes (s.2(114)(f)).
  ['97', 'Other Territory', 'OT', { ut: true, utgst: true, special: true }],
  ['99', 'Centre Jurisdiction', 'CJ', { special: true }],
];

/** Every known code, in code order (legacy and pseudo-states included). */
export const GST_STATES: readonly GstState[] = ROWS.map(([code, name, alpha, f]) =>
  Object.freeze({
    code,
    name,
    alpha,
    isUnionTerritory: f?.ut ?? false,
    utgst: f?.utgst ?? false,
    legacy: f?.legacy ?? false,
    special: f?.special ?? false,
  }),
);

const BY_CODE: ReadonlyMap<string, GstState> = new Map(GST_STATES.map((s) => [s.code, s]));

/** Place-of-supply code for supplies outside India (exports, overseas recipients). */
export const POS_OTHER_COUNTRIES = '96';
export const STATE_OTHER_TERRITORY = '97';
export const STATE_CENTRE_JURISDICTION = '99';

/** Normalise '7', ' 07 ', 7 → '07'. Returns '' for anything that is not 1–2 digits. */
export function normalizeStateCode(code: string | number | null | undefined): string {
  if (code === null || code === undefined) return '';
  const s = String(code).trim();
  return /^\d{1,2}$/.test(s) ? s.padStart(2, '0') : '';
}

/** Look up a state by code ('27', '7' or 27). */
export function getState(code: string | number | null | undefined): GstState | undefined {
  return BY_CODE.get(normalizeStateCode(code));
}

export function isKnownStateCode(code: string | number | null | undefined): boolean {
  return getState(code) !== undefined;
}

/** State name for display ('' when unknown). */
export function stateName(code: string | number | null | undefined): string {
  return getState(code)?.name ?? '';
}

/** '27-Maharashtra' style label used on invoices and in GSTR place-of-supply columns. */
export function stateLabel(code: string | number | null | undefined): string {
  const s = getState(code);
  return s ? `${s.code}-${s.name}` : '';
}

/** Find a state by its name or alpha code (case-insensitive), e.g. 'maharashtra' or 'MH'. */
export function findState(nameOrAlpha: string): GstState | undefined {
  const q = nameOrAlpha.trim().toLowerCase();
  if (!q) return undefined;
  return (
    GST_STATES.find((s) => !s.legacy && (s.name.toLowerCase() === q || s.alpha.toLowerCase() === q)) ??
    GST_STATES.find((s) => s.name.toLowerCase() === q || s.alpha.toLowerCase() === q)
  );
}

export interface StateOption {
  value: string;
  label: string;
  alpha: string;
}

/**
 * Options for state pickers, sorted by name, excluding legacy codes.
 * `includeForeign` adds 96 Other Countries (place-of-supply pickers);
 * `includeSpecial` adds 97 Other Territory and 99 Centre Jurisdiction.
 */
export function stateOptions(opts: { includeForeign?: boolean; includeSpecial?: boolean } = {}): StateOption[] {
  return GST_STATES.filter((s) => {
    if (s.legacy) return false;
    if (s.code === POS_OTHER_COUNTRIES) return opts.includeForeign === true;
    if (s.special) return opts.includeSpecial === true;
    return true;
  })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ value: s.code, label: `${s.code} - ${s.name}`, alpha: s.alpha }));
}

/** True when intra-state supplies in this state attract CGST + UTGST (UT without legislature). */
export function isUtgstState(code: string | number | null | undefined): boolean {
  return getState(code)?.utgst ?? false;
}
