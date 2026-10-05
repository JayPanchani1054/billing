/**
 * GSTIN / UIN validation.
 *
 * Layout of a normal GSTIN (15 chars): SS PPPPPPPPPP E Z C
 *   SS          state code (01–38, 97 …)
 *   PPPPPPPPPP  PAN of the holder
 *   E           entity number for the same PAN in that state (1–9, A–Z)
 *   Z           'Z' by default
 *   C           check character
 *
 * Check character (GSTN, a Luhn mod-36 variant) over the first 14 characters:
 *   value(c) = index in '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
 *   factor   = 1 for even positions (0-based), 2 for odd positions
 *   p        = value × factor;  addend = floor(p / 36) + (p mod 36)
 *   check    = CHARSET[(36 − (Σ addend mod 36)) mod 36]
 * The same check character is used on UIN / NRI / OIDAR / TDS / TCS registrations.
 */
import type { GstinKind, GstinValidation } from '../types/gst.ts';
import { getState, POS_OTHER_COUNTRIES } from './states.ts';

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Formats in match order. `regular` follows the generic layout; the others are special registrations. */
const FORMATS: ReadonlyArray<{ kind: GstinKind; re: RegExp }> = [
  { kind: 'regular', re: /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/ },
  { kind: 'tcs', re: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]C[0-9A-Z]$/ },
  { kind: 'tds', re: /^[0-9]{2}[A-Z]{4}[A-Z0-9][0-9]{4}[A-Z][0-9A-Z]D[0-9A-Z]$/ },
  { kind: 'oidar', re: /^99[0-9]{2}[A-Z]{3}[0-9]{5}OS[0-9A-Z]$/ },
  { kind: 'uin', re: /^[0-9]{4}[A-Z]{3}[0-9]{5}[UO]N[0-9A-Z]$/ },
  { kind: 'nri', re: /^[0-9]{4}[A-Z]{3}[0-9]{5}NR[0-9A-Z]$/ },
];

/** Trim, drop inner whitespace and upper-case. */
export function normalizeGstin(gstin: string | null | undefined): string {
  return (gstin ?? '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Check character for the first 14 characters of a GSTIN (input must be upper-case [0-9A-Z]).
 * Returns '' when the input is not 14 valid characters.
 */
export function gstinCheckChar(first14: string): string {
  if (!/^[0-9A-Z]{14}$/.test(first14)) return '';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARSET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** Full validation: length, format, known state code and check character. */
export function validateGstin(input: string | null | undefined): GstinValidation {
  const gstin = normalizeGstin(input);
  if (gstin === '') return { valid: false, error: 'GSTIN is empty' };
  if (gstin.length !== 15) return { valid: false, gstin, error: `GSTIN must be 15 characters (this one has ${gstin.length})` };
  if (!/^[0-9A-Z]{15}$/.test(gstin)) return { valid: false, gstin, error: 'GSTIN can contain only letters A–Z and digits 0–9' };

  const format = FORMATS.find((f) => f.re.test(gstin));
  if (!format) {
    return {
      valid: false,
      gstin,
      error: 'GSTIN format is invalid: expected a 2-digit state code, the 10-character PAN, an entity number, Z and a check character',
    };
  }

  const stateCode = gstin.slice(0, 2);
  const state = getState(stateCode);
  if (!state || stateCode === POS_OTHER_COUNTRIES) {
    return { valid: false, gstin, kind: format.kind, error: `GSTIN starts with an unknown state code (${stateCode})` };
  }

  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) {
    return {
      valid: false,
      gstin,
      kind: format.kind,
      stateCode,
      error: 'GSTIN check character does not match: one or more characters are mistyped',
    };
  }

  const panCandidate = gstin.slice(2, 12);
  const pan = (format.kind === 'regular' || format.kind === 'tcs') && PAN_RE.test(panCandidate) ? panCandidate : undefined;
  const out: GstinValidation = { valid: true, gstin, stateCode, kind: format.kind, special: format.kind !== 'regular' };
  if (pan) out.pan = pan;
  return out;
}

export function isValidGstin(input: string | null | undefined): boolean {
  return validateGstin(input).valid;
}

/** State code embedded in a GSTIN ('' when it does not start with two digits). */
export function gstinStateCode(gstin: string | null | undefined): string {
  const g = normalizeGstin(gstin);
  return /^\d{2}/.test(g) ? g.slice(0, 2) : '';
}

/** PAN embedded in a PAN-based GSTIN ('' when there is none). */
export function panFromGstin(gstin: string | null | undefined): string {
  const g = normalizeGstin(gstin);
  const pan = g.slice(2, 12);
  return g.length === 15 && PAN_RE.test(pan) ? pan : '';
}
