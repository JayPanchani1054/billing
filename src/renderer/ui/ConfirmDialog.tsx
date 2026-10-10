import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';
import { TextInput } from './TextInput.tsx';
import { useHotkeys } from './hooks/useHotkeys.ts';
import { HotkeyScope } from './HotkeyScope.tsx';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What will happen, in plain words ("This removes voucher Sales/42 permanently."). */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' uses a red confirm button, alertdialog role and focuses Cancel first. */
  tone?: 'default' | 'danger';
  /** Require the user to type this text (e.g. the company name or "DELETE") before confirming. */
  confirmText?: string;
  /** May return a promise — the dialog shows a busy state until it settles, then closes on success. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Extra content (consequences list, checkbox…). */
  children?: ReactNode;
}

/**
 * Yes/No confirmation. Keyboard: Enter on the focused button, Ctrl+A / Y confirms, N / Esc cancels
 * (keyboard-first). Errors thrown by onConfirm are shown inline and the dialog stays open.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  confirmText,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <ConfirmImpl
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      tone={tone}
      confirmText={confirmText}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {children}
    </ConfirmImpl>
  );
}

function ConfirmImpl({
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone,
  confirmText,
  onConfirm,
  onCancel,
  children,
}: Omit<ConfirmDialogProps, 'open'> & { confirmLabel: string; cancelLabel: string; tone: 'default' | 'danger' }) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const matches = !confirmText || typed.trim() === confirmText;
  const canConfirm = matches && !busy;

  const confirm = async () => {
    if (!canConfirm) return;
    setError(null);
    try {
      const r = onConfirm();
      if (r && typeof (r as Promise<void>).then === 'function') {
        setBusy(true);
        await r;
      }
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  };

  const initialFocusRef = confirmText ? inputRef : tone === 'danger' ? cancelRef : confirmRef;

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      dismissible={!busy}
      title={title}
      size="sm"
      role={tone === 'danger' ? 'alertdialog' : 'dialog'}
      initialFocusRef={initialFocusRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => void confirm()}
            disabled={!matches}
            loading={busy}
            shortcut="Ctrl+A"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <HotkeyScope>
        <ConfirmKeys
          onYes={() => {
            if (!canConfirm) return false; // let Ctrl+A select text while the confirmation is incomplete
            void confirm();
            return true;
          }}
          onNo={() => {
            if (!busy) onCancel();
          }}
          typing={!!confirmText}
        />
        <div className="bx-confirm">
          {tone === 'danger' ? (
            <span className="bx-confirm__icon" aria-hidden="true">
              <Icon name="alert" size="lg" />
            </span>
          ) : null}
          <div className="bx-confirm__content">
            {message ? <div className="bx-confirm__message">{message}</div> : null}
            {children}
            {confirmText ? (
              <div className="bx-confirm__typed">
                <label htmlFor={inputId} className="bx-confirm__typed-label">
                  Type <strong className="bx-confirm__typed-text">{confirmText}</strong> to confirm
                </label>
                <TextInput
                  id={inputId}
                  ref={inputRef}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matches) {
                      e.preventDefault();
                      void confirm();
                    }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={typed !== '' && !matches ? true : undefined}
                />
              </div>
            ) : null}
            {error ? (
              <p className="bx-confirm__error" role="alert">
                <Icon name="x-circle" size="sm" /> {error}
              </p>
            ) : null}
          </div>
        </div>
      </HotkeyScope>
    </Modal>
  );
}

function ConfirmKeys({ onYes, onNo, typing }: { onYes: () => boolean; onNo: () => void; typing: boolean }) {
  useHotkeys({ 'Ctrl+A': onYes, y: typing ? undefined : onYes, n: typing ? undefined : onNo }, [typing]);
  return null;
}
