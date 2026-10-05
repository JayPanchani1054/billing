/**
 * Company identity validation shared by 'app.company.create' and 'company.profile.save':
 * field schemas, Indian registration-number formats, and cross-field GST rules.
 */
import type { FieldIssue } from '../../../shared/api.ts';
import { validateGstin } from '../../../shared/gst/gstin.ts';
import type { GstRegistrationType } from '../../../shared/types/company.ts';
import { validation } from '../../lib/errors.ts';
import { v } from '../../lib/validate.ts';

/**
 * GST state codes a company can be registered in (01–38, 97 = Other Territory).
 * 25 (Daman & Diu) and 28 (old Andhra Pradesh) are legacy but still appear on old registrations.
 */
export const COMPANY_STATE_CODES: readonly string[] = [
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')),
  '97',
];

export const GST_REGISTRATION_TYPES = ['regular', 'composition', 'unregistered'] as const;

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
export const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
export const PINCODE_RE = /^[1-9][0-9]{5}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Structural GSTIN check: 2-digit state code + 13 alphanumerics. */
const GSTIN_SHAPE_RE = /^[0-9]{2}[0-9A-Z]{13}$/;
/** Normal-taxpayer layout: state(2) PAN(10) entity(1) 'Z'(1) checksum(1). */
const GSTIN_PAN_LAYOUT_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][A-Z0-9][0-9A-Z]$/;

const upper = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return t === '' ? null : t;
};
const text = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

/**
 * GSTIN check for the company's own registration: structure, PAN layout, check character
 * (shared/gst/gstin.ts validateGstin) and consistency with the selected state.
 */
export function checkGstin(gstin: string, stateCode: string | null): string | null {
  if (gstin.length !== 15) return 'GSTIN must be exactly 15 characters';
  if (!GSTIN_SHAPE_RE.test(gstin)) return 'GSTIN has an invalid format (2-digit state code followed by 13 letters/digits)';
  if (!GSTIN_PAN_LAYOUT_RE.test(gstin)) return 'GSTIN has an invalid format (characters 3–12 must be the PAN)';
  const full = validateGstin(gstin);
  if (!full.valid) return full.error ?? 'GSTIN is not valid';
  if (stateCode && gstin.slice(0, 2) !== stateCode)
    return `GSTIN state code (${gstin.slice(0, 2)}) does not match the selected state (${stateCode})`;
  return null;
}

/** Field schemas common to company create and profile save. */
export const companyFieldShape = {
  name: v.string({ min: 1, max: 120 }),
  mailingName: v.string({ max: 200 }).nullable().optional(),
  address: v.string({ max: 500 }).nullable().optional(),
  stateCode: v.string({ min: 2, max: 2 }).refine((s) => (COMPANY_STATE_CODES.includes(s) ? null : 'Select a valid state')),
  country: v.string({ max: 60 }).nullable().optional(),
  pincode: v.string({ max: 10 }).nullable().optional(),
  phone: v.string({ max: 40 }).nullable().optional(),
  mobile: v.string({ max: 40 }).nullable().optional(),
  email: v.string({ max: 120 }).nullable().optional(),
  website: v.string({ max: 200 }).nullable().optional(),
  gstRegistrationType: v.enum(GST_REGISTRATION_TYPES),
  gstin: v.string({ max: 20 }).nullable().optional(),
  pan: v.string({ max: 12 }).nullable().optional(),
  booksFrom: v.date(),
  fyStartMonth: v.int({ min: 1, max: 12 }).optional(),
};

export interface CompanyIdentityInput {
  name: string;
  mailingName?: string | null;
  address?: string | null;
  stateCode: string;
  country?: string | null;
  pincode?: string | null;
  phone?: string | null;
  mobile?: string | null;
  email?: string | null;
  website?: string | null;
  gstRegistrationType: GstRegistrationType;
  gstin?: string | null;
  pan?: string | null;
  tan?: string | null;
  cin?: string | null;
  booksFrom: string;
  fyStartMonth?: number;
}

/** Normalised identity, ready for the `company` table. */
export interface NormalizedCompany {
  name: string;
  mailingName: string;
  address: string | null;
  stateCode: string;
  country: string;
  pincode: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  website: string | null;
  gstRegistrationType: GstRegistrationType;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  cin: string | null;
  booksFrom: string;
  fyStartMonth: number;
}

/**
 * Normalise and cross-validate company identity. Throws AppError('VALIDATION') listing every issue.
 *  - GSTIN/PAN/TAN/CIN upper-cased; empty strings → null; mailing name defaults to the name.
 *  - GSTIN is required for regular/composition and ignored for unregistered businesses.
 *  - PAN defaults to the PAN embedded in the GSTIN and must match it when both are given.
 */
export function normalizeCompanyIdentity(input: CompanyIdentityInput): NormalizedCompany {
  const issues: FieldIssue[] = [];
  const name = input.name.trim();
  const reg = input.gstRegistrationType;
  const gstin = reg === 'unregistered' ? null : upper(input.gstin);
  let pan = upper(input.pan);
  const tan = upper(input.tan);
  const cin = upper(input.cin);
  const pincode = text(input.pincode);
  const email = text(input.email);

  if (reg !== 'unregistered' && !gstin) issues.push({ path: 'gstin', message: 'GSTIN is required for a GST-registered business' });
  if (gstin) {
    const err = checkGstin(gstin, input.stateCode);
    if (err) issues.push({ path: 'gstin', message: err });
    else if (!pan) pan = gstin.slice(2, 12);
    else if (pan !== gstin.slice(2, 12)) issues.push({ path: 'pan', message: 'PAN does not match the PAN inside the GSTIN' });
  }
  if (pan && !PAN_RE.test(pan)) issues.push({ path: 'pan', message: 'PAN must look like ABCDE1234F' });
  if (tan && !TAN_RE.test(tan)) issues.push({ path: 'tan', message: 'TAN must look like ABCD12345E' });
  if (cin && !CIN_RE.test(cin)) issues.push({ path: 'cin', message: 'CIN must be 21 characters, e.g. U12345MH2020PTC123456' });
  if (pincode && !PINCODE_RE.test(pincode)) issues.push({ path: 'pincode', message: 'PIN code must be 6 digits' });
  if (email && !EMAIL_RE.test(email)) issues.push({ path: 'email', message: 'Enter a valid email address' });
  const fyStartMonth = input.fyStartMonth ?? 4;
  if (issues.length) throw validation(issues);

  return {
    name,
    mailingName: text(input.mailingName) ?? name,
    address: text(input.address),
    stateCode: input.stateCode,
    country: text(input.country) ?? 'India',
    pincode,
    phone: text(input.phone),
    mobile: text(input.mobile),
    email,
    website: text(input.website),
    gstRegistrationType: reg,
    gstin,
    pan,
    tan,
    cin,
    booksFrom: input.booksFrom,
    fyStartMonth,
  };
}
