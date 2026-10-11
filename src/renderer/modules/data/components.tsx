/**
 * Shared pieces of the data screens: file save/choose helpers, the backup check list, password field
 * with strength hint. (2.1: the wizards say their step in the title row — lib/backupView.ts stepLine.)
 */
import { useCallback, useId } from 'react';
import type { ReactNode } from 'react';
import { native } from '../../app/bridge.ts';
import { showInFolder } from '../../app/export.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import type { BackupCheck } from '../../../shared/types/data.ts';
import { Badge, Checkbox, Field, PasswordInput, useHotkeys, useToast } from '../../ui/index.ts';
import type { CheckboxProps } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import { checkLabel, enterRunsStep, passwordStrength } from './lib/backupView.ts';

// ───────────────────────────── Checkbox with a focus hint ─────────────────────────────

/**
 * A checkbox whose explanation shows on focus and on hover, not as a second line on screen (2.1, D23): it
 * is a field hint (`.bx-field__message`, visually hidden until the row has focus — its line stays reserved,
 * so nothing moves) and the input's accessible description; the row's tooltip repeats it for the mouse.
 */
export function TipCheckbox({ tip, ...props }: Omit<CheckboxProps, 'description' | 'title' | 'aria-describedby'> & { tip?: string }) {
  const hintId = `${useId()}-hint`;
  if (!tip) return <Checkbox {...props} />;
  return (
    <div className="bx-field" title={tip}>
      <Checkbox {...props} aria-describedby={hintId} />
      <p className="bx-field__message" id={hintId}>
        {tip}
      </p>
    </div>
  );
}

// ───────────────────────────── Enter runs the step ─────────────────────────────

/**
 * A wizard step whose one action is the title row's primary (Choose file…): Enter runs it where Enter has no
 * other job (2.0 focused an in-page button for this; 2.1 has only the title-row button, Ctrl+A).
 */
export function useEnterRunsStep(run: () => void, enabled: boolean): void {
  useHotkeys(
    {
      Enter: (e) => {
        if (!enterRunsStep(e.target instanceof Element ? e.target : null)) return false;
        run();
        return true;
      },
    },
    [],
    { enabled, allowRepeat: false },
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
            {/* 2.1: a passed or skipped check is a quiet word; only a failure is a badge. */}
            {tone === 'danger' ? (
              <Badge tone="danger" size="sm">
                {text}
              </Badge>
            ) : (
              <span className="bx-muted">{c.ok === true ? `${text} ✓` : text}</span>
            )}
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
