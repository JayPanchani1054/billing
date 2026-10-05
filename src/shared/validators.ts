/**
 * Indian identifier and contact validators for forms (renderer) and services (core).
 * Each validator returns a user-readable error message, or null when the value is valid.
 * Validators are forgiving about case and surrounding spaces; store the `normalize*` result.
 * An empty value is reported as an error — callers skip optional fields that are blank.
 */
import { validateGstin } from './gst/gstin.ts';

const clean = (s: string | null | undefined): string => (s ?? '').trim();
const compactUpper = (s: string | null | undefined): string => clean(s).replace(/\s+/g, '').toUpperCase();

// ───────────────────────────── PAN / TAN / CIN ─────────────────────────────

/** 4th character of a PAN → holder type (Income-tax Department list). */
export const PAN_ENTITY_TYPES: Readonly<Record<string, string>> = {
  A: 'Association of Persons',
  B: 'Body of Individuals',
  C: 'Company',
  F: 'Firm / LLP',
  G: 'Government',
  H: 'Hindu Undivided Family',
  J: 'Artificial Juridical Person',
  L: 'Local Authority',
  P: 'Individual',
  T: 'Trust',
};

export function normalizePan(pan: string | null | undefined): string {
  return compactUpper(pan);
}

/** PAN: AAAAA9999A where the 4th letter is the holder type (P, C, H, F, A, T, B, L, J, G). */
export function validatePan(pan: string | null | undefined): string | null {
  const p = normalizePan(pan);
  if (!p) return 'PAN is empty';
  if (p.length !== 10) return `PAN must be 10 characters (this one has ${p.length})`;
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) return 'PAN format is invalid: expected 5 letters, 4 digits and a letter (e.g. ABCPE1234F)';
  if (!(p[3] in PAN_ENTITY_TYPES)) return `PAN 4th character '${p[3]}' is not a valid holder type (P, C, H, F, A, T, B, L, J or G)`;
  return null;
}

/** Holder type described by a PAN's 4th character ('' when unknown). */
export function panEntityType(pan: string | null | undefined): string {
  const p = normalizePan(pan);
  return p.length === 10 ? (PAN_ENTITY_TYPES[p[3]] ?? '') : '';
}

/** TAN: AAAA99999A. */
export function validateTan(tan: string | null | undefined): string | null {
  const t = compactUpper(tan);
  if (!t) return 'TAN is empty';
  if (!/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(t)) return 'TAN format is invalid: expected 4 letters, 5 digits and a letter (e.g. MUMA12345B)';
  return null;
}

/** Corporate Identification Number: L/U + 5-digit industry + state + year + type + 6-digit number. */
export function validateCin(cin: string | null | undefined): string | null {
  const c = compactUpper(cin);
  if (!c) return 'CIN is empty';
  if (!/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(c)) return 'CIN format is invalid (21 characters, e.g. U72200MH2009PTC123456)';
  return null;
}

/** GSTIN (format + state + check character) as a form validator. */
export function validateGstinInput(gstin: string | null | undefined): string | null {
  const r = validateGstin(gstin);
  return r.valid ? null : (r.error ?? 'GSTIN is invalid');
}

// ───────────────────────────── Banking ─────────────────────────────

export function normalizeIfsc(ifsc: string | null | undefined): string {
  return compactUpper(ifsc);
}

/** IFSC: 4-letter bank code, '0', 6-character branch code. */
export function validateIfsc(ifsc: string | null | undefined): string | null {
  const i = normalizeIfsc(ifsc);
  if (!i) return 'IFSC is empty';
  if (i.length !== 11) return `IFSC must be 11 characters (this one has ${i.length})`;
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(i)) return 'IFSC format is invalid: 4 letters, then 0, then 6 letters/digits (e.g. HDFC0001234)';
  return null;
}

/** UPI VPA: handle@provider, e.g. shop.name@okhdfcbank. */
export function validateUpiId(upi: string | null | undefined): string | null {
  const u = clean(upi);
  if (!u) return 'UPI ID is empty';
  if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/.test(u)) return 'UPI ID is invalid: expected name@bank (e.g. shop@okhdfcbank)';
  return null;
}

/** Bank account number: 6–20 digits (some banks use letters; spaces allowed while typing). */
export function validateBankAccountNo(acc: string | null | undefined): string | null {
  const a = compactUpper(acc);
  if (!a) return 'Account number is empty';
  if (!/^[0-9A-Z]{6,20}$/.test(a) || !/[0-9]/.test(a)) return 'Account number must be 6–20 digits';
  return null;
}

// ───────────────────────────── Address & contact ─────────────────────────────

/** Indian PIN code: 6 digits, not starting with 0. */
export function validatePincode(pin: string | null | undefined): string | null {
  const p = clean(pin).replace(/\s+/g, '');
  if (!p) return 'PIN code is empty';
  if (!/^[0-9]{6}$/.test(p)) return 'PIN code must be 6 digits';
  if (p[0] === '0') return 'PIN code cannot start with 0';
  return null;
}

export function validateEmail(email: string | null | undefined): string | null {
  const e = clean(email);
  if (!e) return 'Email is empty';
  if (e.length > 254) return 'Email address is too long';
  const at = e.lastIndexOf('@');
  if (at < 1 || at !== e.indexOf('@')) return 'Email address must contain one @ (e.g. accounts@example.com)';
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return 'Email address has an invalid name before the @';
  }
  if (!/^(?=.{4,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain)) {
    return 'Email address has an invalid domain after the @';
  }
  return null;
}

/** Indian mobile number → '9876543210' ('' when it cannot be normalised). Accepts +91 / 91 / 0 prefixes. */
export function normalizeMobile(mobile: string | null | undefined): string {
  let m = clean(mobile).replace(/[\s()-]/g, '');
  if (m.startsWith('+91')) m = m.slice(3);
  else if (m.length === 12 && m.startsWith('91')) m = m.slice(2);
  else if (m.length === 11 && m.startsWith('0')) m = m.slice(1);
  return /^[6-9][0-9]{9}$/.test(m) ? m : '';
}

/** Indian 10-digit mobile starting 6–9, optionally prefixed by +91, 91 or 0. */
export function validateMobile(mobile: string | null | undefined): string | null {
  if (!clean(mobile)) return 'Mobile number is empty';
  if (!normalizeMobile(mobile)) return 'Mobile number must be 10 digits starting with 6, 7, 8 or 9 (optionally with +91)';
  return null;
}

// ───────────────────────────── HSN / SAC ─────────────────────────────

/**
 * HSN (goods) or SAC (services) code: 4, 6 or 8 digits. SAC codes start with 99 (chapter 99);
 * HSN chapters run 01–98. Pass `kind` to enforce goods vs services.
 */
export function validateHsnSac(code: string | null | undefined, kind?: 'goods' | 'services'): string | null {
  const c = clean(code).replace(/\s+/g, '');
  if (!c) return 'HSN/SAC is empty';
  if (!/^[0-9]+$/.test(c)) return 'HSN/SAC must contain digits only';
  if (c.length !== 4 && c.length !== 6 && c.length !== 8) return 'HSN/SAC must be 4, 6 or 8 digits';
  if (c.startsWith('00')) return 'HSN/SAC cannot start with 00';
  const isSac = c.startsWith('99');
  if (kind === 'services' && !isSac) return 'SAC (services) codes start with 99';
  if (kind === 'goods' && isSac) return 'Codes starting with 99 are SAC (services) codes, not HSN';
  return null;
}

/** True when the code is a services accounting code (chapter 99). */
export function isSacCode(code: string | null | undefined): boolean {
  return /^99[0-9]{2,6}$/.test(clean(code));
}
