/**
 * DTOs for the data module (src/core/modules/data): backup & restore, generic table export,
 * masters/voucher export, Excel/CSV import, Tally XML migration and the data integrity check.
 * Full file formats, column specifications and the Tally mapping table: src/core/modules/data/README.md.
 *
 * Route table:
 *
 *   'data.backup.create'          BackupCreateInput      → BackupCreateResult       data.backup     (async)
 *   'data.backup.list'            BackupListInput        → BackupListResult         data.backup
 *   'data.backup.verify'          BackupVerifyInput      → BackupVerifyResult       data.backup     (async)
 *   'data.backup.auto'            BackupAutoInput        → BackupAutoResult         authenticated   (async; shell: after open, before close/quit)
 *   'data.backup.restore'         BackupRestoreInput     → BackupRestoreResult      data.restore    (async)
 *   'data.backup.restoreFromFile' BackupRestoreInput     → BackupRestoreResult      app scope, public, only with NO company open
 *   'data.backup.inspectFile'     BackupInspectInput     → BackupFileInfo           app scope, public, only with NO company open
 *
 *   'data.export.table'           ExportTableInput       → ExportFileResult         authenticated + data.export
 *   'data.export.audit'           ExportAuditInput       → ExportAuditResult        authenticated + data.export (PDF / print of a report)
 *   'data.export.masters'         ExportMastersInput     → ExportFileResult         data.export
 *   'data.export.vouchers'        ExportVouchersInput    → ExportFileResult         data.export
 *
 *   'data.import.kinds'           none                   → ImportKindInfo[]         data.import
 *   'data.import.template'        ImportTemplateInput    → ExportFileResult         data.import
 *   'data.import.preview'         ImportPreviewInput     → ImportPreviewResult      data.import     (no writes; async, chunked)
 *   'data.import.commit'          ImportCommitInput      → ImportCommitResult       data.import     (async, chunked)
 *   'data.import.progress'        none                   → TallyProgress            data.import     (preview / import progress)
 *
 *   'data.tally.preview'          TallyPreviewInput      → TallyPreviewResult       data.import     (no writes)
 *   'data.tally.import'           TallyImportInput       → TallyImportResult        data.import     (async, chunked)
 *   'data.tally.progress'         none                   → TallyProgress            data.import
 *   'data.tally.export'           TallyExportInput       → TallyExportResult        data.export     (Tally "Import Data" XML)
 *
 *   'data.verify'                 none                   → DataVerifyResult         data.backup
 *
 * Conventions: money is integer paise (Dr +, Cr −) except where a field says "rupees"; dates are
 * 'YYYY-MM-DD'; timestamps ISO-8601 UTC; file contents travel as Uint8Array.
 */
import type { VoucherBaseType } from '../constants.ts';
import type { CompanyListItem } from './app.ts';

// ───────────────────────────── Backup & restore ─────────────────────────────

/** File extension of a Bahi backup container. */
export const BACKUP_EXTENSION = '.bahibak';

/** JSON manifest stored (unencrypted) at the start of every .bahibak file. */
export interface BackupManifest {
  format: 'bahi-backup';
  formatVersion: 1;
  /** App version that wrote the backup. */
  appVersion: string;
  /** PRAGMA user_version of the backed-up database. */
  schemaVersion: number;
  /** Company folder id at backup time. */
  companyId: string;
  /** company.guid — stable across renames. */
  companyGuid: string;
  companyName: string;
  gstin: string | null;
  booksFrom: string;
  createdAt: string;
  /** Display name of the user who made it (null for system-made backups). */
  createdBy: string | null;
  note: string | null;
  kind: 'manual' | 'auto';
  encrypted: boolean;
  compression: 'gzip';
  /** SHA-256 (hex) of the payload bytes exactly as stored (after compression and encryption). */
  payloadSha256: string;
  payloadBytes: number;
  /** SHA-256 (hex) and size of the uncompressed SQLite database. */
  dbSha256: string;
  dbBytes: number;
  /**
   * Newest edit-log entry in the backed-up data, signed (HMAC) with the key of the installation that
   * made the backup (never stored in the backup). Lets that installation detect an edit log rewritten
   * inside the backup. Absent in backups made before this field existed.
   */
  auditHead?: { lastId: number; lastHash: string; mac: string | null };
}

export interface BackupCreateInput {
  /** Absolute folder; default: F12 backup folder, else <data folder>/backups/<company id>. */
  folder?: string;
  /** Encrypt the backup (AES-256-GCM, scrypt-derived key). At least 8 characters. */
  password?: string;
  /** Free text shown in the backup list (stored unencrypted — never put secrets here). */
  note?: string;
}

export interface BackupCreateResult {
  path: string;
  fileName: string;
  folder: string;
  sizeBytes: number;
  createdAt: string;
  encrypted: boolean;
  /** Older backups of this company removed by the "keep last N" rule. */
  removed: string[];
  /**
   * Attached files carried in the backup (dataplus; omitted when the company has none). `missing`
   * names attachments whose stored file was missing or changed and is therefore not in the backup.
   */
  attachments?: { files: number; missing: string[] };
}

export interface BackupListInput {
  folder?: string;
}

export interface BackupFileInfo {
  path: string;
  fileName: string;
  sizeBytes: number;
  /** File modification time (ISO). */
  modifiedAt: string;
  /** null when the file is not a readable Bahi backup (see problem). */
  manifest: BackupManifest | null;
  /** User-facing reason the file cannot be used, or null. */
  problem: string | null;
  /** Backup of the company that is open now (same company id and guid). */
  isCurrentCompany: boolean;
}

export interface BackupListResult {
  folder: string;
  /** Newest first. */
  backups: BackupFileInfo[];
  /** Most recent backup recorded for this company (any folder), or null. */
  lastBackupAt: string | null;
}

export interface BackupVerifyInput {
  path: string;
  password?: string;
}

export interface BackupCheck {
  name: 'container' | 'checksum' | 'password' | 'decompress' | 'database_checksum' | 'integrity' | 'schema' | 'company' | 'edit_log' | 'attachments';
  /** null = could not be checked (e.g. password not given). */
  ok: boolean | null;
  message: string;
}

export interface BackupVerifyResult {
  /** Every check passed. */
  ok: boolean;
  path: string;
  manifest: BackupManifest | null;
  checks: BackupCheck[];
  /** The backup is encrypted and no password was given: contents could not be checked. */
  needsPassword: boolean;
  companyName: string | null;
  schemaVersion: number | null;
  /** This app can open the backed-up data (schema not newer than supported). */
  supported: boolean;
  counts: { ledgers: number; vouchers: number; stockItems: number } | null;
}

/**
 * When the shell asks for the automatic backup:
 *  - 'open'  — after the company is opened / a user logs in (catch-up after a session that ended
 *              without one); skipped for a company that was created less than 24 hours ago and has
 *              never been backed up (reason 'new' — nothing worth a copy yet);
 *  - 'close' — before the company is closed or the app quits (the default).
 */
export interface BackupAutoInput {
  trigger?: 'open' | 'close';
}

export interface BackupAutoResult {
  ran: boolean;
  reason: 'disabled' | 'recent' | 'new' | 'created' | 'failed';
  lastBackupAt: string | null;
  backup?: BackupCreateResult;
  /** User-facing message when reason is 'failed'. */
  error?: string;
}

export interface BackupRestoreInput {
  path: string;
  password?: string;
  /** 'new': install as an additional company; 'replace': overwrite the company `replaceId` (moved to trash first). */
  mode: 'new' | 'replace';
  replaceId?: string;
  /** Owner credentials of the company being replaced, required when it has security enabled. */
  ownerUsername?: string;
  ownerPassword?: string;
}

export interface BackupRestoreResult {
  company: CompanyListItem;
  /** Where the replaced company's folder was moved (trash), or null. */
  replacedTo: string | null;
  restoredFrom: string;
  manifest: BackupManifest;
}

export interface BackupInspectInput {
  path: string;
}

// ───────────────────────────── Export ─────────────────────────────

export type ExportFormat = 'xlsx' | 'csv';

export type ExportColumnKind = 'text' | 'number' | 'amount' | 'date' | 'percent' | 'integer' | 'drcr' | 'qty';

export interface ExportTableColumn {
  header: string;
  kind?: ExportColumnKind;
  width?: number;
  /** Decimal places for qty / number / percent in CSV (default 2 for qty/percent, 0 for number). */
  decimals?: number;
}

/**
 * amount: integer PAISE · drcr: signed paise (Dr +, Cr −) · percent: 18 means 18% · date: 'YYYY-MM-DD'.
 */
export type ExportTableCell = string | number | boolean | null;

export interface ExportTableInput {
  title: string;
  subtitle?: string;
  /** Company name for the header (default: the open company). */
  company?: string;
  /** ISO range or a ready label. */
  period?: { from: string; to: string } | string;
  columns: ExportTableColumn[];
  rows: ExportTableCell[][];
  totals?: ExportTableCell[];
  /** Indent level per row (tree reports), applied to the first column. */
  levels?: number[];
  notes?: string;
  format: ExportFormat;
}

/**
 * A report printed or saved as PDF in the renderer (the HTML is built there): checks the
 * data.export permission and records the 'export' edit-log entry before the shell prints.
 */
export interface ExportAuditInput {
  title: string;
  subtitle?: string;
  /** ISO range or a ready label. */
  period?: { from: string; to: string } | string;
  /** Number of data rows in the printed table. */
  rows: number;
  format: 'pdf' | 'print';
}

export interface ExportAuditResult {
  ok: true;
}

export interface ExportFileResult {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  /** Data rows written (all sheets). */
  rowCount: number;
}

export const MASTER_EXPORT_KINDS = [
  'groups',
  'ledgers',
  'stock_groups',
  'stock_items',
  'units',
  'godowns',
  'cost_centres',
  'voucher_types',
] as const;
export type MasterExportKind = (typeof MASTER_EXPORT_KINDS)[number];

export interface ExportMastersInput {
  kinds: MasterExportKind[];
  /** csv with several kinds → a .zip with one CSV per kind. */
  format: ExportFormat;
}

export interface ExportVouchersInput {
  from: string;
  to: string;
  baseTypes?: VoucherBaseType[];
  /** Default true. */
  includeOptional?: boolean;
  /** Default false. */
  includeCancelled?: boolean;
  /** csv → a .zip with Vouchers.csv, Ledger Entries.csv, Inventory Entries.csv. */
  format: ExportFormat;
}

// ───────────────────────────── Import (Excel / CSV) ─────────────────────────────

export const IMPORT_KINDS = [
  'groups',
  'ledgers',
  'stock_groups',
  'units',
  'godowns',
  'cost_centres',
  'stock_items',
  'opening_balances',
  'stock_openings',
  'sales_invoices',
  'purchase_invoices',
  'vouchers_ledger',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export type ImportColumnType = 'text' | 'amount' | 'qty' | 'number' | 'percent' | 'integer' | 'date' | 'yesno' | 'drcr' | 'choice';

export interface ImportColumnInfo {
  key: string;
  header: string;
  required: boolean;
  type: ImportColumnType;
  /** Other accepted header spellings. */
  aliases: string[];
  /** Allowed values for 'choice' columns. */
  choices?: string[];
  help: string;
}

export interface ImportKindInfo {
  kind: ImportKind;
  label: string;
  description: string;
  /** Several rows form one record (vouchers, bill-wise openings) — grouped by this column. */
  groupByHeader: string | null;
  columns: ImportColumnInfo[];
}

export interface ImportTemplateInput {
  kind: ImportKind;
}

export interface ImportOptions {
  /** Commit the valid rows and skip invalid ones (default: all-or-nothing). */
  skipInvalid?: boolean;
  /** Masters that already exist are altered (default: skipped as duplicates). */
  updateExisting?: boolean;
  /** Vouchers: save even though they raise non-blocking warnings (the user reviewed them). */
  acknowledgeWarnings?: boolean;
  /** Sheet to read from an .xlsx (default: the kind's sheet, else the first non-Instructions sheet). */
  sheet?: string;
}

export interface ImportPreviewInput {
  kind: ImportKind;
  fileName: string;
  bytes: Uint8Array;
  options?: ImportOptions;
}

export type ImportRowStatus = 'ok' | 'error' | 'warning' | 'duplicate';

export type ImportCellValue = string | number | boolean | null;

export interface ImportRowResult {
  /** Spreadsheet row number (1-based) of the record's first row. */
  rowNumber: number;
  /** All rows of a grouped record. */
  rowNumbers: number[];
  /** Record key (name, voucher key …). */
  key: string;
  /** Values as read (first row of the record), keyed by column key. */
  data: Record<string, ImportCellValue>;
  status: ImportRowStatus;
  action: 'create' | 'update' | 'skip' | 'none';
  messages: string[];
}

export interface ImportPreviewResult {
  kind: ImportKind;
  fileName: string;
  sheet: string | null;
  /** 1-based row of the header. */
  headerRow: number;
  mappedColumns: Array<{ header: string; key: string }>;
  /** File headers that match no column (ignored). */
  unmappedHeaders: string[];
  rows: ImportRowResult[];
  summary: {
    total: number;
    ok: number;
    warning: number;
    error: number;
    duplicate: number;
    willCreate: number;
    willUpdate: number;
    willSkip: number;
  };
}

export interface ImportCommitInput {
  kind: ImportKind;
  fileName: string;
  bytes: Uint8Array;
  options: ImportOptions & { skipInvalid: boolean; updateExisting: boolean };
}

export interface ImportCommitResult {
  kind: ImportKind;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Rows that were skipped or failed, with reasons. */
  rows: ImportRowResult[];
}

// ───────────────────────────── Tally migration ─────────────────────────────

export const TALLY_OBJECT_TYPES = [
  'GROUP',
  'LEDGER',
  'COSTCATEGORY',
  'COSTCENTRE',
  'CURRENCY',
  'UNIT',
  'GODOWN',
  'STOCKGROUP',
  'STOCKCATEGORY',
  'STOCKITEM',
  'VOUCHERTYPE',
  'VOUCHER',
] as const;
export type TallyObjectType = (typeof TALLY_OBJECT_TYPES)[number];

export interface TallyIssue {
  severity: 'error' | 'warning' | 'info';
  /** Machine-readable kind: unknown_parent, duplicate_name, unsupported, unbalanced, unknown_ledger, … */
  code: string;
  message: string;
  /** 'LEDGER Acme Traders', 'VOUCHER Sales 12 (05-Apr-2026)'. */
  object?: string;
}

export interface TallyPreviewInput {
  fileName: string;
  bytes: Uint8Array;
}

export interface TallyPreviewResult {
  fileName: string;
  encoding: string;
  /** SVCURRENTCOMPANY of the export, when present. */
  companyName: string | null;
  counts: Record<TallyObjectType, number>;
  /** Objects this app does not import (e.g. BUDGET, EMPLOYEE). */
  unsupported: Array<{ type: string; count: number }>;
  vouchersByType: Array<{ voucherType: string; baseType: VoucherBaseType | null; count: number }>;
  dateRange: { from: string; to: string } | null;
  /** First rows of each kind for a quick look. */
  samples: {
    groups: Array<{ name: string; parent: string | null }>;
    ledgers: Array<{ name: string; parent: string | null; openingBalance: number; gstin: string | null }>;
    stockItems: Array<{ name: string; unit: string | null; openingQty: number; openingValue: number }>;
    vouchers: Array<{ date: string; voucherType: string; number: string | null; party: string | null; amount: number }>;
  };
  /** Masters of the file that already exist in this company (by name). */
  existing: { groups: number; ledgers: number; stockItems: number; units: number; godowns: number };
  issues: TallyIssue[];
}

export interface TallyImportOptions {
  /** Import masters (default true). */
  masters?: boolean;
  vouchers: boolean;
  /** Only vouchers dated within this range. */
  from?: string;
  to?: string;
  /** What to do with masters / vouchers that already exist. */
  onDuplicate: 'skip' | 'update';
}

export interface TallyImportInput {
  fileName: string;
  bytes: Uint8Array;
  options: TallyImportOptions;
}

export interface TallyCounts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface TallyImportResult {
  masters: Record<'groups' | 'ledgers' | 'costCategories' | 'costCentres' | 'units' | 'godowns' | 'stockGroups' | 'stockCategories' | 'stockItems' | 'voucherTypes', TallyCounts>;
  vouchers: TallyCounts;
  issues: TallyIssue[];
  /** import_batches.id of this import (vouchers carry it in meta.importBatchId). */
  batchId: number;
  /** The import stopped early (an unexpected error); earlier chunks are kept. */
  stopped: boolean;
  durationMs: number;
}

export interface TallyProgress {
  running: boolean;
  phase: 'idle' | 'parse' | 'masters' | 'vouchers' | 'done' | 'failed';
  done: number;
  total: number;
  message: string;
}

export interface TallyExportInput {
  /** Write the masters (groups, ledgers, units, godowns, stock groups / categories / items, cost centres, voucher types). */
  masters: boolean;
  /** Write the vouchers dated within from..to. */
  vouchers: boolean;
  from: string;
  to: string;
}

/** Counts of masters written to the Tally XML. */
export interface TallyExportMasterCounts {
  groups: number;
  ledgers: number;
  units: number;
  godowns: number;
  stockGroups: number;
  stockCategories: number;
  stockItems: number;
  costCategories: number;
  costCentres: number;
  voucherTypes: number;
}

export interface TallyExportResult {
  /** 'Acme-Tally-20250401-20260331.zip' (masters + vouchers) or '…-Tally-Masters.xml' / '…-Tally-Vouchers-….xml'. */
  fileName: string;
  /** UTF-16LE XML with BOM, or a ZIP of 1-Masters.xml + 2-Vouchers.xml when both were asked for. */
  bytes: Uint8Array;
  mimeType: string;
  /** null when masters were not asked for. */
  masters: TallyExportMasterCounts | null;
  /**
   * Date of the opening balances written on the masters (null without masters): the books beginning,
   * or — with the vouchers of a later period — the period's first day (balances, pending bills and
   * stock on that date). The Tally company should begin its books on this date.
   */
  openingsAsOf: string | null;
  /** Vouchers written. */
  vouchers: number;
  /** Vouchers of the period NOT written, by reason (quotations, proforma, physical stock). */
  skipped: Array<{ reason: string; count: number }>;
}

// ───────────────────────────── Data verification ─────────────────────────────

export interface DataVerifyCheck {
  name: string;
  label: string;
  ok: boolean;
  /** Number of problems found. */
  count: number;
  /** Up to 50 problem descriptions (voucher numbers, table names …). */
  details: string[];
}

export interface DataVerifyResult {
  ok: boolean;
  checkedAt: string;
  checks: DataVerifyCheck[];
}
