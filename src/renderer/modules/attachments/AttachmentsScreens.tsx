/**
 * Attachments UI (dataplus; core: src/core/modules/attachments, README there).
 *
 *   'attachments.manage'    { entityType, entityId, label? }  files of one voucher / ledger / stock item
 *   'attachments.register'  every attachment of the company (Gateway › Data, Go To)
 *
 * Keys (one meaning everywhere): Alt+C attach a file (native file dialog), Enter / Alt+O open (a copy,
 * in the program Windows uses for it), Alt+K save a copy, Alt+D remove, Alt+M open what the file is
 * attached to, Alt+E export / Alt+P print the list. Alt+F opens the attachments from the voucher view
 * (VoucherAttachmentsPanel) and from the ledger / stock item forms (AttachmentsRailAction).
 *
 * The renderer never handles a path: the file dialog returns bytes, which go to 'attachments.add';
 * opening reads the bytes back ('attachments.read') and hands them to main ('attachment.openCopy').
 */
import { useMemo, useState } from 'react';
import { formatFileSize } from '../../../shared/attachments.ts';
import type { AttachmentEntityType } from '../../../shared/attachments.ts';
import type { AttachmentRegisterRow, AttachmentRow } from '../../../shared/types/attachments.ts';
import { formatDate } from '../../../shared/dates.ts';
import {
  api,
  native,
  ReportScreen,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useNav,
  userMessage,
  useScreenActions,
} from '../../app/index.ts';
import type { ScreenProps, VoucherPanelProps } from '../../app/index.ts';
import { Badge, Button, Card, DataTable, EmptyState, Inline, SegmentedControl, Stack, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import {
  ATTACHMENTS_INVALIDATES,
  ATTACHMENTS_KEY,
  ENTITY_NOUN,
  localDay,
  MANAGE_SCREEN,
  ownerTarget,
  PICK_FILTERS,
  pickedFileProblem,
  railLabel,
  registerExport,
  summaryText,
  type ManageParams,
} from './lib/model.ts';

// ───────────────────────────── Shared actions ─────────────────────────────

/** Attach / open / save a copy / remove, with toasts and confirmations. */
function useAttachmentCommands() {
  const toast = useToast();
  const confirm = useConfirm();
  const add = useApiMutation('attachments.add', { invalidates: ATTACHMENTS_INVALIDATES });
  const remove = useApiMutation('attachments.remove', { invalidates: ATTACHMENTS_INVALIDATES });
  const [busy, setBusy] = useState(false);

  const attach = async (entityType: AttachmentEntityType, entityId: number): Promise<void> => {
    let file: { name: string; size: number; bytes: Uint8Array } | null;
    try {
      file = await native('dialog.openFile', { title: 'Attach a file', filters: PICK_FILTERS });
    } catch (err) {
      toast.error('Could not open the file', { message: userMessage(err) });
      return;
    }
    if (!file) return;
    const problem = pickedFileProblem(file.name, file.size);
    if (problem) {
      toast.error('File not attached', { message: problem, duration: 10_000 });
      return;
    }
    setBusy(true);
    try {
      const row = await add.mutate({ entityType, entityId, fileName: file.name, bytes: file.bytes });
      toast.success(`Attached “${row.fileName}”`, { message: formatFileSize(row.sizeBytes) });
    } catch (err) {
      toast.error('File not attached', { message: userMessage(err), duration: 10_000 });
    } finally {
      setBusy(false);
    }
  };

  const open = async (row: Pick<AttachmentRow, 'id' | 'fileName'>): Promise<void> => {
    setBusy(true);
    try {
      const file = await api('attachments.read', { id: row.id });
      await native('attachment.openCopy', { fileName: file.fileName, bytes: file.bytes });
    } catch (err) {
      toast.error(`Could not open “${row.fileName}”`, { message: userMessage(err), duration: 10_000 });
    } finally {
      setBusy(false);
    }
  };

  const saveCopy = async (row: Pick<AttachmentRow, 'id' | 'fileName' | 'ext'>): Promise<void> => {
    setBusy(true);
    try {
      const file = await api('attachments.read', { id: row.id });
      const saved = await native('dialog.saveFile', { title: 'Save a copy of the attachment', defaultName: file.fileName, filters: [{ name: row.ext.toUpperCase(), extensions: [row.ext] }], data: file.bytes });
      if (saved) toast.success('Copy saved', { message: saved.path });
    } catch (err) {
      toast.error('Could not save the copy', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (row: Pick<AttachmentRow, 'id' | 'fileName'>): Promise<boolean> => {
    const ok = await confirm({
      title: `Remove “${row.fileName}”?`,
      message: 'The file is removed from this record (the removal is kept in the edit log). Backups made earlier still contain it.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return false;
    try {
      await remove.mutate({ id: row.id });
      toast.success(`Removed “${row.fileName}”`);
      return true;
    } catch (err) {
      toast.error('Could not remove the file', { message: userMessage(err), duration: 10_000 });
      return false;
    }
  };

  return { attach, open, saveCopy, remove: removeRow, busy: busy || add.pending || remove.pending };
}

function FileCell({ row }: { row: AttachmentRow }) {
  return (
    <Inline gap={2}>
      <span>{row.fileName}</span>
      {row.note ? <span className="bx-muted">{row.note}</span> : null}
      {row.fileOk ? null : (
        <Badge tone="danger" size="sm">
          File missing
        </Badge>
      )}
    </Inline>
  );
}

// ───────────────────────────── One record's files ─────────────────────────────

export function AttachmentsScreen({ params }: ScreenProps<ManageParams>) {
  const nav = useNav();
  const canAdd = useCan('attachments.add');
  const canRemove = useCan('attachments.remove');
  const q = useApiQuery('attachments.list', { entityType: params.entityType, entityId: params.entityId }, { staleTime: 0 });
  const cmd = useAttachmentCommands();
  const rows = q.data ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? rows[0] ?? null;
  const owner = ownerTarget({ entityType: params.entityType, entityId: params.entityId });

  const columns = useMemo<Column<AttachmentRow>[]>(
    () => [
      { key: 'file', header: 'File', render: (r) => <FileCell row={r} />, value: (r) => r.fileName, footer: () => summaryText(rows) },
      { key: 'size', header: 'Size', width: 110, align: 'right', value: (r) => formatFileSize(r.sizeBytes) },
      { key: 'on', header: 'Attached on', width: 130, kind: 'date', value: (r) => localDay(r.createdAt) },
      { key: 'by', header: 'By', width: 160, value: (r) => r.createdByName ?? '' },
    ],
    [rows],
  );

  return (
    <ReportScreen
      title="Attachments"
      subtitle={`${ENTITY_NOUN[params.entityType]}${params.label ? `: ${params.label}` : ''} · ${summaryText(rows)}`}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Alt+C Attach a file · Enter Open · Alt+K Save a copy · Alt+D Remove · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create attachment (attach a file)', icon: 'upload', primary: true, onClick: () => void cmd.attach(params.entityType, params.entityId), hidden: !canAdd, disabled: cmd.busy },
        { key: 'Alt+O', label: 'Open', icon: 'eye', onClick: () => current && void cmd.open(current), disabled: !current || cmd.busy, group: 'file' },
        { key: 'Alt+K', label: 'Save a copy', icon: 'download', onClick: () => current && void cmd.saveCopy(current), disabled: !current || cmd.busy, group: 'file' },
        { key: 'Alt+M', label: params.entityType === 'voucher' ? 'View voucher' : `Open ${ENTITY_NOUN[params.entityType].toLowerCase()}`, icon: 'external', onClick: () => nav.push(owner.screen, owner.params), hidden: !nav.isRegistered(owner.screen), group: 'go' },
        { key: 'Alt+D', label: 'Remove', icon: 'trash', onClick: () => current && void cmd.remove(current), hidden: !canRemove, disabled: !current || cmd.busy, group: 'danger' },
      ]}
      exportDef={() => {
        const e = registerExport(rows.map((r) => ({ ...r, ownerLabel: params.label ?? '', ownerDate: null })));
        return { subtitle: `${ENTITY_NOUN[params.entityType]}${params.label ? `: ${params.label}` : ''}`, columns: e.columns, rows: e.rows };
      }}
    >
      {rows.length === 0 && !q.loading ? (
        <EmptyState
          icon="file"
          title="No files attached"
          body={canAdd ? 'Press Alt+C to attach a scanned bill, challan, agreement or photo (PDF, images, Excel / Word, CSV, TXT, JSON, XML — up to 25 MB each).' : 'Nothing has been attached to this record.'}
        />
      ) : (
        <DataTable<AttachmentRow>
          aria-label="Attached files"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          selectedKey={current ? String(current.id) : null}
          onSelect={(key) => setCursor(key)}
          onRowActivate={(r) => void cmd.open(r)}
          onRowKeyDown={(e, r) => {
            if (r && e.key === 'Delete' && canRemove) {
              e.preventDefault();
              void cmd.remove(r);
            }
          }}
          loading={q.loading}
        />
      )}
    </ReportScreen>
  );
}

// ───────────────────────────── Register ─────────────────────────────

const KIND_OPTIONS: ReadonlyArray<{ value: 'all' | AttachmentEntityType; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'voucher', label: 'Vouchers' },
  { value: 'ledger', label: 'Ledgers' },
  { value: 'stock_item', label: 'Stock items' },
];

export function AttachmentRegisterScreen() {
  const nav = useNav();
  const cmd = useAttachmentCommands();
  const [kind, setKind] = useState<'all' | AttachmentEntityType>('all');
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search.trim(), 250);
  const q = useApiQuery('attachments.register', { ...(kind === 'all' ? {} : { entityType: kind }), ...(term ? { search: term } : {}), limit: 2000 }, { keepPrevious: true });
  const rows = q.data?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? rows[0] ?? null;

  const columns = useMemo<Column<AttachmentRegisterRow>[]>(
    () => [
      { key: 'on', header: 'Attached on', width: 120, kind: 'date', value: (r) => localDay(r.createdAt) },
      { key: 'kind', header: 'To', width: 100, value: (r) => ENTITY_NOUN[r.entityType] },
      { key: 'owner', header: 'Voucher / master', value: (r) => r.ownerLabel },
      { key: 'file', header: 'File', render: (r) => <FileCell row={r} />, value: (r) => r.fileName, footer: () => `${q.data?.total ?? 0} file(s) · ${formatFileSize(q.data?.totalBytes ?? 0)}` },
      { key: 'size', header: 'Size', width: 100, align: 'right', value: (r) => formatFileSize(r.sizeBytes) },
      { key: 'by', header: 'By', width: 140, value: (r) => r.createdByName ?? '' },
    ],
    [q.data],
  );

  const openOwner = (r: AttachmentRegisterRow) => {
    const t = ownerTarget(r);
    nav.push(t.screen, t.params);
  };

  return (
    <ReportScreen
      title="Attachment Register"
      subtitle={q.data ? `${q.data.total} file(s) · ${formatFileSize(q.data.totalBytes)}${q.data.total > rows.length ? ` · showing the latest ${rows.length}` : ''}` : undefined}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      hint="Enter Open the voucher / master · Alt+O Open file · Alt+K Save a copy · Ctrl+F Search"
      filters={
        <Inline gap={3}>
          <SegmentedControl aria-label="Attached to" options={KIND_OPTIONS} value={kind} onChange={setKind} size="sm" />
          <TextInput value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="File, note, voucher or master" aria-label="Search attachments" size="sm" data-search="" />
        </Inline>
      }
      actions={[
        { key: 'Alt+O', label: 'Open file', icon: 'eye', onClick: () => current && void cmd.open(current), disabled: !current || cmd.busy, group: 'file' },
        { key: 'Alt+K', label: 'Save a copy', icon: 'download', onClick: () => current && void cmd.saveCopy(current), disabled: !current || cmd.busy, group: 'file' },
        { key: 'Alt+M', label: 'Open the voucher / master', icon: 'external', onClick: () => current && openOwner(current), disabled: !current, group: 'go' },
        { key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: () => document.querySelector<HTMLInputElement>('[aria-label="Search attachments"]')?.focus(), group: 'go' },
      ]}
      exportDef={() => {
        const e = registerExport(rows);
        return { subtitle: kind === 'all' ? 'All attachments' : `Attached to ${KIND_OPTIONS.find((o) => o.value === kind)?.label.toLowerCase()}`, columns: e.columns, rows: e.rows };
      }}
    >
      <DataTable<AttachmentRegisterRow>
        aria-label="Attachment register"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(key) => setCursor(key)}
        onRowActivate={openOwner}
        loading={q.loading}
        empty={<EmptyState icon="file" title="No attachments" body="Files attached to vouchers, ledgers and stock items are listed here." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Extensions ─────────────────────────────

/**
 * Rail action "Attachments (n)" (Alt+F) for a form showing an existing ledger / stock item. Renders
 * nothing; hidden for a user who may not see the record's files.
 */
export function AttachmentsRailAction({ entityType, entityId, label }: { entityType: AttachmentEntityType; entityId: number | null; label?: string }) {
  const nav = useNav();
  const canView = useCan(entityType === 'voucher' ? 'vouchers.view' : 'masters.view');
  const counts = useApiQuery('attachments.counts', { entityType, ids: entityId === null ? [] : [entityId] }, { enabled: entityId !== null && canView, staleTime: 0 });
  const n = entityId === null ? 0 : (counts.data?.[String(entityId)] ?? 0);
  useScreenActions([
    {
      key: ATTACHMENTS_KEY,
      label: railLabel(n),
      icon: 'file',
      group: 'attachments',
      onClick: () => entityId !== null && nav.push(MANAGE_SCREEN, { entityType, entityId, ...(label ? { label } : {}) }),
      hidden: entityId === null || !canView || !nav.isRegistered(MANAGE_SCREEN),
      hint: 'Scanned bills, agreements, photos and other files kept with this record',
    },
  ]);
  return null;
}

/** 'vouchers.view' panel: the voucher's files (when it has any) and Alt+F Attachments. */
export function VoucherAttachmentsPanel({ voucherId }: VoucherPanelProps) {
  const cmd = useAttachmentCommands();
  const q = useApiQuery('attachments.list', { entityType: 'voucher', entityId: voucherId }, { staleTime: 0 });
  const rows = q.data ?? [];
  return (
    <>
      <AttachmentsRailAction entityType="voucher" entityId={voucherId} />
      {rows.length > 0 ? (
        <Card title="Attachments" subtitle={summaryText(rows)} padding="sm">
          <Stack gap={1}>
            {rows.map((r) => (
              <Inline key={r.id} gap={2}>
                <Button variant="link" size="sm" icon="file" onClick={() => void cmd.open(r)} disabled={cmd.busy}>
                  {r.fileName}
                </Button>
                <span className="bx-muted">
                  {formatFileSize(r.sizeBytes)} · {formatDate(localDay(r.createdAt))}
                  {r.createdByName ? ` · ${r.createdByName}` : ''}
                </span>
                {r.fileOk ? null : (
                  <Badge tone="danger" size="sm">
                    File missing
                  </Badge>
                )}
              </Inline>
            ))}
          </Stack>
        </Card>
      ) : null}
    </>
  );
}
