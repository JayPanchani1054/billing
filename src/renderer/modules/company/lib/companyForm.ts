/**
 * Create-company wizard model: draft, per-step validation (mirrors core company validation so
 * mistakes are caught before submitting), GSTIN-driven auto-fill, and the route input.
 * Pure — tested in companyForm.test.ts.
 */
import { financialYear, isValidDate } from '../../../../shared/dates.ts';
import { getState } from '../../../../shared/gst/states.ts';
import { normalizeGstin, validateGstin } from '../../../../shared/gst/gstin.ts';
import type { CompanyFeatures } from '../../../../shared/settings.ts';
import type { CreateCompanyInput } from '../../../../shared/types/app.ts';
import type { GstRegistrationType } from '../../../../shared/types/company.ts';
import { passwordPolicyError, usernameError } from './password.ts';

export const WIZARD_STEPS = ['business', 'gst', 'books', 'features', 'security', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_LABELS: Readonly<Record<WizardStep, string>> = {
  business: 'Business',
  gst: 'GST & Tax',
  books: 'Books',
  features: 'Features',
  security: 'Security',
  review: 'Review',
};

/** Features offered in the wizard (plain-language toggles); the rest keep their defaults. */
export const WIZARD_FEATURES: ReadonlyArray<keyof CompanyFeatures> = ['inventory', 'multipleGodowns', 'batches', 'billWise', 'costCentres', 'orderProcessing', 'einvoice', 'ewayBill'];

export interface CompanyDraft {
  name: string;
  mailingName: string;
  address: string;
  stateCode: string;
  pincode: string;
  phone: string;
  email: string;
  gstRegistrationType: GstRegistrationType;
  gstin: string;
  pan: string;
  fyStartMonth: number;
  booksFrom: string;
  features: Partial<CompanyFeatures>;
  secure: boolean;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerPassword: string;
  ownerPasswordConfirm: string;
}

export type DraftErrors = Partial<Record<keyof CompanyDraft | 'owner', string>>;

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const PINCODE_RE = /^[1-9][0-9]{5}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Start of the financial year that contains `today` (books normally begin there). */
export function booksFromForFy(today: string, fyStartMonth: number): string {
  return financialYear(today, fyStartMonth).start;
}

export function defaultDraft(today: string): CompanyDraft {
  return {
    name: '',
    mailingName: '',
    address: '',
    stateCode: '',
    pincode: '',
    phone: '',
    email: '',
    gstRegistrationType: 'regular',
    gstin: '',
    pan: '',
    fyStartMonth: 4,
    booksFrom: booksFromForFy(today, 4),
    features: { inventory: true, multipleGodowns: false, batches: false, billWise: true, costCentres: false, orderProcessing: false, einvoice: false, ewayBill: false },
    secure: true,
    ownerUsername: 'owner',
    ownerDisplayName: '',
    ownerPassword: '',
    ownerPasswordConfirm: '',
  };
}

/**
 * Typing a GSTIN fills the state and PAN when it is valid (the state code and PAN are part of
 * the GSTIN), so the user never types them twice.
 */
export function applyGstin(draft: CompanyDraft, raw: string): CompanyDraft {
  const fill = gstinAutofill(raw);
  return { ...draft, gstin: fill.gstin, ...(fill.stateCode ? { stateCode: fill.stateCode } : {}), ...(fill.pan ? { pan: fill.pan } : {}) };
}

/** Normalised GSTIN text plus the state code and PAN it carries (only when it is valid). */
export function gstinAutofill(raw: string): { gstin: string; stateCode?: string; pan?: string } {
  const gstin = normalizeGstin(raw).slice(0, 15);
  const v = validateGstin(gstin);
  if (!v.valid) return { gstin };
  return {
    gstin,
    stateCode: v.stateCode && getState(v.stateCode) ? v.stateCode : undefined,
    pan: v.pan,
  };
}

/** Live GSTIN message for the field (null when empty or valid). */
export function gstinError(gstin: string, stateCode: string, registration: GstRegistrationType): string | null {
  if (registration === 'unregistered') return null;
  const g = normalizeGstin(gstin);
  if (!g) return 'GSTIN is required for a GST-registered business';
  const v = validateGstin(g);
  if (!v.valid) return v.error ?? 'GSTIN is not valid';
  if (stateCode && v.stateCode !== stateCode) return `This GSTIN belongs to state ${v.stateCode}, but the business state is ${stateCode}. Check the state on the Business step.`;
  return null;
}

export function validateStep(step: WizardStep, d: CompanyDraft): DraftErrors {
  const e: DraftErrors = {};
  if (step === 'business' || step === 'review') {
    if (!d.name.trim()) e.name = 'Enter the business name';
    else if (d.name.trim().length > 120) e.name = 'Use at most 120 characters';
    if (!d.stateCode || !getState(d.stateCode)) e.stateCode = 'Choose the state where the business is registered';
    if (d.pincode.trim() && !PINCODE_RE.test(d.pincode.trim())) e.pincode = 'PIN code should be 6 digits, e.g. 400001';
    if (d.email.trim() && !EMAIL_RE.test(d.email.trim())) e.email = 'Enter an email like name@example.com';
  }
  if (step === 'gst' || step === 'review') {
    const g = gstinError(d.gstin, d.stateCode, d.gstRegistrationType);
    if (g) e.gstin = g;
    const pan = d.pan.trim().toUpperCase();
    if (pan && !PAN_RE.test(pan)) e.pan = 'PAN should look like ABCDE1234F';
    else if (pan && d.gstRegistrationType !== 'unregistered' && !g) {
      const fromGstin = normalizeGstin(d.gstin).slice(2, 12);
      if (fromGstin && fromGstin !== pan) e.pan = 'PAN does not match the PAN inside the GSTIN';
    }
  }
  if (step === 'books' || step === 'review') {
    if (!Number.isInteger(d.fyStartMonth) || d.fyStartMonth < 1 || d.fyStartMonth > 12) e.fyStartMonth = 'Choose a month';
    if (!d.booksFrom || !isValidDate(d.booksFrom)) e.booksFrom = 'Enter the date your books begin';
  }
  if ((step === 'security' || step === 'review') && d.secure) {
    const u = usernameError(d.ownerUsername);
    if (u) e.ownerUsername = u;
    const p = passwordPolicyError(d.ownerPassword);
    if (p) e.ownerPassword = p;
    else if (d.ownerPassword !== d.ownerPasswordConfirm) e.ownerPasswordConfirm = 'The two passwords are different';
  }
  return e;
}

/** First step (in wizard order) that has an error, or null. */
export function firstInvalidStep(d: CompanyDraft): WizardStep | null {
  for (const s of WIZARD_STEPS) {
    if (s === 'review') continue;
    if (Object.keys(validateStep(s, d)).length > 0) return s;
  }
  return null;
}

const blank = (s: string): string | undefined => (s.trim() === '' ? undefined : s.trim());

export function buildCreateInput(d: CompanyDraft): CreateCompanyInput {
  const registered = d.gstRegistrationType !== 'unregistered';
  const features: Partial<CompanyFeatures> = { ...d.features, gst: registered };
  if (!registered) {
    features.einvoice = false;
    features.ewayBill = false;
  }
  if (!features.inventory) {
    features.multipleGodowns = false;
    features.batches = false;
  }
  const input: CreateCompanyInput = {
    name: d.name.trim(),
    mailingName: blank(d.mailingName),
    address: blank(d.address),
    stateCode: d.stateCode,
    pincode: blank(d.pincode),
    phone: blank(d.phone),
    email: blank(d.email),
    gstRegistrationType: d.gstRegistrationType,
    gstin: registered ? blank(normalizeGstin(d.gstin)) : undefined,
    pan: blank(d.pan.toUpperCase()),
    booksFrom: d.booksFrom,
    fyStartMonth: d.fyStartMonth,
    features,
  };
  if (d.secure) {
    input.owner = { username: d.ownerUsername.trim(), displayName: blank(d.ownerDisplayName), password: d.ownerPassword };
  }
  return input;
}

/** Which step owns a server field path ('owner.password' → security). */
export function stepOfPath(path: string): WizardStep {
  const root = path.split(/[.[]/)[0];
  if (['name', 'mailingName', 'address', 'stateCode', 'pincode', 'phone', 'mobile', 'email', 'website', 'country'].includes(root)) return 'business';
  if (['gstin', 'pan', 'gstRegistrationType'].includes(root)) return 'gst';
  if (['booksFrom', 'fyStartMonth'].includes(root)) return 'books';
  if (root === 'features') return 'features';
  if (root === 'owner') return 'security';
  return 'review';
}

/** Server field path → draft field ('owner.password' → 'ownerPassword'). */
export function draftFieldOfPath(path: string): keyof CompanyDraft | 'owner' {
  const map: Record<string, keyof CompanyDraft> = {
    'owner.username': 'ownerUsername',
    'owner.password': 'ownerPassword',
    'owner.displayName': 'ownerDisplayName',
  };
  if (map[path]) return map[path];
  const root = path.split(/[.[]/)[0];
  if (root === 'owner') return 'owner';
  const known: Array<keyof CompanyDraft> = ['name', 'mailingName', 'address', 'stateCode', 'pincode', 'phone', 'email', 'gstRegistrationType', 'gstin', 'pan', 'fyStartMonth', 'booksFrom', 'features'];
  return (known as string[]).includes(root) ? (root as keyof CompanyDraft) : 'name';
}

export const MONTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
].map((m, i) => ({ value: String(i + 1), label: m }));
