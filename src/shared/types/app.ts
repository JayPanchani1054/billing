/**
 * DTOs for app-scope routes (src/core/app/routes.ts) — data directory, company registry, sessions.
 * Implemented by core/app, consumed by the renderer shell (company select, create wizard, login).
 *
 * Route table (all scope 'app'):
 *   'app.state'            none                      → AppState
 *   'app.dataDir.set'      DataDirChangeInput        → AppState        access 'public' when no company is open
 *   'app.company.list'     none                      → CompanyListItem[]
 *   'app.company.create'   CreateCompanyInput        → OpenResult      (opens the new company)
 *   'app.company.open'     { id }                    → OpenResult
 *   'app.auth.login'       LoginInput                → OpenResult
 *   'app.auth.logout'      none                      → AppState
 *   'app.auth.changePassword' ChangePasswordInput    → { ok: true }    access 'authenticated'
 *   'app.company.close'    none                      → AppState
 *   'app.company.delete'   DeleteCompanyInput        → CompanyListItem[]  (requires company closed; Owner pwd if secured)
 *   'app.session.touch'    none                      → SessionInfo | null  (idle-timeout keepalive)
 *   'app.session.lock'     none                      → AppState        (the shell's idle timer fired: end the
 *                                                                        session as 'idle'; the screen locks)
 */
import type { Permission } from '../constants.ts';
import type { CompanyFeatures } from '../settings.ts';

export interface SessionInfo {
  userId: number | null;
  username: string;
  displayName: string;
  role: string;
  permissions: Permission[];
  isOwner: boolean;
  /** true when company security is off (single-user mode). */
  implicit: boolean;
  mustChangePassword: boolean;
  /**
   * Idle timeout of this session in ms (0 or absent = never: security off / timeout disabled). The
   * shell locks the screen after this long without keyboard or mouse input ('app.session.lock');
   * the dispatcher also refuses calls after it (server-side authority).
   */
  idleTimeoutMs?: number;
}

export interface CompanyListItem {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  booksFrom: string;
  /** Current financial year label of the books, e.g. '2026-27'. */
  fyLabel: string;
  securityEnabled: boolean;
  lastOpenedAt: string | null;
  sizeBytes: number;
  /** Schema version stored in the DB vs supported by this app. */
  schemaVersion: number;
  needsUpgrade: boolean;
}

export interface OpenCompanySummary {
  id: string;
  name: string;
  mailingName: string | null;
  gstin: string | null;
  stateCode: string | null;
  booksFrom: string;
  fyStartMonth: number;
  gstEnabled: boolean;
  features: CompanyFeatures;
}

export interface AppState {
  appVersion: string;
  dataDir: string;
  /** True until the user has confirmed a data directory (first launch). */
  firstRun: boolean;
  companies: CompanyListItem[];
  company: OpenCompanySummary | null;
  session: SessionInfo | null;
  /** A company is open but waiting for login. */
  pendingLogin: { companyId: string; companyName: string } | null;
  /**
   * Set when the data folder cannot be used right now (drive disconnected, permissions): a
   * user-readable explanation for an empty company list. null/absent when the folder is fine.
   */
  dataDirError?: string | null;
}

export type OpenResult = AppState;

export interface DataDirChangeInput {
  path: string;
  /** 'use': point at the folder as-is (may already contain companies); 'move': move current data there; 'copy': copy it. */
  mode: 'use' | 'move' | 'copy';
}

export interface CreateCompanyInput {
  name: string;
  mailingName?: string;
  address?: string;
  stateCode: string;
  country?: string;
  pincode?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  website?: string;
  gstRegistrationType: 'regular' | 'composition' | 'unregistered';
  gstin?: string;
  pan?: string;
  /** Books beginning date (also defines the first financial year). */
  booksFrom: string;
  fyStartMonth?: number;
  features?: Partial<CompanyFeatures>;
  /** When provided, security is enabled and this becomes the Owner user. */
  owner?: { username: string; displayName?: string; password: string };
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** Moves the company folder to <dataDir>/trash (never hard-deleted). */
export interface DeleteCompanyInput {
  id: string;
  /** Must equal the company name exactly (typed by the user to confirm). */
  confirmName: string;
  /** Owner credentials, required when the company has security enabled. Username optional (any Owner). */
  username?: string;
  password?: string;
}
