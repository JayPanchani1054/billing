/**
 * Data module routes: backup & restore, exports, Excel/CSV import, XML data import / export, data verification.
 * DTOs and the route table: src/shared/types/data.ts; behaviour: README.md in this folder.
 *
 * Async handlers (backup, verify, restore, XML data import) are `transactional: false` and open their own
 * transactions. Heavy read-only routes (exports, previews, verify) are `transactional: false` too.
 */
import type { FieldIssue } from '../../../shared/api.ts';
import {
  IMPORT_KINDS,
  MASTER_EXPORT_KINDS,
  type BackupApproveFolderInput,
  type BackupAutoInput,
  type BackupAutoResult,
  type BackupCreateInput,
  type BackupCreateResult,
  type BackupFileInfo,
  type BackupFolderStatus,
  type BackupInspectInput,
  type BackupListInput,
  type BackupListResult,
  type BackupRestoreInput,
  type BackupRestoreResult,
  type BackupVerifyInput,
  type BackupVerifyResult,
  type DataVerifyResult,
  type ExportAuditInput,
  type ExportAuditResult,
  type ExportFileResult,
  type ExportMastersInput,
  type ExportTableCell,
  type ExportTableInput,
  type ExportVouchersInput,
  type ImportCommitInput,
  type ImportCommitResult,
  type ImportKindInfo,
  type ImportPreviewInput,
  type ImportPreviewResult,
  type ImportTemplateInput,
  type XmlExportInput,
  type XmlExportResult,
  type XmlImportInput,
  type XmlImportResult,
  type XmlPreviewInput,
  type XmlPreviewResult,
  type XmlImportProgress,
} from '../../../shared/types/data.ts';
import { VOUCHER_BASE_TYPES } from '../../../shared/constants.ts';
import { appRoute, companyRoute, type RouteMap } from '../../api/route.ts';
import { customSchema } from '../../lib/schemas.ts';
import { v, type Schema } from '../../lib/validate.ts';
import { approveBackupFolder, approvedBackupFolder, autoBackup, backupFolderStatus, createBackup, inspectBackupFile, listBackups, restoreBackup, verifyBackup } from './backup.ts';
import { assertNoCompanyOpen, requirePermission } from './common.ts';
import { exportMasters, exportVouchers } from './exportData.ts';
import { auditReportOutput, exportTable } from './exportTable.ts';
import { commitImport, importProgress, importTemplate, previewImport } from './importer.ts';
import { KIND_SPECS, kindInfo } from './importSpecs.ts';
import { exportXml } from './xmlExport.ts';
import { importXml, previewXml, xmlImportProgress } from './xmlImport.ts';
import { verifyData } from './verify.ts';

/** Largest file accepted for import / XML data import (XML exports of a few years run to ~100 MB). */
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const MAX_EXPORT_ROWS = 500_000;

const path = (what: string): Schema<string> => v.string({ min: 1, max: 4000, patternMessage: `Choose the ${what}` });
const secret = (): Schema<string> => v.string({ max: 256, trim: false });

export const BackupCreateInputSchema = v.object({
  folder: path('backup folder').optional(),
  password: secret().optional(),
  note: v.string({ max: 1000 }).optional(),
}) as Schema<BackupCreateInput>;

export const BackupListInputSchema = v.object({ folder: path('backup folder').optional() }) as Schema<BackupListInput>;

export const BackupApproveFolderInputSchema = v.object({ folder: path('backup folder') }) as Schema<BackupApproveFolderInput>;

export const BackupVerifyInputSchema = v.object({ path: path('backup file'), password: secret().optional() }) as Schema<BackupVerifyInput>;

export const BackupRestoreInputSchema = v.object({
  path: path('backup file'),
  password: secret().optional(),
  mode: v.enum(['new', 'replace'] as const),
  replaceId: v.string({ min: 1, max: 80 }).optional(),
  ownerUsername: v.string({ max: 64 }).optional(),
  ownerPassword: secret().optional(),
}) as Schema<BackupRestoreInput>;

export const BackupAutoInputSchema = v.object({ trigger: v.enum(['open', 'close'] as const).optional() }) as Schema<BackupAutoInput>;

export const BackupInspectInputSchema = v.object({ path: path('backup file') }) as Schema<BackupInspectInput>;

/** One exported cell: text, finite number, boolean or empty (undefined → null). */
const cellSchema: Schema<ExportTableCell> = customSchema<ExportTableCell>((value, p, issues: FieldIssue[]) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 32_767 ? (issues.push({ path: p, message: 'Cell text is too long (Excel allows 32,767 characters)' }), undefined) : value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  issues.push({ path: p, message: 'A cell must be text, a number or empty' });
  return undefined;
});

/** Arrays of cells where undefined entries (sparse rows from the renderer) are allowed. */
const rowSchema: Schema<ExportTableCell[]> = customSchema<ExportTableCell[]>((value, p, issues: FieldIssue[]) => {
  if (!Array.isArray(value)) {
    issues.push({ path: p, message: 'A row must be a list of cells' });
    return undefined;
  }
  if (value.length > 1000) {
    issues.push({ path: p, message: 'A row has too many cells' });
    return undefined;
  }
  const out: ExportTableCell[] = [];
  const before = issues.length;
  for (let i = 0; i < value.length; i++) out.push(cellSchema.check(value[i], `${p}[${i}]`, issues) ?? null);
  return issues.length > before ? undefined : out;
});

const isoDate = v.date();

/** Report period: an ISO range or a ready label (trimmed to 200 characters). */
function exportPeriodSchema(): Schema<ExportTableInput['period']> {
  return customSchema<ExportTableInput['period']>((value, p, issues: FieldIssue[]) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value.slice(0, 200);
    return v.object({ from: isoDate, to: isoDate }).check(value, p, issues);
  });
}

export const ExportTableInputSchema = v.object({
  title: v.string({ min: 1, max: 200 }),
  subtitle: v.string({ max: 300 }).optional(),
  company: v.string({ max: 200 }).optional(),
  period: exportPeriodSchema(),
  columns: v.array(
    v.object({
      header: v.string({ max: 200 }),
      kind: v.enum(['text', 'number', 'amount', 'date', 'percent', 'integer', 'drcr', 'qty'] as const).optional(),
      width: v.number({ min: 1, max: 255 }).optional(),
      decimals: v.int({ min: 0, max: 6 }).optional(),
    }),
    { min: 1, max: 200 },
  ),
  rows: v.array(rowSchema, { max: MAX_EXPORT_ROWS }),
  totals: rowSchema.optional(),
  levels: v.array(v.int({ min: 0, max: 50 }), { max: MAX_EXPORT_ROWS }).optional(),
  notes: v.string({ max: 2000 }).optional(),
  format: v.enum(['xlsx', 'csv'] as const),
}) as Schema<ExportTableInput>;

export const ExportAuditInputSchema = v.object({
  title: v.string({ min: 1, max: 200 }),
  subtitle: v.string({ max: 300 }).optional(),
  period: exportPeriodSchema(),
  rows: v.int({ min: 0, max: MAX_EXPORT_ROWS }),
  format: v.enum(['pdf', 'print'] as const),
}) as Schema<ExportAuditInput>;

export const ExportMastersInputSchema = v.object({
  kinds: v.array(v.enum(MASTER_EXPORT_KINDS), { min: 1, max: MASTER_EXPORT_KINDS.length }),
  format: v.enum(['xlsx', 'csv'] as const),
}) as Schema<ExportMastersInput>;

export const ExportVouchersInputSchema = v.object({
  from: isoDate,
  to: isoDate,
  baseTypes: v.array(v.enum(VOUCHER_BASE_TYPES), { max: VOUCHER_BASE_TYPES.length }).optional(),
  includeOptional: v.boolean().optional(),
  includeCancelled: v.boolean().optional(),
  format: v.enum(['xlsx', 'csv'] as const),
}) as Schema<ExportVouchersInput>;

const fileName = v.string({ min: 1, max: 260 });
const fileBytes = v.bytes({ max: MAX_IMPORT_BYTES });

const ImportOptionsShape = {
  skipInvalid: v.boolean().optional(),
  updateExisting: v.boolean().optional(),
  acknowledgeWarnings: v.boolean().optional(),
  sheet: v.string({ max: 100 }).optional(),
};

export const ImportTemplateInputSchema = v.object({ kind: v.enum(IMPORT_KINDS) }) as Schema<ImportTemplateInput>;

export const ImportPreviewInputSchema = v.object({
  kind: v.enum(IMPORT_KINDS),
  fileName,
  bytes: fileBytes,
  options: v.object(ImportOptionsShape).optional(),
}) as Schema<ImportPreviewInput>;

export const ImportCommitInputSchema = v.object({
  kind: v.enum(IMPORT_KINDS),
  fileName,
  bytes: fileBytes,
  options: v.object({ ...ImportOptionsShape, skipInvalid: v.boolean(), updateExisting: v.boolean() }),
}) as Schema<ImportCommitInput>;

export const XmlPreviewInputSchema = v.object({ fileName, bytes: fileBytes }) as Schema<XmlPreviewInput>;

export const XmlImportInputSchema = v.object({
  fileName,
  bytes: fileBytes,
  options: v.object({
    masters: v.boolean().optional(),
    vouchers: v.boolean(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    onDuplicate: v.enum(['skip', 'update'] as const),
  }),
}) as Schema<XmlImportInput>;

export const XmlExportInputSchema = v.object({
  masters: v.boolean(),
  vouchers: v.boolean(),
  from: isoDate,
  to: isoDate,
}) as Schema<XmlExportInput>;

export const dataRoutes = {
  // ── Backup & restore ──
  'data.backup.create': companyRoute({
    access: 'data.backup',
    transactional: false,
    input: BackupCreateInputSchema,
    handler: (ctx, input): Promise<BackupCreateResult> => createBackup(ctx, input),
  }),
  'data.backup.list': companyRoute({
    access: 'data.backup',
    transactional: false,
    input: BackupListInputSchema,
    handler: (ctx, input): BackupListResult => listBackups(ctx, input.folder),
  }),
  'data.backup.verify': companyRoute({
    access: 'data.backup',
    transactional: false,
    input: BackupVerifyInputSchema,
    handler: (ctx, input): Promise<BackupVerifyResult> =>
      verifyBackup({ app: ctx.app, trusted: [approvedBackupFolder(ctx)] }, input.path, input.password),
  }),
  'data.backup.auto': companyRoute({
    access: 'authenticated', // a company-wide F12 policy: runs for whoever opens / closes the company
    transactional: false,
    input: BackupAutoInputSchema,
    handler: (ctx, input): Promise<BackupAutoResult> => autoBackup(ctx, input),
  }),
  // The F12 backup folder approved on this computer (a folder that came with a restored backup or a
  // copied company is used only after the user confirms it — backup.ts approvedBackupFolder).
  'data.backup.folderStatus': companyRoute({
    access: 'authenticated',
    transactional: false,
    input: v.none(),
    handler: (ctx): BackupFolderStatus => backupFolderStatus(ctx),
  }),
  'data.backup.approveFolder': companyRoute({
    access: 'company.manage', // same right as changing the folder in F12
    input: BackupApproveFolderInputSchema,
    handler: (ctx, input): BackupFolderStatus => approveBackupFolder(ctx, input),
  }),
  'data.backup.restore': companyRoute({
    access: 'data.restore',
    transactional: false,
    input: BackupRestoreInputSchema,
    handler: (ctx, input): Promise<BackupRestoreResult> =>
      restoreBackup({ app: ctx.app, clock: ctx.clock, session: ctx.session, openCompanyId: ctx.company.id, trusted: [approvedBackupFolder(ctx)] }, input),
  }),
  // Public (no login) routes below accept only backup files picked in the file dialog this session, or
  // files inside the data folder (core/lib/paths.ts) — never an arbitrary or UNC path.
  'data.backup.restoreFromFile': appRoute({
    access: 'public', // Company Select screen: only while NO company is open (enforced below)
    input: BackupRestoreInputSchema,
    handler: (ctx, input): Promise<BackupRestoreResult> => {
      assertNoCompanyOpen(ctx, 'Restoring a backup');
      return restoreBackup({ app: ctx.app, clock: ctx.clock, session: null, openCompanyId: null }, input);
    },
  }),
  'data.backup.inspectFile': appRoute({
    access: 'public',
    input: BackupInspectInputSchema,
    handler: (ctx, input): BackupFileInfo => {
      assertNoCompanyOpen(ctx, 'Checking a backup file');
      return inspectBackupFile({ app: ctx.app }, input.path);
    },
  }),
  'data.backup.verifyFile': appRoute({
    access: 'public',
    input: BackupVerifyInputSchema,
    handler: (ctx, input): Promise<BackupVerifyResult> => {
      assertNoCompanyOpen(ctx, 'Checking a backup file');
      return verifyBackup({ app: ctx.app }, input.path, input.password);
    },
  }),

  // ── Export ──
  'data.export.table': companyRoute({
    access: 'authenticated', // the data.export permission is checked by the service
    transactional: false,
    input: ExportTableInputSchema,
    handler: (ctx, input): ExportFileResult => exportTable(ctx, input),
  }),
  'data.export.audit': companyRoute({
    access: 'authenticated', // the data.export permission is checked by the service
    input: ExportAuditInputSchema,
    handler: (ctx, input): ExportAuditResult => auditReportOutput(ctx, input),
  }),
  'data.export.masters': companyRoute({
    access: 'data.export',
    transactional: false,
    input: ExportMastersInputSchema,
    handler: (ctx, input): ExportFileResult => exportMasters(ctx, input),
  }),
  'data.export.vouchers': companyRoute({
    access: 'data.export',
    transactional: false,
    input: ExportVouchersInputSchema,
    handler: (ctx, input): Promise<ExportFileResult> => exportVouchers(ctx, input), // streamed, yields (exportData.ts)
  }),

  // ── Import (Excel / CSV) ──
  'data.import.kinds': companyRoute({
    access: 'data.import',
    transactional: false,
    input: v.none(),
    handler: (): ImportKindInfo[] => IMPORT_KINDS.map((k) => kindInfo(KIND_SPECS[k])),
  }),
  'data.import.template': companyRoute({
    access: 'data.import',
    transactional: false,
    input: ImportTemplateInputSchema,
    handler: (ctx, input): ExportFileResult => {
      requirePermission(ctx, 'data.import');
      return importTemplate(input.kind);
    },
  }),
  'data.import.preview': companyRoute({
    access: 'data.import',
    transactional: false,
    input: ImportPreviewInputSchema,
    handler: (ctx, input): Promise<ImportPreviewResult> => previewImport(ctx, input),
  }),
  'data.import.commit': companyRoute({
    access: 'data.import',
    transactional: false,
    input: ImportCommitInputSchema,
    handler: (ctx, input): Promise<ImportCommitResult> => commitImport(ctx, input),
  }),
  'data.import.progress': companyRoute({
    access: 'data.import',
    transactional: false,
    input: v.none(),
    handler: (ctx): XmlImportProgress => importProgress(ctx),
  }),

  // ── XML data import / export ──
  'data.xmlImport.preview': companyRoute({
    access: 'data.import',
    transactional: false,
    input: XmlPreviewInputSchema,
    handler: (ctx, input): XmlPreviewResult => previewXml(ctx, input),
  }),
  'data.xmlImport.commit': companyRoute({
    access: 'data.import',
    transactional: false,
    input: XmlImportInputSchema,
    handler: (ctx, input): Promise<XmlImportResult> => importXml(ctx, input),
  }),
  'data.xmlImport.progress': companyRoute({
    access: 'data.import',
    transactional: false,
    input: v.none(),
    handler: (ctx): XmlImportProgress => xmlImportProgress(ctx),
  }),
  'data.xmlExport.create': companyRoute({
    access: 'data.export',
    transactional: false, // streamed from a read snapshot, yields; audited in its own transaction (xmlExport.ts)
    input: XmlExportInputSchema,
    handler: (ctx, input): Promise<XmlExportResult> => exportXml(ctx, input),
  }),

  // ── Verification ──
  'data.verify': companyRoute({
    access: 'data.backup',
    transactional: false,
    input: v.none(),
    handler: (ctx): DataVerifyResult => verifyData(ctx),
  }),
} satisfies RouteMap;
