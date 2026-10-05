/**
 * DTOs for the company module (src/core/modules/company). Route table (all scope 'company'):
 *
 *   'company.profile.get'     none                 → CompanyProfile        access 'company.view'
 *   'company.profile.save'    CompanyProfileInput  → CompanyProfile        access 'company.manage'
 *   'company.features.get'    none                 → CompanyFeatures       access 'authenticated'
 *   'company.features.save'   CompanyFeaturesInput → CompanyFeatures       access 'company.manage'
 *   'company.config.get'      none                 → CompanyConfig         access 'authenticated'
 *   'company.config.save'     CompanyConfigInput   → CompanyConfig         access 'company.manage'
 *   'company.periodLock.set'  PeriodLockInput      → PeriodLockResult      access 'period.lock'
 *   'company.summary'         none                 → OpenCompanySummary    access 'authenticated'
 */
import type { CompanyConfig, CompanyFeatures } from '../settings.ts';

export type GstRegistrationType = 'regular' | 'composition' | 'unregistered';

/** Largest accepted company logo (decoded bytes). */
export const COMPANY_LOGO_MAX_BYTES = 512 * 1024;
/** Logo formats accepted as data URLs (SVG is rejected: it can carry script). */
export const COMPANY_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export interface CompanyProfile {
  guid: string;
  name: string;
  mailingName: string | null;
  address: string | null;
  stateCode: string | null;
  country: string;
  pincode: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  gstRegistrationType: GstRegistrationType;
  pan: string | null;
  tan: string | null;
  cin: string | null;
  fyStartMonth: number;
  booksFrom: string;
  baseCurrency: string;
  /** 'data:image/png;base64,…' (png/jpeg/webp/gif, ≤ 512 KB decoded) or null. */
  logo: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Full-form save of the editable profile. Optional text fields left empty are cleared.
 * `logo`: omit to keep the current logo, null to remove it, or a data URL to replace it.
 */
export interface CompanyProfileInput {
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
  logo?: string | null;
}

export type CompanyFeaturesInput = Partial<CompanyFeatures>;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Partial configuration update (deep-merged). `lockedUpTo` is changed only via 'company.periodLock.set'. */
export type CompanyConfigInput = DeepPartial<Omit<CompanyConfig, 'lockedUpTo'>>;

export interface PeriodLockInput {
  /** Lock all entries dated on or before this date; null unlocks. */
  date: string | null;
}

export interface PeriodLockResult {
  lockedUpTo: string | null;
}
