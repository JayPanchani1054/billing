/**
 * 'data.backup' — back up the open company now (optional password + note), see the backups in the
 * folder, check one (Enter / Alt+V) or restore it (Alt+R). Automatic backup settings live in F12.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackupFileInfo, BackupVerifyResult } from '../../../shared/types/data.ts';
import { api } from '../../app/api.ts';
import { native } from '../../app/bridge.ts';
import { formatBytes, formatDateTime, formatRelative } from '../../app/display.ts';
import { showInFolder } from '../../app/export.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { useCan, useCompany, useCompanyConfig } from '../../app/state.tsx';
import { Badge, Banner, Button, DataTable, EmptyState, Field, Modal, Panel, PasswordInput, Stack, TextInput, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { BackupChecks, BackupPasswordFields } from './components.tsx';
import { backupFileNamePreview, backupFreshness, backupRowStatus, passwordProblem, verifyOutcome } from './lib/backupView.ts';

export function BackupScreen() {
  const nav = useNav();
  const toast = useToast();
  const company = useCompany();
  const config = useCompanyConfig();
  const canRestore = useCan('data.restore');
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const list = useApiQuery('data.backup.list', folder ? { folder } : {}, { keepPrevious: true });
  const create = useApiMutation('data.backup.create', { invalidates: ['data.backup'] });
  const [note, setNote] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; folder?: string; note?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<BackupFileInfo | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);

  const backups = list.data?.backups ?? [];
  const current = backups.find((b) => b.path === selected) ?? backups[0] ?? null;
  const dirty = password !== '' || note.trim() !== '';
  const fresh = backupFreshness(list.data?.lastBackupAt ?? null, new Date());

  const chooseFolder = async () => {
    try {
      const picked = await native('dialog.chooseFolder', { title: 'Choose the backup folder', defaultPath: list.data?.folder });
      if (picked) setFolder(picked.path);
    } catch (err) {
      toast.error('The folder could not be chosen', { message: userMessage(err) });
    }
  };

  const backupNow = async () => {
    if (create.pending) return;
    const p = passwordProblem(password, confirm);
    if (p) {
      setErrors({ [p.field]: p.message });
      return;
    }
    setErrors({});
    setError(null);
    try {
      const r = await create.mutate({ folder, password: password || undefined, note: note.trim() || undefined });
      setPassword('');
      setConfirm('');
      setNote('');
      setSelected(r.path);
      toast.success(`Backed up to ${r.fileName}`, {
        message: `${formatBytes(r.sizeBytes)}${r.encrypted ? ' · password protected' : ''}${r.removed.length ? ` · ${r.removed.length} older backup${r.removed.length === 1 ? '' : 's'} removed` : ''}`,
        action: { label: 'Show in folder', onClick: () => showInFolder(r.path) },
      });
      void list.refetch();
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (Object.keys(f).length) setErrors(f);
      else setError(userMessage(err));
    }
  };

  const restore = (b: BackupFileInfo | null) => {
    if (b && canRestore) nav.push('data.restore', { path: b.path });
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void backupNow() });

  const columns = useMemo<Column<BackupFileInfo>[]>(
    () => [
      {
        key: 'createdAt',
        header: 'Made on',
        width: 190,
        sortable: true,
        sortValue: (b) => b.manifest?.createdAt ?? b.modifiedAt,
        render: (b) => (
          <span title={formatDateTime(b.manifest?.createdAt ?? b.modifiedAt)}>{formatRelative(b.manifest?.createdAt ?? b.modifiedAt)}</span>
        ),
      },
      {
        key: 'company',
        header: 'Company',
        value: (b) => b.manifest?.companyName ?? '',
        render: (b) =>
          b.manifest ? (
            <span>
              {b.manifest.companyName}
              {b.isCurrentCompany ? null : <span className="bx-muted"> (another company)</span>}
            </span>
          ) : (
            <span className="bx-muted">{b.problem ?? 'Not a Bahi backup'}</span>
          ),
      },
      {
        key: 'status',
        header: 'Type',
        width: 120,
        render: (b) => {
          const s = backupRowStatus(b);
          return (
            <Badge tone={s.tone} size="sm" icon={s.label === 'Password' ? 'lock' : undefined}>
              {s.label}
            </Badge>
          );
        },
      },
      { key: 'note', header: 'Note', value: (b) => b.manifest?.note ?? '', render: (b) => b.manifest?.note ?? <span className="bx-muted">—</span> },
      { key: 'sizeBytes', header: 'Size', width: 90, align: 'right', sortable: true, render: (b) => <span className="bx-num">{formatBytes(b.sizeBytes)}</span> },
      { key: 'fileName', header: 'File', width: 260, render: (b) => <span className="bx-truncate bx-mono" title={b.path}>{b.fileName}</span> },
    ],
    [],
  );

  const autoText = config
    ? config.backup.auto
      ? `Automatic backups are on — once a day, when the company is opened or closed; the newest ${config.backup.keepLast} are kept.`
      : 'Automatic backups are off.'
    : '';

  return (
    <Screen
      title="Backup"
      subtitle={company ? `Keep a copy of ${company.name} somewhere safe — ideally on another drive or a USB disk.` : undefined}
      icon="database"
      width="form"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Back up now · Alt+V Check backup · Alt+R Restore · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Back up now', icon: 'save', primary: true, onClick: () => void backupNow(), disabled: create.pending },
        { key: 'Alt+V', label: 'Check backup', icon: 'check-circle', onClick: () => current && setVerifying(current), disabled: !current, group: 'file' },
        { key: 'Alt+R', label: 'Restore…', icon: 'undo', onClick: () => restore(current), disabled: !current || !canRestore, hint: canRestore ? undefined : 'You do not have permission to restore.', group: 'file' },
        { key: 'Alt+F', label: 'Change folder', icon: 'folder', onClick: () => void chooseFolder(), group: 'file' },
        { key: 'Alt+S', label: 'Backup settings', icon: 'settings', onClick: () => nav.push('company.config'), group: 'more' },
        { key: 'Alt+K', label: 'Check books', icon: 'shield', onClick: () => nav.push('data.verify'), group: 'more' },
      ]}
    >
      <Stack gap={5}>
        {list.data ? (
          <Banner tone={fresh.tone} title={fresh.title}>
            {autoText} {config ? 'Change this in Backup settings (Alt+S).' : null}
          </Banner>
        ) : null}

        <Panel title="Back up now" description="A complete copy of this company's data in one file. Working in the company can continue while it is written.">
          <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
            <Stack gap={3}>
              <Field label="Folder" error={errors.folder} hint={company ? `File name: ${backupFileNamePreview(company.name, new Date())}` : undefined}>
                <TextInput
                  value={list.data?.folder ?? folder ?? ''}
                  readOnly
                  mono
                  aria-label="Backup folder"
                  trailing={
                    <Button size="sm" icon="folder" onClick={() => void chooseFolder()}>
                      Change…
                    </Button>
                  }
                />
              </Field>
              <Field label="Note" optional hint="Shown in the list below, e.g. “Before filing GSTR-3B”. Not encrypted — don't write passwords here." error={errors.note}>
                <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
              </Field>
              <BackupPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} errors={errors} disabled={create.pending} />
              {error ? (
                <Banner tone="danger" title="The backup was not made" onDismiss={() => setError(null)}>
                  {error}
                </Banner>
              ) : null}
              <div>
                <Button variant="primary" icon="save" loading={create.pending} shortcut="Ctrl+A" onClick={() => void backupNow()} data-enter-target>
                  {create.pending ? 'Backing up…' : 'Back up now'}
                </Button>
              </div>
            </Stack>
          </form>
        </Panel>

        <Panel title="Backups in this folder" description={list.data ? list.data.folder : undefined}>
          {list.error ? (
            <Banner tone="danger" title="The backup folder could not be read" action={<Button size="sm" onClick={() => void list.refetch()}>Try again</Button>}>
              {userMessage(list.error)}
            </Banner>
          ) : (
            <DataTable<BackupFileInfo>
              aria-label="Backups"
              columns={columns}
              rows={backups}
              getRowKey={(b) => b.path}
              selectedKey={current?.path ?? null}
              onSelect={(k) => setSelected(k)}
              onRowActivate={(b) => setVerifying(b)}
              loading={list.loading}
              gridRef={gridRef}
              height="min(50vh, 420px)"
              empty={<EmptyState size="sm" icon="database" title="No backups in this folder yet" body="Press Ctrl+A to make the first one." />}
            />
          )}
        </Panel>
      </Stack>
      {verifying ? (
        <VerifyBackupDialog
          file={verifying}
          onClose={() => setVerifying(null)}
          onRestore={canRestore ? () => {
            const b = verifying;
            setVerifying(null);
            restore(b);
          } : undefined}
        />
      ) : null}
    </Screen>
  );
}

/** Check a backup file (asks for the password of an encrypted one). */
export function VerifyBackupDialog({
  file,
  onClose,
  onRestore,
  route = 'data.backup.verify',
}: {
  file: Pick<BackupFileInfo, 'path' | 'fileName' | 'manifest'>;
  onClose: () => void;
  onRestore?: () => void;
  route?: 'data.backup.verify' | 'data.backup.verifyFile';
}) {
  const encrypted = file.manifest?.encrypted ?? false;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackupVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api(route, { path: file.path, password: password || undefined }));
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Unencrypted backups are checked straight away (once).
  useEffect(() => {
    if (encrypted || started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encrypted]);

  const outcome = result ? verifyOutcome(result) : null;
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void run() });

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      title="Check backup"
      description={file.fileName}
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          {onRestore && result?.ok ? (
            <Button icon="undo" onClick={onRestore}>
              Restore…
            </Button>
          ) : null}
          <Button variant="primary" icon="check-circle" loading={busy} onClick={() => void run()} shortcut="Ctrl+A">
            {result ? 'Check again' : 'Check'}
          </Button>
        </>
      }
    >
      <DialogKeys onAccept={() => void run()} />
      <div ref={formRef}>
        <Stack gap={3}>
          {encrypted ? (
            <Field label="Backup password" hint="The password used when this backup was made." error={result?.checks.find((c) => c.name === 'password' && c.ok === false)?.message}>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" data-autofocus />
            </Field>
          ) : null}
          {busy && !result ? <p className="bx-muted">Checking the backup — large files take a minute…</p> : null}
          {error ? (
            <Banner tone="danger" title="The backup could not be checked">
              {error}
            </Banner>
          ) : null}
          {outcome && result ? (
            <>
              <Banner tone={outcome.tone} title={outcome.title}>
                {outcome.message}
              </Banner>
              <BackupChecks checks={result.checks} />
            </>
          ) : null}
        </Stack>
      </div>
    </Modal>
  );
}

function DialogKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
