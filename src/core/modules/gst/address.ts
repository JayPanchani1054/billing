/**
 * Address helpers for the e-invoice and e-way bill files, which want an address split into
 * line 1 / line 2 / place and a 6-digit PIN code.
 */
import { stateName } from '../../../shared/gst/index.ts';

export interface SplitAddress {
  addr1: string;
  addr2: string;
  /** Place / city (3–50 characters for the IRP). */
  loc: string;
}

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max).trim() : s);

/**
 * Split a free-text address (lines or comma-separated parts) into line 1, line 2 and place.
 * PIN codes inside the text are dropped (the PIN is sent separately). The place falls back to the
 * state name when the address has a single part.
 */
export function splitAddress(address: string | null | undefined, stateCode: string): SplitAddress {
  const text = (address ?? '').replace(/\b[1-9]\d{2}\s?\d{3}\b/g, ' ');
  let parts = text
    .split(/\r?\n/)
    .map((p) => p.replace(/\s+/g, ' ').replace(/^[,\s-]+|[,\s-]+$/g, '').trim())
    .filter((p) => p !== '');
  if (parts.length === 1 && parts[0].includes(',')) {
    parts = parts[0]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
  }
  const state = stateName(stateCode);
  if (parts.length === 0) return { addr1: '', addr2: '', loc: clip(state, 50) };
  if (parts.length === 1) return { addr1: clip(parts[0], 100), addr2: '', loc: clip(state, 50) };
  const loc = parts[parts.length - 1];
  const middle = parts.slice(1, -1).join(', ');
  return { addr1: clip(parts[0], 100), addr2: clip(middle, 100), loc: clip(loc.length >= 3 ? loc : state || loc, 50) };
}

/** 6-digit PIN code as a number, or null. */
export function pinNumber(pin: string | null | undefined): number | null {
  const p = (pin ?? '').replace(/\s+/g, '');
  return /^[1-9]\d{5}$/.test(p) ? Number(p) : null;
}

/** Phone digits for the IRP (6–12 digits), or null. */
export function phoneDigits(phone: string | null | undefined): string | null {
  let d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return d.length >= 6 && d.length <= 12 ? d : null;
}

export function emailOrNull(email: string | null | undefined): string | null {
  const e = (email ?? '').trim();
  return e.length >= 6 && e.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
