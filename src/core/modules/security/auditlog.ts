/**
 * Edit log (audit trail) viewer: filtered list with paging, entry detail with a field-level diff,
 * the history of one record, chain verification with a plain-language verdict, and export to
 * Excel/CSV (itself recorded in the log).
 *
 * All of this is read-only over `audit_log` (append-only, hash-chained — see core/lib/audit.ts).
 * Date filters are local calendar dates (the office's time zone), converted to UTC instants.
 * Search matches the record label, username, record type and action (not the before/after payloads).
 */
import { addDays, formatDate, isValidDate, todayLocal } from '../../../shared/dates.ts';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_EXPORT_MAX_ROWS,
  type AuditActionName,
  type AuditEntityHistory,
  type AuditEntityHistoryInput,
  type AuditEntryDetail,
  type AuditExportInput,
  type AuditExportResult,
  type AuditFacets,
  type AuditFieldChange,
  type AuditHistoryVersion,
  type AuditListInput,
  type AuditListResult,
  type AuditListRow,
  type AuditAnchorReport,
  type AuditAnchorResetResult,
  type AuditVerifyReport,
  type JsonValue,
} from '../../../shared/types/security.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { controllerFor } from '../../app/controller.ts';
import type { Db } from '../../db/db.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { checkAuditAnchor, type AnchorCheck } from '../../lib/auditAnchor.ts';
import { toCsv } from '../../lib/csv.ts';
import { forbidden, notFound, rule } from '../../lib/errors.ts';
import { encodeUtf8WithBom } from '../../lib/text.ts';
import { writeXlsx, type XlsxCell } from '../../lib/xlsx.ts';
import { likePattern } from './common.ts';
import { diffJson } from './diff.ts';

interface AuditDbRow {
  id: number;
  ts: string;
  user_id: number | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  entity_guid: string | null;
  entity_label: string | null;
  before_json: string | null;
  after_json: string | null;
  prev_hash: string;
  hash: string;
}

export const AUDIT_HISTORY_MAX_VERSIONS = 2000;
/** Longest "Changes" text written into one export cell (Excel's limit is 32 767). */
const EXPORT_CHANGES_MAX = 4000;

// ───────────────────────────── Labels ─────────────────────────────

const ENTITY_LABELS: Readonly<Record<string, string>> = {
  company: 'Company',
  company_features: 'Features (F11)',
  company_config: 'Configuration (F12)',
  company_security: 'Company security',
  period_lock: 'Period lock',
  group: 'Group',
  ledger: 'Ledger',
  cost_category: 'Cost category',
  cost_centre: 'Cost centre',
  currency: 'Currency',
  exchange_rate: 'Exchange rate',
  voucher_type: 'Voucher type',
  voucher: 'Voucher',
  stock_item: 'Stock item',
  stock_group: 'Stock group',
  stock_category: 'Stock category',
  unit: 'Unit',
  godown: 'Godown',
  user: 'User',
  role: 'Role',
  security_settings: 'Security settings',
  audit_log: 'Edit log',
};

/** 'stock_item' → 'Stock item'; unknown types are humanised. */
export function entityTypeLabel(type: string | null): string {
  if (!type) return '';
  const known = ENTITY_LABELS[type];
  if (known) return known;
  const words = type.replace(/[_.-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : type;
}

const isAction = (a: string): a is AuditActionName => Object.hasOwn(AUDIT_ACTION_LABELS, a);
export const actionLabel = (a: string): string => (isAction(a) ? AUDIT_ACTION_LABELS[a] : a);

function parseJson(text: string | null): JsonValue | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text; // not JSON (should not happen): show the raw text
  }
}

const asObject = (v: JsonValue | null): Record<string, JsonValue> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, JsonValue>) : null;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function changedFieldsText(changes: AuditFieldChange[], truncated: boolean, noun: string): string {
  if (changes.length === 0) return 'Saved without changes';
  const tops = [...new Set(changes.map((c) => c.path))];
  const shown = tops.slice(0, 3).join(', ');
  const count = truncated ? `${changes.length}+ ${noun}s` : plural(changes.length, noun);
  return `Changed ${count}: ${shown}${tops.length > 3 ? ', …' : ''}`;
}

const LOGOUT_REASONS: Readonly<Record<string, string>> = {
  idle: 'Logged out (idle timeout)',
  switch: 'Logged out (another user logged in)',
  close: 'Logged out (company closed)',
  logout: 'Logged out',
};

const FAILED_REASONS: Readonly<Record<string, string>> = {
  wrong_password: 'Failed login: wrong password',
  locked: 'Failed login: account locked',
  unknown_user: 'Failed login: unknown username',
  inactive: 'Failed login: account disabled',
};

/** One-line description of an entry (diff counts are computed for alterations and settings changes). */
export function summarizeEntry(action: string, entityType: string | null, before: JsonValue | null, after: JsonValue | null): string {
  const type = entityTypeLabel(entityType).toLowerCase() || 'record';
  const a = asObject(after);
  switch (action) {
    case 'create':
      return `Created ${type}`;
    case 'delete':
      return `Deleted ${type}`;
    case 'cancel':
      return `Cancelled ${type}`;
    case 'login':
      return 'Logged in';
    case 'logout':
      return LOGOUT_REASONS[String(a?.reason ?? 'logout')] ?? 'Logged out';
    case 'login_failed': {
      const base = FAILED_REASONS[String(a?.reason ?? '')] ?? 'Failed login';
      return typeof a?.attempts === 'number' ? `${base} (attempt ${a.attempts})` : base;
    }
    case 'alter': {
      const d = diffJson(before, after, 200);
      return changedFieldsText(d.changes, d.truncated, 'field');
    }
    case 'settings':
    case 'security': {
      if (before !== null && after !== null) {
        const d = diffJson(before, after, 200);
        return changedFieldsText(d.changes, d.truncated, action === 'settings' ? 'setting' : 'field');
      }
      return action === 'settings' ? 'Settings changed' : 'Security change';
    }
    default: {
      const rows = a && typeof a.rowCount === 'number' ? ` (${plural(a.rowCount, 'row')})` : '';
      return `${actionLabel(action)}${rows}`;
    }
  }
}

function toListRow(r: AuditDbRow, before?: JsonValue | null, after?: JsonValue | null): AuditListRow {
  const b = before === undefined ? parseJson(r.before_json) : before;
  const a = after === undefined ? parseJson(r.after_json) : after;
  return {
    id: r.id,
    ts: r.ts,
    userId: r.user_id,
    username: r.username,
    action: r.action as AuditActionName,
    entityType: r.entity_type,
    entityTypeLabel: entityTypeLabel(r.entity_type),
    entityId: r.entity_id,
    entityGuid: r.entity_guid,
    entityLabel: r.entity_label,
    summary: summarizeEntry(r.action, r.entity_type, b, a),
  };
}

// ───────────────────────────── Filters ─────────────────────────────

/** UTC instant of local midnight at the start of `date` (the office's calendar day). */
export function localDayStartIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

/** Local 'DD-MMM-YYYY HH:MM' for messages. */
export function localDateTime(ts: string): string {
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return ts;
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${formatDate(todayLocal(dt))} ${hh}:${mm}`;
}

type AuditFilter = Omit<AuditListInput, 'limit' | 'offset' | 'order'>;

function buildWhere(f: AuditFilter): { where: string; params: Record<string, string | number> } {
  const parts: string[] = [];
  const params: Record<string, string | number> = {};
  if (f.from && f.to && f.to < f.from) throw rule('The "to" date is before the "from" date. Choose a valid period.');
  if (f.from) {
    parts.push('ts >= :fromTs');
    params.fromTs = localDayStartIso(f.from);
  }
  if (f.to) {
    parts.push('ts < :toTs');
    params.toTs = localDayStartIso(addDays(f.to, 1));
  }
  if (f.userId !== undefined) {
    parts.push('user_id = :userId');
    params.userId = f.userId;
  }
  if (f.actions && f.actions.length > 0) {
    const names = [...new Set(f.actions)].map((a, i) => {
      params[`a${i}`] = a;
      return `:a${i}`;
    });
    parts.push(`action IN (${names.join(', ')})`);
  }
  if (f.entityType) {
    parts.push('entity_type = :entityType');
    params.entityType = f.entityType;
  }
  if (f.entityId !== undefined) {
    parts.push('entity_id = :entityId');
    params.entityId = f.entityId;
  }
  if (f.search) {
    parts.push(`(entity_label LIKE :q ESCAPE '\\' OR username LIKE :q ESCAPE '\\' OR entity_type LIKE :q ESCAPE '\\' OR action LIKE :q ESCAPE '\\')`);
    params.q = likePattern(f.search);
  }
  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

// ───────────────────────────── Routes' services ─────────────────────────────

export function listAudit(db: Db, input: AuditListInput = {}): AuditListResult {
  const { where, params } = buildWhere(input);
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const order = input.order === 'asc' ? 'ASC' : 'DESC';
  const total = db.value<number>(`SELECT COUNT(*) FROM audit_log ${where}`, params) ?? 0;
  const rows = db.all<AuditDbRow>(`SELECT * FROM audit_log ${where} ORDER BY id ${order} LIMIT :limit OFFSET :offset`, {
    ...params,
    limit,
    offset,
  });
  return { rows: rows.map((r) => toListRow(r)), total };
}

export function auditFacets(db: Db): AuditFacets {
  const entityTypes = db
    .all<{ value: string; count: number }>(
      'SELECT entity_type AS value, COUNT(*) AS count FROM audit_log WHERE entity_type IS NOT NULL GROUP BY entity_type ORDER BY entity_type',
    )
    .map((r) => ({ ...r, label: entityTypeLabel(r.value) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const users = db.all<{ userId: number | null; username: string; count: number }>(
    `SELECT user_id AS userId, username, COUNT(*) AS count FROM audit_log WHERE username IS NOT NULL
      GROUP BY user_id, username ORDER BY username COLLATE NOCASE`,
  );
  const actions = db
    .all<{ value: string; count: number }>('SELECT action AS value, COUNT(*) AS count FROM audit_log GROUP BY action ORDER BY action')
    .filter((r): r is { value: AuditActionName; count: number } => isAction(r.value));
  const span = db.get<{ first: string | null; last: string | null }>('SELECT MIN(ts) AS first, MAX(ts) AS last FROM audit_log');
  return { entityTypes, users, actions, firstTs: span?.first ?? null, lastTs: span?.last ?? null };
}

export function getAuditEntry(db: Db, id: number): AuditEntryDetail {
  const r = db.get<AuditDbRow>('SELECT * FROM audit_log WHERE id = :id', { id });
  if (!r) throw notFound('Edit log entry', id);
  const before = parseJson(r.before_json);
  const after = parseJson(r.after_json);
  const d = diffJson(before, after);
  return { ...toListRow(r, before, after), before, after, changes: d.changes, changesTruncated: d.truncated, prevHash: r.prev_hash, hash: r.hash };
}

export function entityHistory(db: Db, input: AuditEntityHistoryInput): AuditEntityHistory {
  const params: Record<string, string | number> = { type: input.entityType, id: input.entityId, limit: AUDIT_HISTORY_MAX_VERSIONS + 1 };
  let guidFilter = '';
  if (input.entityGuid) {
    guidFilter = 'AND (entity_guid = :guid OR entity_guid IS NULL)';
    params.guid = input.entityGuid;
  }
  // Newest N, shown oldest first.
  const rows = db
    .all<AuditDbRow>(`SELECT * FROM audit_log WHERE entity_type = :type AND entity_id = :id ${guidFilter} ORDER BY id DESC LIMIT :limit`, params)
    .reverse();
  const truncated = rows.length > AUDIT_HISTORY_MAX_VERSIONS;
  const kept = truncated ? rows.slice(1) : rows;
  const versions: AuditHistoryVersion[] = kept.map((r) => {
    const before = parseJson(r.before_json);
    const after = parseJson(r.after_json);
    const d = diffJson(before, after);
    return { ...toListRow(r, before, after), changes: d.changes, changesTruncated: d.truncated };
  });
  return {
    entityType: input.entityType,
    entityTypeLabel: entityTypeLabel(input.entityType),
    entityId: input.entityId,
    currentLabel: kept.length ? kept[kept.length - 1].entity_label : null,
    versions,
    truncated,
  };
}

/** The open company's edit log against its out-of-database check-point (null: no check-point store). */
export function anchorCheckFor(ctx: Pick<CompanyCtx, 'app' | 'company' | 'db' | 'session'>): (AnchorCheck & { canReset: boolean }) | null {
  const store = ctx.app.auditAnchors;
  if (!store) return null;
  const anchor = store.get(ctx.company.id);
  const guid = ctx.db.value<string>('SELECT guid FROM company WHERE id = 1') ?? '';
  return { ...checkAuditAnchor(ctx.db, anchor, anchor ? store.verify(anchor) : false, guid), canReset: ctx.session.isOwner };
}

const ANCHOR_REASON: Record<AnchorCheck['reason'], string> = {
  ok: '',
  no_anchor: '',
  bad_mac: 'the saved check-point itself was altered, or it was made with another computer’s security key',
  other_company: 'the company file was replaced by a different company’s file',
  entry_removed: 'entries recorded up to then have been removed',
  entry_rewritten: 'entries recorded up to then have been rewritten',
};

/**
 * Verify the hash chain and, when given, compare it with the check-point kept outside the company file
 * (core/lib/auditAnchor.ts). `anchor` is null when the app keeps no check-points.
 */
export function verifyAuditLog(db: Db, now: Date, anchor: (AnchorCheck & { canReset: boolean }) | null = null): AuditVerifyReport {
  const result = verifyAuditChain(db);
  const totalEntries = db.value<number>('SELECT COUNT(*) FROM audit_log') ?? 0;
  const last = db.get<{ id: number; hash: string }>('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const anchorReport: AuditAnchorReport | undefined = anchor
    ? { status: anchor.status, recordedAt: anchor.at, entryId: anchor.anchoredId, canReset: anchor.canReset && (anchor.status === 'mismatch' || anchor.status === 'invalid') }
    : undefined;
  const base = {
    totalEntries,
    checkedAt: now.toISOString(),
    lastEntryId: last?.id ?? null,
    lastHash: last?.hash ?? null,
    ...(anchorReport ? { anchor: anchorReport } : {}),
  };
  const anchorBad = anchor !== null && (anchor.status === 'mismatch' || anchor.status === 'invalid');
  const anchorText = anchorBad
    ? `This computer saved a check-point of the edit log on ${anchor.at ? localDateTime(anchor.at) : 'an earlier date'} (entry #${anchor.anchoredId ?? '?'}), but ${ANCHOR_REASON[anchor.reason]}. `
    : '';
  if (result.ok && anchorBad) {
    return {
      ok: false,
      count: result.count,
      brokenAtId: null,
      reason: null,
      message: 'The edit log has been tampered with: it no longer matches the check-point saved on this computer.',
      detail:
        anchorText +
        'The entries are consistent with each other, so the log was rewritten as a whole outside Bahi ERP. Compare with a backup taken before that date. ' +
        'If you copied this company’s files back yourself (not with Restore), an Owner can accept the current log as the new check-point.',
      ...base,
    };
  }
  if (result.ok) {
    if (result.count === 0)
      return { ok: true, count: 0, brokenAtId: null, reason: null, message: 'The edit log is empty.', detail: 'Entries appear as soon as anything is created, changed or deleted.', ...base };
    const anchored =
      anchor?.status === 'match'
        ? `It also matches the check-point this computer saved on ${anchor.at ? localDateTime(anchor.at) : 'an earlier date'}, so nothing recorded up to then has been removed or rewritten. `
        : '';
    return {
      ok: true,
      count: result.count,
      brokenAtId: null,
      reason: null,
      message: `Edit log verified: all ${result.count.toLocaleString('en-IN')} entries are intact.`,
      detail:
        "Every entry's fingerprint matches its content and links to the entry before it, so no entry has been altered, inserted or removed in between. " +
        anchored +
        `Keep backups: each one also records the latest fingerprint (${(last?.hash ?? '').slice(0, 16)}…).`,
      ...base,
    };
  }
  const broken = db.get<{ ts: string }>('SELECT ts FROM audit_log WHERE id = :id', { id: result.brokenAtId });
  const when = broken ? ` (${localDateTime(broken.ts)})` : '';
  const message =
    result.reason === 'hash_mismatch'
      ? `The edit log has been tampered with: entry #${result.brokenAtId}${when} was changed after it was recorded.`
      : `The edit log has been tampered with: entries just before #${result.brokenAtId}${when} were removed, inserted or changed.`;
  return {
    ok: false,
    count: result.count,
    brokenAtId: result.brokenAtId,
    reason: result.reason,
    message,
    detail:
      `${result.count.toLocaleString('en-IN')} earlier ${result.count === 1 ? 'entry is' : 'entries are'} intact. ` +
      anchorText +
      'Someone changed the company file outside Bahi ERP. Compare with a backup taken before this date, and review who has access to the company files.',
    ...base,
  };
}

/**
 * Owner accepts the current edit log as the new check-point after a reported mismatch (e.g. the
 * company files were copied back by hand). Recorded in the edit log itself, with the old check-point.
 */
export function resetAuditAnchor(ctx: CompanyCtx): AuditAnchorResetResult {
  if (!ctx.session.isOwner) throw forbidden('Only an Owner can accept the current edit log as the new check-point.');
  const check = anchorCheckFor(ctx);
  if (!check || (check.status !== 'mismatch' && check.status !== 'invalid')) throw rule('The edit log matches its check-point; there is nothing to reset.');
  ctx.db.transaction(() =>
    ctx.audit({
      action: 'security',
      entityType: 'audit_anchor',
      entityLabel: 'Edit-log check-point reset',
      before: { status: check.status, reason: check.reason, recordedAt: check.at, entryId: check.anchoredId },
      after: { acceptedBy: ctx.session.username },
    }),
  );
  return { anchoredEntryId: controllerFor(ctx.app).resetAuditAnchor().anchoredId };
}

// ───────────────────────────── Export ─────────────────────────────

const scalarText = (v: JsonValue | null): string => (v === null ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v));

function changesText(changes: AuditFieldChange[], truncated: boolean): string {
  const parts = changes.map((c) =>
    c.kind === 'added' ? `${c.path}: ${scalarText(c.after)}` : c.kind === 'removed' ? `${c.path}: removed (was ${scalarText(c.before)})` : `${c.path}: ${scalarText(c.before)} → ${scalarText(c.after)}`,
  );
  let text = parts.join('; ');
  if (truncated) text += '; …';
  return text.length > EXPORT_CHANGES_MAX ? `${text.slice(0, EXPORT_CHANGES_MAX - 1)}…` : text;
}

/** Windows-safe file name part. */
const safeFilePart = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Company';

export function exportAuditLog(ctx: CompanyCtx, input: AuditExportInput): AuditExportResult {
  const { db, session } = ctx;
  if (!session.isOwner && !session.permissions.has('data.export'))
    throw forbidden('Exporting the edit log also needs the "Export data" permission. Ask an Owner to grant it.');
  for (const [k, d] of [['from', input.from], ['to', input.to]] as const) if (d !== undefined && !isValidDate(d)) throw rule(`Enter a valid "${k}" date`);

  const filter: AuditFilter = {
    from: input.from,
    to: input.to,
    userId: input.userId,
    actions: input.actions,
    entityType: input.entityType,
    entityId: input.entityId,
    search: input.search,
  };
  const { where, params } = buildWhere(filter);
  const count = db.value<number>(`SELECT COUNT(*) FROM audit_log ${where}`, params) ?? 0;
  if (count > AUDIT_EXPORT_MAX_ROWS)
    throw rule(
      `The edit log has ${count.toLocaleString('en-IN')} entries for this selection; at most ${AUDIT_EXPORT_MAX_ROWS.toLocaleString('en-IN')} can be exported at a time. Choose a shorter period.`,
    );

  const now = ctx.clock.now();
  const header = ['Entry #', 'Date', 'Time', 'User', 'Action', 'Record type', 'Record id', 'Record', 'Summary', 'Changes', 'Timestamp (UTC)', 'Fingerprint (SHA-256)'];
  const xlsxRows: XlsxCell[][] = [];
  const csvRows: Array<Array<string | number | null>> = [header];
  const PAGE = 2000;
  let lastId = 0;
  for (;;) {
    const page = db.all<AuditDbRow>(`SELECT * FROM audit_log ${where ? `${where} AND` : 'WHERE'} id > :lastId ORDER BY id LIMIT ${PAGE}`, {
      ...params,
      lastId,
    });
    if (page.length === 0) break;
    for (const r of page) {
      lastId = r.id;
      const before = parseJson(r.before_json);
      const after = parseJson(r.after_json);
      const d = r.action === 'alter' || r.action === 'settings' || r.action === 'security' ? diffJson(before, after, 300) : { changes: [], truncated: false };
      const dt = new Date(r.ts);
      const localDate = Number.isNaN(dt.getTime()) ? '' : todayLocal(dt);
      const localTime = Number.isNaN(dt.getTime()) ? '' : dt.toTimeString().slice(0, 8);
      const cells: Array<string | number | null> = [
        r.id,
        localDate,
        localTime,
        r.username ?? '',
        actionLabel(r.action),
        entityTypeLabel(r.entity_type),
        r.entity_id,
        r.entity_label ?? '',
        summarizeEntry(r.action, r.entity_type, before, after),
        changesText(d.changes, d.truncated),
        r.ts,
        r.hash,
      ];
      csvRows.push(cells);
      xlsxRows.push(cells.map((v, i) => (i === 1 && v ? { v, kind: 'date' as const } : v)));
    }
  }

  const company = ctx.company.name;
  const period = `${input.from ? formatDate(input.from) : 'the beginning'} to ${input.to ? formatDate(input.to) : formatDate(ctx.clock.today())}`;
  const chain = verifyAuditChain(db);
  const chainLine = chain.ok ? `Hash chain verified: intact (${chain.count} entries)` : `WARNING: hash chain broken at entry #${chain.brokenAtId}`;
  const stamp = `${input.from ?? 'start'} to ${input.to ?? ctx.clock.today()}`;
  const fileName = `Edit log - ${safeFilePart(company)} - ${stamp}.${input.format}`;

  let bytes: Uint8Array;
  let mimeType: string;
  if (input.format === 'xlsx') {
    bytes = writeXlsx({
      creator: 'Bahi ERP',
      created: now,
      sheets: [
        {
          name: 'Edit log',
          title: [company, 'Edit log (audit trail)', `Period: ${period}`, `Exported ${localDateTime(now.toISOString())} by ${session.username}. ${chainLine}`],
          columns: [
            { header: header[0], kind: 'integer', width: 9 },
            { header: header[1], kind: 'date', width: 12 },
            { header: header[2], kind: 'text', width: 9 },
            { header: header[3], kind: 'text', width: 14 },
            { header: header[4], kind: 'text', width: 16 },
            { header: header[5], kind: 'text', width: 18 },
            { header: header[6], kind: 'integer', width: 9 },
            { header: header[7], kind: 'text', width: 30 },
            { header: header[8], kind: 'text', width: 40 },
            { header: header[9], kind: 'text', width: 60 },
            { header: header[10], kind: 'text', width: 26 },
            { header: header[11], kind: 'text', width: 30 },
          ],
          rows: xlsxRows,
          freezeHeader: true,
          autoFilter: true,
        },
      ],
    });
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    // Formula injection: toCsv prefixes ' to text starting with = + - @ TAB CR (numbers stay numbers).
    bytes = encodeUtf8WithBom(toCsv(csvRows));
    mimeType = 'text/csv';
  }

  ctx.audit({
    action: 'export',
    entityType: 'audit_log',
    entityLabel: `Edit log exported (${input.format.toUpperCase()}, ${count === 1 ? '1 entry' : `${count} entries`})`,
    after: { format: input.format, from: input.from ?? null, to: input.to ?? null, rowCount: count, fileName },
  });
  return { fileName, mimeType, bytes, rowCount: count };
}
