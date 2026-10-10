/**
 * Shared pieces of the data screens: wizard step indicator, file save/choose helpers, the backup
 * check list, password field with strength hint.
 */
import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { native } from '../../app/bridge.ts';
import { showInFolder } from '../../app/export.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import type { BackupCheck } from '../../../shared/types/data.ts';
import { Badge, Field, Icon, PasswordInput, useToast } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import { checkLabel, passwordStrength } from './lib/backupView.ts';

// ───────────────────────────── Steps ─────────────────────────────

export interface StepDef {
  id: string;
  label: string;
}

/** Wizard progress: "1 Choose · 2 Check · 3 Import". Current step has aria-current="step". */
export function Steps({ steps, current, label }: { steps: readonly StepDef[]; current: string; label: string }) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <ol className="bx-data-steps" aria-label={label}>
      {steps.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'todo';
        return (
          <li key={s.id} className={cx('bx-data-steps__item', `is-${state}`)} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="bx-data-steps__num" aria-hidden="true">
              {state === 'done' ? <Icon name="check" size="xs" /> : i + 1}
            </span>
            <span className="bx-data-steps__label">
              {s.label}
              {state === 'done' ? <span className="bx-sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ───────────────────────────── Files ─────────────────────────────

export interface ChosenFile {
  name: string;
  size: number;
  bytes: Uint8Array;
  path?: string;
}

/** Native "Open" dialog → the file's bytes (null when cancelled). */
export async function chooseFile(title: string, filters: Array<{ name: string; extensions: string[] }>, withPath = false): Promise<ChosenFile | null> {
  return native('dialog.openFile', { title, filters, withPath });
}

/** Save bytes through the native save dialog and toast "Saved … · Show in folder". */
export function useSaveFile(): (bytes: Uint8Array, fileName: string, title: string) => Promise<string | null> {
  const toast = useToast();
  return useCallback(
    async (bytes, fileName, title) => {
      const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
      const filters =
        ext === 'xlsx'
          ? [{ name: 'Excel workbook', extensions: ['xlsx'] }]
          : ext === 'zip'
            ? [{ name: 'ZIP file', extensions: ['zip'] }]
            : ext === 'xml'
              ? [{ name: 'XML file', extensions: ['xml'] }]
              : [{ name: 'CSV', extensions: ['csv'] }];
      try {
        const saved = await native('dialog.saveFile', { title, defaultName: fileName, filters, data: bytes });
        if (!saved) return null;
        toast.success(`Saved ${saved.path.split(/[\\/]/).pop() ?? fileName}`, { action: { label: 'Show in folder', onClick: () => showInFolder(saved.path) } });
        return saved.path;
      } catch (err) {
        toast.error('The file was not saved', { message: userMessage(err) });
        return null;
      }
    },
    [toast],
  );
}

// ───────────────────────────── Backup checks ─────────────────────────────

/** Pass / fail / not checked list of a backup verification. */
export function BackupChecks({ checks }: { checks: readonly BackupCheck[] }) {
  return (
    <ul className="bx-data-checks" aria-label="Backup checks">
      {checks.map((c) => {
        const tone = c.ok === true ? 'success' : c.ok === false ? 'danger' : 'neutral';
        const text = c.ok === true ? 'Passed' : c.ok === false ? 'Failed' : 'Not checked';
        return (
          <li key={c.name} className="bx-data-checks__item">
            <Badge tone={tone} icon={c.ok === true ? 'check' : c.ok === false ? 'x-circle' : 'help'} size="sm">
              {text}
            </Badge>
            <span className="bx-data-checks__name">{checkLabel(c.name)}</span>
            <span className="bx-data-checks__msg">{c.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ───────────────────────────── Password with strength ─────────────────────────────

export function BackupPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  errors,
  disabled,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  errors: { password?: string; confirm?: string };
  disabled?: boolean;
}) {
  const s = passwordStrength(password);
  const hint: ReactNode =
    password === '' ? (
      'Optional. With a password the backup is encrypted — keep the password safe: without it the backup cannot be restored.'
    ) : (
      <span className="bx-data-strength" aria-live="polite">
        <span className={cx('bx-data-strength__meter', `is-${s.score}`)} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span>
          Strength: <strong>{s.label}</strong>
          {s.tip ? ` — ${s.tip}` : ''}
        </span>
      </span>
    );
  return (
    <>
      <Field label="Password" optional hint={hint} error={errors.password}>
        <PasswordInput value={password} onChange={(e) => onPassword(e.target.value)} autoComplete="new-password" disabled={disabled} />
      </Field>
      {password !== '' ? (
        <Field label="Type the password again" required error={errors.confirm}>
          <PasswordInput value={confirm} onChange={(e) => onConfirm(e.target.value)} autoComplete="new-password" disabled={disabled} />
        </Field>
      ) : null}
    </>
  );
}
