/**
 * Live GSTIN handling for party ledgers: checksum validation as you type, auto-fill of state,
 * PAN and registration type from a valid GSTIN, and the same registration-type rules as the core
 * (src/core/modules/accounts/ledgerRules.ts validateParty). Pure — tested in gstin.test.ts.
 */
import { normalizeGstin, validateGstin } from '../../../../shared/gst/gstin.ts';
import { getState, stateName } from '../../../../shared/gst/states.ts';
import { normalizePan } from '../../../../shared/validators.ts';
import type { GstinKind } from '../../../../shared/types/gst.ts';
import type { RegistrationType } from '../../../../shared/types/gst.ts';

/** Registration types that need a GSTIN / must not have one (same sets as the core). */
export const NEEDS_GSTIN: ReadonlySet<RegistrationType> = new Set<RegistrationType>(['regular', 'composition', 'sez', 'uin', 'deemed_export']);
export const NO_GSTIN: ReadonlySet<RegistrationType> = new Set<RegistrationType>(['consumer', 'unregistered']);

export const REGISTRATION_OPTIONS: ReadonlyArray<{ value: RegistrationType; label: string; hint: string }> = [
  { value: 'regular', label: 'Regular', hint: 'GST-registered business (B2B invoices)' },
  { value: 'composition', label: 'Composition', hint: 'Composition dealer — issues bills of supply' },
  { value: 'unregistered', label: 'Unregistered', hint: 'Business without a GSTIN' },
  { value: 'consumer', label: 'Consumer', hint: 'End customer, not a business' },
  { value: 'sez', label: 'SEZ', hint: 'Unit or developer in a Special Economic Zone' },
  { value: 'deemed_export', label: 'Deemed export', hint: 'Supplies treated as exports (e.g. to EOUs)' },
  { value: 'overseas', label: 'Overseas', hint: 'Party outside India (exports / imports)' },
  { value: 'uin', label: 'UIN holder', hint: 'UN body or embassy with a UIN' },
];

export function registrationLabel(r: RegistrationType | null | undefined): string {
  return REGISTRATION_OPTIONS.find((o) => o.value === r)?.label ?? '';
}

export interface GstinFields {
  gstin: string;
  stateCode: string;
  pan: string;
  registrationType: RegistrationType | '';
}

export interface GstinAutofill extends GstinFields {
  valid: boolean;
  kind?: GstinKind;
  /** What was filled, for a quiet hint ("State and PAN filled from the GSTIN"). */
  filled: Array<'state' | 'pan' | 'registration'>;
}

/**
 * Apply a typed GSTIN. While incomplete or invalid only the text changes. Once it is valid the
 * state and PAN embedded in it are filled (they cannot differ from the GSTIN), and a party marked
 * Unregistered/Consumer (or not yet classified) becomes Regular — or UIN holder for a UIN.
 */
export function applyGstin(current: GstinFields, raw: string): GstinAutofill {
  const gstin = normalizeGstin(raw).slice(0, 15);
  // Clearing the GSTIN of a 'regular' party makes it unregistered again (same as the core), instead of
  // blocking the save with "A GSTIN is required for a Regular party".
  if (gstin === '' && normalizeGstin(current.gstin) !== '' && current.registrationType === 'regular') {
    return { ...current, gstin, registrationType: 'unregistered', valid: false, filled: ['registration'] };
  }
  const v = validateGstin(gstin);
  if (!v.valid) return { ...current, gstin, valid: false, filled: [] };
  const filled: GstinAutofill['filled'] = [];
  let { stateCode, pan, registrationType } = current;
  if (v.stateCode && getState(v.stateCode) && stateCode !== v.stateCode) {
    stateCode = v.stateCode;
    filled.push('state');
  }
  if (v.pan && pan.toUpperCase() !== v.pan) {
    pan = v.pan;
    filled.push('pan');
  }
  const wanted: RegistrationType = v.kind === 'uin' ? 'uin' : 'regular';
  if (registrationType === '' || NO_GSTIN.has(registrationType) || (v.kind === 'uin' && registrationType !== 'uin')) {
    if (registrationType !== wanted) {
      registrationType = wanted;
      filled.push('registration');
    }
  }
  return { gstin, stateCode, pan, registrationType, valid: true, kind: v.kind, filled };
}

/**
 * PAN entered that differs from the PAN inside a valid GSTIN (characters 3–12), with the core's
 * message; null when there is nothing to compare or they agree.
 */
export function panProblem(f: Pick<GstinFields, 'gstin' | 'pan' | 'registrationType'>): string | null {
  const pan = normalizePan(f.pan);
  if (!pan || f.registrationType === 'overseas') return null;
  const v = validateGstin(normalizeGstin(f.gstin));
  if (!v.valid || !v.pan || v.pan === pan) return null;
  return `PAN ${pan} does not match the PAN inside the GSTIN (${v.pan}). Correct the PAN or the GSTIN.`;
}

/** Hint under a valid GSTIN: "Valid GSTIN · Maharashtra · PAN AAPFU0939F". */
export function gstinOkText(gstin: string): string | null {
  const v = validateGstin(gstin);
  if (!v.valid) return null;
  return [v.kind === 'uin' ? 'Valid UIN' : 'Valid GSTIN', v.stateCode ? stateName(v.stateCode) : '', v.pan ? `PAN ${v.pan}` : ''].filter(Boolean).join(' · ');
}

/**
 * Live problem with the GSTIN / registration combination (null when fine). Partial input while
 * typing (fewer than 15 characters) is reported only when `final` is true (on blur/save).
 */
export function gstinProblem(f: GstinFields, final: boolean): { field: 'gstin' | 'stateCode' | 'registrationType'; message: string } | null {
  const g = normalizeGstin(f.gstin);
  const reg = f.registrationType;
  if (reg === 'overseas') {
    if (g) return { field: 'gstin', message: 'Overseas parties do not have a GSTIN. Remove it, or choose the registration type the party holds in India.' };
    if (f.stateCode && f.stateCode !== '96') return { field: 'stateCode', message: "The state of an overseas party must be '96 - Other Countries' (or left blank)" };
    return null;
  }
  if (f.stateCode === '96') return { field: 'stateCode', message: 'State 96 (Other Countries) is only for overseas parties. Set the registration type to Overseas or choose an Indian state.' };
  if (!g) {
    if (reg && NEEDS_GSTIN.has(reg)) {
      return { field: 'gstin', message: `A GSTIN is required for a ${registrationLabel(reg)} party. Enter it, or change the registration type to Unregistered or Consumer.` };
    }
    return null;
  }
  if (g.length < 15 && !final) return null;
  const v = validateGstin(g);
  if (!v.valid) return { field: 'gstin', message: `${v.error ?? 'GSTIN is not valid'}. Check the GSTIN printed on the party's invoice or certificate.` };
  if (reg && NO_GSTIN.has(reg)) {
    return { field: 'gstin', message: `An ${registrationLabel(reg).toLowerCase()} party cannot have a GSTIN. Remove the GSTIN, or change the registration type to Regular.` };
  }
  if (reg === 'uin' && v.kind !== 'uin') return { field: 'gstin', message: 'A UIN holder needs a UIN (e.g. 0717UNO00157UN5), not a regular GSTIN.' };
  if (v.kind === 'uin' && reg !== 'uin' && reg !== '') return { field: 'registrationType', message: 'This number is a UIN (UN body / embassy). Set the registration type to UIN holder.' };
  if (v.stateCode && f.stateCode && f.stateCode !== v.stateCode) {
    return { field: 'gstin', message: `This GSTIN is registered in ${stateName(v.stateCode)}, but the state chosen is ${stateName(f.stateCode)}. Correct the GSTIN or the state.` };
  }
  return null;
}
