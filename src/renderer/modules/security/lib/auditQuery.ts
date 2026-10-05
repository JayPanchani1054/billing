/**
 * Edit-log screen state → route inputs, screen params, action groups and tones. Pure.
 */
import type { AuditActionName, AuditExportInput, AuditListInput, AuditVerifyReport } from '../../../../shared/types/security.ts';
import { AUDIT_ACTION_LABELS, AUDIT_LIST_MAX_LIMIT } from '../../../../shared/types/security.ts';

export type ActionGroup = 'all' | 'changes' | 'logins' | 'security' | 'data';

export const ACTION_GROUPS: ReadonlyArray<{ value: ActionGroup; label: string; actions: readonly AuditActionName[] }> = [
  { value: 'all', label: 'All', actions: [] },
  { value: 'changes', label: 'Changes', actions: ['create', 'alter', 'delete', 'cancel'] },
  { value: 'logins', label: 'Logins', actions: ['login', 'logout', 'login_failed'] },
  { value: 'security', label: 'Security & settings', actions: ['security', 'settings'] },
  { value: 'data', label: 'Data', actions: ['export', 'import', 'backup', 'restore'] },
];

export const PAGE_SIZES: readonly number[] = [100, 200, 500];

export interface AuditFilterState {
  /** 'period' = the app's reporting period (Alt+F2); 'all' = every entry. */
  dates: 'period' | 'all';
  userId: number | null;
  group: ActionGroup;
  /** One specific action (overrides the group when set). */
  action: AuditActionName | null;
  entityType: string | null;
  search: string;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export const DEFAULT_FILTERS: AuditFilterState = {
  dates: 'period',
  userId: null,
  group: 'all',
  action: null,
  entityType: null,
  search: '',
  page: 1,
  pageSize: 200,
};

export function actionsOf(f: Pick<AuditFilterState, 'group' | 'action'>): AuditActionName[] | undefined {
  if (f.action) return [f.action];
  const g = ACTION_GROUPS.find((x) => x.value === f.group);
  return g && g.actions.length ? [...g.actions] : undefined;
}

type FilterFields = Omit<AuditListInput, 'limit' | 'offset' | 'order'>;

function filterFields(f: AuditFilterState, period: { from: string; to: string }): FilterFields {
  const out: FilterFields = {};
  if (f.dates === 'period') {
    out.from = period.from;
    out.to = period.to;
  }
  if (f.userId !== null) out.userId = f.userId;
  const actions = actionsOf(f);
  if (actions) out.actions = actions;
  if (f.entityType) out.entityType = f.entityType;
  const q = f.search.trim();
  if (q) out.search = q;
  return out;
}

export function toListInput(f: AuditFilterState, period: { from: string; to: string }): AuditListInput {
  const limit = Math.min(Math.max(1, f.pageSize), AUDIT_LIST_MAX_LIMIT);
  return { ...filterFields(f, period), limit, offset: (Math.max(1, f.page) - 1) * limit, order: 'desc' };
}

export function toExportInput(f: AuditFilterState, period: { from: string; to: string }, format: 'xlsx' | 'csv'): AuditExportInput {
  return { ...filterFields(f, period), format };
}

/** True when any filter narrows the list (for the "Clear filters" button and empty-state text). */
export function hasFilters(f: AuditFilterState): boolean {
  return f.userId !== null || f.group !== 'all' || f.action !== null || f.entityType !== null || f.search.trim() !== '';
}

export interface AuditScreenParams {
  entityType?: string;
  entityId?: number;
  entityGuid?: string;
  /** Record label for the title while loading (e.g. 'Sales 42'). */
  label?: string;
}

export interface HistoryTarget {
  entityType: string;
  entityId: number;
  entityGuid?: string;
  label?: string;
}

/** History mode when the params name one record ({ entityType, entityId }). */
export function historyTarget(params: unknown): HistoryTarget | null {
  if (typeof params !== 'object' || params === null) return null;
  const p = params as Record<string, unknown>;
  const type = typeof p.entityType === 'string' ? p.entityType.trim() : '';
  const id = typeof p.entityId === 'number' ? p.entityId : typeof p.entityId === 'string' && /^\d+$/.test(p.entityId) ? Number(p.entityId) : NaN;
  if (!type || !Number.isSafeInteger(id) || id < 0) return null;
  const out: HistoryTarget = { entityType: type, entityId: id };
  if (typeof p.entityGuid === 'string' && p.entityGuid) out.entityGuid = p.entityGuid;
  if (typeof p.label === 'string' && p.label) out.label = p.label;
  return out;
}

/** Initial filter for a record type only ({ entityType } without id). */
export function initialFilters(params: unknown): AuditFilterState {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  return { ...DEFAULT_FILTERS, entityType: typeof p.entityType === 'string' && p.entityType ? p.entityType : null };
}

export type ActionTone = 'neutral' | 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function actionTone(action: AuditActionName | string): ActionTone {
  switch (action) {
    case 'create':
      return 'success';
    case 'alter':
      return 'info';
    case 'delete':
    case 'login_failed':
      return 'danger';
    case 'cancel':
      return 'warning';
    case 'security':
    case 'settings':
      return 'brand';
    case 'export':
    case 'import':
    case 'backup':
    case 'restore':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function actionLabel(action: string): string {
  return Object.hasOwn(AUDIT_ACTION_LABELS, action) ? AUDIT_ACTION_LABELS[action as AuditActionName] : action;
}

/** Fingerprint in readable groups: 'a1b2c3d4 e5f6…' (first `groups` × 8 hex characters). */
export function groupedHash(hash: string | null, groups = 8): string {
  if (!hash) return '';
  const parts: string[] = [];
  for (let i = 0; i < Math.min(hash.length, groups * 8); i += 8) parts.push(hash.slice(i, i + 8));
  return parts.join(' ');
}

/** Tone and short headline for the verification banner. */
export function verifyTone(r: AuditVerifyReport): 'success' | 'danger' | 'info' {
  if (!r.ok) return 'danger';
  return r.count === 0 ? 'info' : 'success';
}

/** Default export file name when the server's suggestion is missing. */
export function exportFallbackName(format: 'xlsx' | 'csv', today: string): string {
  return `Edit log ${today}.${format}`;
}
