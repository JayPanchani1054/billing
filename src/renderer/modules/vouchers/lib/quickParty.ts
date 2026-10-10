/**
 * Quick customer / supplier (Alt+C in a party picker → accounts/QuickPartyDialog.tsx) — the pure part,
 * tested in quickParty.test.ts: which pickers get the quick dialog, the draft, live GSTIN fill-in (state,
 * PAN, registration type — the ledger form's own rules, accounts/lib/gstin.ts) and the
 * 'accounts.ledger.save' input it sends (a ledger under Sundry Debtors / Sundry Creditors, bill-wise
 * when F11 › Bill-wise is on, the company's state when neither a GSTIN nor a state is given).
 */
import type { GroupCode } from '../../../../shared/constants.ts';
import type { RegistrationType } from '../../../../shared/types/gst.ts';
import { applyGstin, gstinProblem } from '../../accounts/lib/gstin.ts';
import type { LedgerSaveRouteInput } from '../../accounts/lib/ledgerDraft.ts';

/** Group codes whose Alt+C opens the quick dialog (every other picker keeps the full ledger form). */
export const QUICK_PARTY_GROUPS: ReadonlySet<GroupCode> = new Set<GroupCode>(['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS']);

export type QuickPartyGroup = 'SUNDRY_DEBTORS' | 'SUNDRY_CREDITORS';

/** The quick dialog's group for a picker that creates under `groupCode`, else null (full form). */
export function quickPartyGroup(groupCode: GroupCode | null | undefined): QuickPartyGroup | null {
  return groupCode === 'SUNDRY_DEBTORS' || groupCode === 'SUNDRY_CREDITORS' ? groupCode : null;
}

/** "customer" / "supplier". */
export function quickPartyNoun(group: QuickPartyGroup): 'customer' | 'supplier' {
  return group === 'SUNDRY_DEBTORS' ? 'customer' : 'supplier';
}

/**
 * The picker's "create" row: it names what Alt+C opens — "Create customer “Ravi Traders”" for the quick
 * dialog, "Create ledger “…”" for the full ledger form.
 */
export function createLabelFor(group: QuickPartyGroup | null, typed: string): string {
  const noun = group ? quickPartyNoun(group) : 'ledger';
  const q = typed.trim();
  return q ? `Create ${noun} “${q}”` : `Create a new ${noun}`;
}

export interface QuickPartyDraft {
  name: string;
  gstin: string;
  /** '' = none chosen. */
  stateCode: string;
  pan: string;
  registrationType: RegistrationType | '';
  mobile: string;
  email: string;
  address: string;
}

export function emptyQuickParty(name: string, companyStateCode: string | null): QuickPartyDraft {
  return { name: name.trim(), gstin: '', stateCode: companyStateCode ?? '', pan: '', registrationType: '', mobile: '', email: '', address: '' };
}

/** Typing the GSTIN: once valid it fills state, PAN and registration type (accounts/lib/gstin.ts › applyGstin). */
export function withGstin(d: QuickPartyDraft, raw: string): QuickPartyDraft {
  const a = applyGstin({ gstin: d.gstin, stateCode: d.stateCode, pan: d.pan, registrationType: d.registrationType }, raw);
  return { ...d, gstin: a.gstin, stateCode: a.stateCode, pan: a.pan, registrationType: a.registrationType };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Problems by field ('name', 'gstin', 'stateCode', 'mobile', 'email'); {} when it can be saved. */
export function quickPartyProblems(d: QuickPartyDraft, final: boolean): Partial<Record<keyof QuickPartyDraft, string>> {
  const e: Partial<Record<keyof QuickPartyDraft, string>> = {};
  const name = d.name.trim();
  if (name === '') e.name = 'Enter the name.';
  else if (name.length > 200) e.name = 'Use at most 200 characters.';
  const g = gstinProblem({ gstin: d.gstin, stateCode: d.stateCode, pan: d.pan, registrationType: d.registrationType }, final);
  if (g) e[g.field === 'registrationType' ? 'gstin' : g.field] = g.message;
  const mobile = d.mobile.trim();
  if (mobile !== '' && !/^\+?[0-9 -]{6,20}$/.test(mobile)) e.mobile = 'Enter digits only (for example 98250 12345).';
  const email = d.email.trim();
  if (email !== '' && (email.length > 254 || !EMAIL_RE.test(email))) e.email = 'Enter an e-mail address like name@example.com.';
  return e;
}

/** The 'accounts.ledger.save' input of the quick dialog (create). */
export function quickPartyInput(d: QuickPartyDraft, a: { groupId: number; billWise: boolean }): LedgerSaveRouteInput {
  const input: LedgerSaveRouteInput = { name: d.name.trim(), groupId: a.groupId, billWise: a.billWise, country: 'India' };
  const gstin = d.gstin.trim().toUpperCase();
  if (gstin !== '') input.gstin = gstin;
  if (d.stateCode !== '') input.stateCode = d.stateCode;
  // The dialog has no PAN box: its PAN only ever comes from a GSTIN typed here. Once that GSTIN is
  // cleared the PAN goes with it (it would otherwise be saved unseen on an unregistered party).
  if (gstin !== '' && d.pan.trim() !== '') input.pan = d.pan.trim().toUpperCase();
  if (d.registrationType !== '') input.registrationType = d.registrationType;
  if (d.mobile.trim() !== '') input.mobile = d.mobile.trim();
  if (d.email.trim() !== '') input.email = d.email.trim();
  if (d.address.trim() !== '') input.address = d.address.trim();
  return input;
}
