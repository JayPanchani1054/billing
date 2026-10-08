/**
 * Edit-log screen state → route inputs, screen params, action groups and tones. Pure.
 */
import type { AuditActionName, AuditExportInput, AuditFacets, AuditListInput, AuditListRow, AuditVerifyReport } from '../../../../shared/types/security.ts';
import { formatIndianNumber } from '../../../../shared/format.ts';
import { AUDIT_ACTION_LABELS, AUDIT_ACTIONS, AUDIT_LIST_MAX_LIMIT } from '../../../../shared/types/security.ts';

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

/** A type alias (not an interface) so it is assignable to nav params. */
export type AuditScreenParams = {
  entityType?: string;
  entityId?: number;
  entityGuid?: string;
  /** Record label for the title while loading (e.g. 'Sales 42'). */
  label?: string;
};

export interface HistoryTarget {
  entityType: string;
  entityId: number;
  entityGuid?: string;
  label?: string;
}

/**
 * Params that open the Edit Log in record-history mode, for "Edit history" actions on other screens:
 * `nav.push('security.audit', auditHistoryParams('ledger', 7, 'Sharma & Sons'))`.
 */
export function auditHistoryParams(entityType: string, entityId: number, label?: string, entityGuid?: string): AuditScreenParams {
  const p: AuditScreenParams = { entityType, entityId };
  if (label) p.label = label;
  if (entityGuid) p.entityGuid = entityGuid;
  return p;
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

/**
 * Initial filters from screen params: a record type only ({ entityType } without id) and/or one user
 * ({ userId }, e.g. "My activity" from the session screen). A user filter shows every date.
 */
export function initialFilters(params: unknown): AuditFilterState {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  const userId = typeof p.userId === 'number' && Number.isSafeInteger(p.userId) && p.userId > 0 ? p.userId : null;
  return {
    ...DEFAULT_FILTERS,
    entityType: typeof p.entityType === 'string' && p.entityType ? p.entityType : null,
    userId,
    dates: userId !== null ? 'all' : DEFAULT_FILTERS.dates,
  };
}

// ───────────────────────────── Filter options from the facets ─────────────────────────────

export interface FilterOption {
  value: string;
  label: string;
}

/** Value used by the "everything" choice of the filter selects. */
export const ANY = 'any';

/**
 * Users who appear in the edit log, one option per user id (a renamed user is listed once with both
 * names). Entries without a user id (security off, failed logins of unknown names) cannot be filtered
 * by user — search for the name instead.
 */
export function userOptions(facets: AuditFacets | undefined, current: number | null = null): FilterOption[] {
  const byId = new Map<number, { names: string[]; count: number }>();
  for (const u of facets?.users ?? []) {
    if (u.userId === null) continue;
    const e = byId.get(u.userId) ?? { names: [], count: 0 };
    if (!e.names.includes(u.username)) e.names.push(u.username);
    e.count += u.count;
    byId.set(u.userId, e);
  }
  const opts = [...byId.entries()]
    .map(([id, e]) => ({ value: String(id), label: `${e.names.join(' / ')} (${formatCount(e.count)})`, sort: e.names[0].toLowerCase() }))
    .sort((a, b) => a.sort.localeCompare(b.sort));
  // Keep a user given by the screen params (e.g. "My activity") selectable even with no entries yet,
  // so the select never shows "All users" while the list is filtered.
  if (current !== null && !byId.has(current)) opts.push({ value: String(current), label: `User #${current} (0)`, sort: '\uffff' });
  return [{ value: ANY, label: 'All users' }, ...opts.map(({ value, label }) => ({ value, label }))];
}

/** Record types present in the edit log, by readable label. */
export function entityTypeOptions(facets: AuditFacets | undefined, current: string | null = null): FilterOption[] {
  const opts = (facets?.entityTypes ?? []).map((t) => ({ value: t.value, label: `${t.label} (${formatCount(t.count)})` }));
  // Keep a type given by the screen params selectable even when the log has no entry of it yet.
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
  return [{ value: ANY, label: 'All record types' }, ...opts];
}

/** Specific actions within the chosen group that occur in the log (with counts). */
export function actionOptions(facets: AuditFacets | undefined, group: ActionGroup): FilterOption[] {
  const inGroup = ACTION_GROUPS.find((g) => g.value === group)?.actions ?? [];
  const counts = new Map((facets?.actions ?? []).map((a) => [a.value, a.count]));
  const pool = inGroup.length ? inGroup : AUDIT_ACTIONS;
  const opts = pool.filter((a) => counts.has(a)).map((a) => ({ value: a, label: `${actionLabel(a)} (${formatCount(counts.get(a) ?? 0)})` }));
  return [{ value: ANY, label: group === 'all' ? 'All actions' : 'Any of these' }, ...opts];
}

/** Indian digit grouping for counts (1,23,456). */
export function formatCount(n: number): string {
  return formatIndianNumber(Math.trunc(n), 0);
}

/** Moving to a group clears a specific action that is not part of it. */
export function withGroup(f: AuditFilterState, group: ActionGroup): AuditFilterState {
  const g = ACTION_GROUPS.find((x) => x.value === group);
  const keep = f.action !== null && g !== undefined && (g.actions.length === 0 || g.actions.includes(f.action));
  return { ...f, group, action: keep ? f.action : null, page: 1 };
}

/** Next / previous row id for the detail drawer (null at either end or when not found). */
export function adjacentId(rows: readonly { id: number }[], currentId: number, dir: 1 | -1): number | null {
  const i = rows.findIndex((r) => r.id === currentId);
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < rows.length ? rows[j].id : null;
}

/** Export input for one record's history. */
export function historyExportInput(t: HistoryTarget, format: 'xlsx' | 'csv'): AuditExportInput {
  return { entityType: t.entityType, entityId: t.entityId, format };
}

/** Plain-text one-liner for a filtered view (print subtitle, empty state). */
export function filterSummary(f: AuditFilterState, ctx: { periodLabel: string; userLabel?: string; entityTypeLabel?: string }): string {
  const parts: string[] = [f.dates === 'all' ? 'All dates' : ctx.periodLabel];
  if (f.userId !== null) parts.push(`User: ${ctx.userLabel ?? `#${f.userId}`}`);
  if (f.action) parts.push(`Action: ${actionLabel(f.action)}`);
  else if (f.group !== 'all') parts.push(ACTION_GROUPS.find((g) => g.value === f.group)?.label ?? f.group);
  if (f.entityType) parts.push(`Record type: ${ctx.entityTypeLabel ?? f.entityType}`);
  if (f.search.trim()) parts.push(`Search: “${f.search.trim()}”`);
  return parts.join(' · ');
}

/** Rows for printing what is on screen (dates as local date-time text). */
export function printRows(rows: readonly AuditListRow[], formatTs: (iso: string) => string): Array<[string, string, string, string, string, string]> {
  return rows.map((r) => [formatTs(r.ts), r.username ?? '—', actionLabel(r.action), r.entityTypeLabel, r.entityLabel ?? (r.entityId !== null ? `#${r.entityId}` : ''), r.summary]);
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
