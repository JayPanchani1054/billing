import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import { Modal } from './Modal.tsx';
import { TextInput } from './TextInput.tsx';
import { useHotkeys } from './hooks/useHotkeys.ts';
import { HotkeyScope } from './HotkeyScope.tsx';
import { confirmHotkeys } from './lib/confirmKeys.ts';
import { accelSplit, confirmTips } from './lib/keyText.ts';

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
 * The label with its accelerator letter underlined when the label starts with it ("Y̲es", "N̲o"); other
 * labels are returned as they are (the key still works and is in the button's tooltip). The accessible
 * name is unchanged: the underline is a span inside the same text. `off` (a confirmation text must be
 * typed, so Y and N are letters, not answers) draws no underline.
 */
export function accelLabel(label: string, letter: string, off = false): ReactNode {
  const parts = off ? null : accelSplit(label, letter);
  if (!parts) return label;
  return (
    <>
      <span className="bx-accel">{parts[0]}</span>
      {parts[1]}
    </>
  );
}

/**
 * Yes/No confirmation. Keyboard: Enter on the focused button, Ctrl+A / Y confirms, N / Esc cancels
 * (keyboard-first); Ctrl+S does nothing here (it means "save", not "yes"). Errors thrown by onConfirm
 * are shown inline and the dialog stays open.
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
  const tips = confirmTips(confirmLabel, cancelLabel, !!confirmText);

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
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy} title={tips.cancel}>
            {accelLabel(cancelLabel, 'N', !!confirmText)}
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => void confirm()}
            disabled={!matches}
            loading={busy}
            shortcut="Ctrl+A"
            title={tips.confirm}
          >
            {accelLabel(confirmLabel, 'Y', !!confirmText)}
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
  // Ctrl+S (the save alias of Ctrl+A) never answers a confirmation (lib/confirmKeys.ts).
  useHotkeys(confirmHotkeys({ onYes, onNo, typing }), [typing]);
  return null;
}
