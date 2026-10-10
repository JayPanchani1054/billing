/**
 * Restore a backup: choose the file → check it (password for encrypted backups) → restore as a new
 * company or over a CLOSED company → done. Two frames share one flow:
 *
 *  - 'data.restore' (RestoreScreen): inside a company; routes data.backup.verify / data.backup.restore;
 *    the open company can never be replaced.
 *  - RestoreBackupDialog: Company Select screen (no company open); routes data.backup.verifyFile /
 *    data.backup.restoreFromFile; refreshes the company list afterwards.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackupRestoreResult, BackupVerifyResult } from '../../../shared/types/data.ts';
import { api } from '../../app/api.ts';
import { formatDate, formatDateTime } from '../../app/display.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import type { ScreenProps } from '../../app/registry.ts';
import { useNav } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { useShell } from '../../app/shell.tsx';
import { useAppState } from '../../app/state.tsx';
import { useConfirm } from '../../app/confirm.tsx';
import { Banner, Button, Field, KeyValueList, Modal, PasswordInput, RadioGroup, Stack, TextInput, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import { BackupChecks, chooseFile, Steps } from './components.tsx';
import { restoreChoiceProblem, restoreStep, restoreTargets, verifyOutcome, type RestoreStep } from './lib/backupView.ts';
import { BACKUP_FILTERS } from './lib/importView.ts';

const STEPS = [
  { id: 'choose', label: 'Choose backup' },
  { id: 'check', label: 'Check it' },
  { id: 'restore', label: 'Restore' },
  { id: 'done', label: 'Done' },
] as const;

interface FlowEnv {
  /** No company is open (Company Select): use the app-scope routes. */
  gate: boolean;
  openCompanyId: string | null;
  initialPath?: string;
}

interface PickedFile {
  path: string;
  fileName: string;
}

function useRestoreFlow(env: FlowEnv) {
  const app = useAppState();
  const confirm = useConfirm();
  const [file, setFile] = useState<PickedFile | null>(env.initialPath ? { path: env.initialPath, fileName: env.initialPath.split(/[\\/]/).pop() ?? env.initialPath } : null);
  const [password, setPassword] = useState('');
  const [verify, setVerify] = useState<BackupVerifyResult | null>(null);
  const [mode, setMode] = useState<'new' | 'replace'>('new');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [ownerUsername, setOwnerUsername] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [busy, setBusy] = useState<null | 'choose' | 'check' | 'restore'>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BackupRestoreResult | null>(null);

  const targets = useMemo(
    () => restoreTargets(app.state?.companies ?? [], env.openCompanyId, verify?.manifest?.companyId ?? null),
    [app.state?.companies, env.openCompanyId, verify?.manifest?.companyId],
  );
  const target = targets.find((t) => t.id === targetId) ?? null;
  const step: RestoreStep = restoreStep({ hasFile: file !== null, verified: verify?.ok === true, restored: result !== null });

  const busyRef = useRef(false);
  const check = async (f: PickedFile | null = file, pw: string = password) => {
    if (!f || busyRef.current) return;
    busyRef.current = true;
    setBusy('check');
    setError(null);
    try {
      const input = { path: f.path, password: pw || undefined };
      setVerify(env.gate ? await api('data.backup.verifyFile', input) : await api('data.backup.verify', input));
    } catch (err) {
      setError(userMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const choose = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('choose');
    setError(null);
    try {
      const picked = await chooseFile('Choose a Pevqori backup (.pvqbak)', BACKUP_FILTERS, true);
      if (!picked) return;
      if (!picked.path) {
        setError('The location of the file could not be read. Copy the backup to this computer and try again.');
        return;
      }
      const f = { path: picked.path, fileName: picked.name };
      setFile(f);
      setVerify(null);
      setPassword('');
      busyRef.current = false;
      await check(f, '');
    } catch (err) {
      setError(userMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!file || !verify?.ok || busyRef.current) return;
    const problem = restoreChoiceProblem({ mode, target, ownerPassword });
    if (problem) {
      setError(problem);
      return;
    }
    if (mode === 'replace' && target) {
      const ok = await confirm({
        title: `Replace ${target.name}?`,
        message: `The data of ${target.name} is replaced by this backup from ${verify.manifest ? formatDateTime(verify.manifest.createdAt) : 'the file'}. The current data is moved to the trash folder inside your data folder, not erased.`,
        confirmLabel: 'Replace company',
        tone: 'danger',
      });
      if (!ok) return;
    }
    busyRef.current = true;
    setBusy('restore');
    setError(null);
    try {
      const input = {
        path: file.path,
        password: password || undefined,
        mode,
        replaceId: mode === 'replace' ? target?.id : undefined,
        ownerUsername: mode === 'replace' && ownerUsername.trim() ? ownerUsername.trim() : undefined,
        ownerPassword: mode === 'replace' && ownerPassword ? ownerPassword : undefined,
      };
      const r = env.gate ? await api('data.backup.restoreFromFile', input) : await api('data.backup.restore', input);
      setResult(r);
      setOwnerPassword('');
      await app.refresh();
    } catch (err) {
      setError(userMessage(err));
      setOwnerPassword('');
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const reset = () => {
    setFile(null);
    setVerify(null);
    setPassword('');
    setResult(null);
    setError(null);
  };

  // A path passed in (from the backup list) is checked straight away.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || !env.initialPath) return;
    autoChecked.current = true;
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.initialPath]);

  const primary =
    step === 'choose'
      ? { label: 'Choose backup file…', icon: 'folder' as const, run: () => void choose() }
      : step === 'check'
        ? { label: verify?.needsPassword ? 'Check with password' : 'Check again', icon: 'check-circle' as const, run: () => void check() }
        : step === 'restore'
          ? { label: mode === 'new' ? 'Restore as new company' : `Replace ${target?.name ?? 'company'}`, icon: 'undo' as const, run: () => void restore() }
          : null;

  return {
    env,
    step,
    file,
    password,
    setPassword,
    verify,
    mode,
    setMode,
    targets,
    target,
    setTargetId,
    ownerUsername,
    setOwnerUsername,
    ownerPassword,
    setOwnerPassword,
    busy,
    error,
    setError,
    result,
    choose,
    check,
    restore,
    reset,
    primary,
  };
}

type Flow = ReturnType<typeof useRestoreFlow>;

function RestoreBody({ flow }: { flow: Flow }) {
  const { step, file, verify, result } = flow;
  const outcome = verify ? verifyOutcome(verify) : null;
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => flow.primary?.run() });
  const m = verify?.manifest;
  return (
    <div ref={formRef}>
      <Stack gap={4}>
        <Steps steps={STEPS} current={step} label="Restore steps" />

        {file ? (
          <Field label="Backup file" hint={step === 'choose' ? undefined : 'Press Alt+O to choose a different file.'}>
            <TextInput value={file.path} readOnly mono aria-label="Backup file" />
          </Field>
        ) : (
          <Banner tone="info" title="Choose the backup to restore">
            Backups end in <strong>.pvqbak</strong>. They are in the backup folder (F12 › Backup), or on the disk or USB drive you copied them to.
          </Banner>
        )}

        {m && step !== 'done' ? (
          <KeyValueList
            columns={2}
            items={[
              { key: 'company', label: 'Company', value: m.companyName, strong: true },
              { key: 'gstin', label: 'GSTIN', value: m.gstin ?? 'Not registered' },
              { key: 'made', label: 'Made on', value: formatDateTime(m.createdAt) },
              { key: 'by', label: 'Made by', value: m.createdBy ?? (m.kind === 'auto' ? 'Automatic backup' : '—') },
              { key: 'books', label: 'Books from', value: formatDate(m.booksFrom) },
              { key: 'note', label: 'Note', value: m.note ?? '—' },
            ]}
          />
        ) : null}

        {step === 'check' && verify?.needsPassword ? (
          <Field label="Backup password" required hint="The password used when this backup was made." error={verify.checks.find((c) => c.name === 'password' && c.ok === false)?.message}>
            <PasswordInput value={flow.password} onChange={(e) => flow.setPassword(e.target.value)} autoComplete="off" data-autofocus />
          </Field>
        ) : null}

        {flow.busy === 'check' ? <p className="bx-muted" role="status">Checking the backup — large files take a minute…</p> : null}

        {outcome && verify && step !== 'done' ? (
          <Stack gap={2}>
            <Banner tone={outcome.tone} title={outcome.title}>
              {outcome.message}
            </Banner>
            {!verify.ok && !verify.needsPassword ? <BackupChecks checks={verify.checks} /> : null}
          </Stack>
        ) : null}

        {step === 'restore' ? <RestoreChoices flow={flow} /> : null}

        {flow.error ? (
          <Banner tone="danger" title={step === 'restore' ? 'The backup was not restored' : 'Something went wrong'} onDismiss={() => flow.setError(null)}>
            {flow.error}
          </Banner>
        ) : null}

        {result ? (
          <Banner tone="success" title={`${result.company.name} has been restored`}>
            {result.replacedTo ? 'The data it replaced was moved to the trash folder inside your data folder. ' : ''}
            {flow.env.gate ? 'It is in the company list — select it and press Enter to open it.' : 'Close this company (F3) and select it in the company list to open it.'}
          </Banner>
        ) : null}
      </Stack>
    </div>
  );
}

function RestoreChoices({ flow }: { flow: Flow }) {
  const replaceable = flow.targets.filter((t) => t.disabledReason === null);
  return (
    <Stack gap={3}>
      <RadioGroup<'new' | 'replace'>
        label="Restore as"
        value={flow.mode}
        onChange={flow.setMode}
        options={[
          { value: 'new', label: 'A new company', description: 'Safest: your current companies stay as they are. The restored one appears in the company list.' },
          {
            value: 'replace',
            label: 'Replace an existing company',
            description: replaceable.length ? 'Its current data is moved to the trash folder and replaced by the backup.' : 'No company can be replaced right now.',
            disabled: replaceable.length === 0,
          },
        ]}
      />
      {flow.mode === 'replace' ? (
        <>
          <RadioGroup<string>
            label="Company to replace"
            value={flow.target?.id ?? null}
            onChange={(id) => flow.setTargetId(id)}
            options={flow.targets.map((t) => ({
              value: t.id,
              label: t.name,
              description: t.disabledReason ?? (t.sameCompany ? 'The company this backup was made from' : undefined),
              disabled: t.disabledReason !== null,
            }))}
          />
          {flow.target?.securityEnabled ? (
            <>
              <Field label="Owner username" optional hint="Leave empty to accept any owner of that company.">
                <TextInput value={flow.ownerUsername} onChange={(e) => flow.setOwnerUsername(e.target.value)} autoComplete="username" />
              </Field>
              <Field label="Owner password" required hint={`${flow.target.name} is password-protected.`}>
                <PasswordInput value={flow.ownerPassword} onChange={(e) => flow.setOwnerPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            </>
          ) : null}
        </>
      ) : null}
    </Stack>
  );
}

// ───────────────────────────── Workspace screen ─────────────────────────────

export function RestoreScreen({ params }: ScreenProps<{ path?: string }>) {
  const app = useAppState();
  const nav = useNav();
  const shell = useShell();
  const flow = useRestoreFlow({ gate: false, openCompanyId: app.company?.id ?? null, initialPath: params.path });
  const busy = flow.busy !== null;
  return (
    <Screen
      title="Restore Backup"
      subtitle="Bring back a company from a backup file. The company that is open now is never overwritten."
      icon="undo"
      width="form"
      dirty={flow.step === 'restore' && !busy}
      hint="Enter Next · Ctrl+A Continue · Alt+O Choose file · Esc Back"
      actions={[
        // After the restore Ctrl+A only leaves the screen: closing the company is a separate, explicit choice.
        flow.primary
          ? { key: 'Ctrl+A', label: flow.primary.label, icon: flow.primary.icon, primary: true, onClick: flow.primary.run, disabled: busy }
          : { key: 'Ctrl+A', label: 'Done', icon: 'check', primary: true, onClick: () => void nav.back() },
        { key: 'Alt+O', label: 'Choose another file', icon: 'folder', onClick: () => void flow.choose(), disabled: busy, hidden: flow.step === 'choose' || flow.step === 'done' },
        { key: 'Alt+N', label: 'Restore another', icon: 'refresh', onClick: flow.reset, hidden: flow.step !== 'done' },
        { key: 'Alt+B', label: 'Backups', icon: 'database', onClick: () => nav.push('data.backup'), group: 'more' },
      ]}
      footer={
        <>
          <Button onClick={() => void nav.back()} disabled={busy}>
            {flow.step === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {flow.primary ? (
            <Button variant="primary" icon={flow.primary.icon} loading={busy} shortcut="Ctrl+A" onClick={flow.primary.run}>
              {flow.primary.label}
            </Button>
          ) : (
            <>
              <Button icon="logout" onClick={() => void shell.closeCompany()} shortcut="F3">
                Close this company (F3)
              </Button>
              <Button variant="primary" icon="check" shortcut="Ctrl+A" onClick={() => void nav.back()}>
                Done
              </Button>
            </>
          )}
        </>
      }
    >
      <RestoreBody flow={flow} />
    </Screen>
  );
}

// ───────────────────────────── Company Select dialog ─────────────────────────────

/** "Restore a backup…" on the Company Select screen (no company open). */
export function RestoreBackupDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const flow = useRestoreFlow({ gate: true, openCompanyId: null });
  const busy = flow.busy !== null;
  const done = flow.step === 'done';
  const finish = () => {
    if (flow.result) toast.success(`${flow.result.company.name} restored`, { message: 'Select it in the list and press Enter to open it.' });
    onClose();
  };
  return (
    <Modal
      open
      onClose={() => (busy ? undefined : done ? finish() : onClose())}
      dismissible={!busy}
      title="Restore a backup"
      description="Bring back a company from a .pvqbak backup file."
      size="lg"
      footer={
        <>
          <Button onClick={done ? finish : onClose} disabled={busy}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {flow.step !== 'choose' && !done ? (
            <Button icon="folder" onClick={() => void flow.choose()} disabled={busy} shortcut="Alt+O">
              Choose another file
            </Button>
          ) : null}
          {flow.primary ? (
            <Button variant="primary" icon={flow.primary.icon} loading={busy} shortcut="Ctrl+A" onClick={flow.primary.run} data-autofocus={flow.step === 'choose' ? true : undefined}>
              {flow.primary.label}
            </Button>
          ) : (
            <Button variant="primary" icon="check" onClick={finish} shortcut="Ctrl+A">
              Done
            </Button>
          )}
        </>
      }
    >
      <DialogKeys onAccept={flow.primary?.run ?? finish} onChoose={done || flow.step === 'choose' ? undefined : () => void flow.choose()} />
      <RestoreBody flow={flow} />
    </Modal>
  );
}

function DialogKeys({ onAccept, onChoose }: { onAccept: () => void; onChoose?: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept(), 'Alt+O': onChoose ? () => onChoose() : undefined }, [onAccept, onChoose]);
  return null;
}
