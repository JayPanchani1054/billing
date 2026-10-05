/**
 * Promise-based confirmations and the business-rule warnings protocol.
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Delete voucher Sales/42?', tone: 'danger', confirmLabel: 'Delete' })) …
 *
 *   // Server says "needs confirmation" (BUSINESS_RULE + details.needsConfirmation + warnings):
 *   const saved = await withConfirmation((ack) => save.mutate({ ...input, acknowledgeWarnings: ack || undefined }));
 *   if (saved === undefined) return; // the user chose "Go back"
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfirmDialog } from '../ui/index.ts';
import { confirmationOf } from './lib/apiErrors.ts';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Bulleted list under the message (e.g. business-rule warnings). */
  warnings?: readonly string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** Require typing this text to confirm. */
  confirmText?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

interface Pending {
  id: number;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

let presenter: ConfirmFn | null = null;

/** Module-level confirm (usable outside components, e.g. in nav guards). Falls back to "no". */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return presenter ? presenter(options) : Promise.resolve(false);
}

let seq = 0;

export function ConfirmProvider({ children }: { children?: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        seq += 1;
        setQueue((q) => [...q, { id: seq, options, resolve }]);
      }),
    [],
  );

  useEffect(() => {
    presenter = confirm;
    return () => {
      if (presenter === confirm) presenter = null;
    };
  }, [confirm]);

  const current = queue[0];
  const settle = (ok: boolean) => {
    if (!current) return;
    current.resolve(ok);
    setQueue((q) => q.filter((p) => p.id !== current.id));
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current ? (
        <ConfirmDialog
          key={current.id}
          open
          title={current.options.title}
          message={current.options.message}
          confirmLabel={current.options.confirmLabel ?? 'Yes'}
          cancelLabel={current.options.cancelLabel ?? 'No'}
          tone={current.options.tone ?? 'default'}
          confirmText={current.options.confirmText}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        >
          {current.options.warnings && current.options.warnings.length > 0 ? (
            <ul className="bx-confirm-warnings">
              {current.options.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

/** `confirm(options) → Promise<boolean>` rendered with the kit's ConfirmDialog (Y / N / Ctrl+A / Esc). */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return useMemo(() => ctx ?? confirmDialog, [ctx]);
}

/**
 * Run `call(false)`; if it fails with a needs-confirmation business rule, list the warnings and,
 * when the user agrees, run `call(true)` (send `acknowledgeWarnings: true`). Resolves with the
 * result, or `undefined` when the user declined. Other errors propagate unchanged.
 */
export async function withConfirmation<T>(
  call: (acknowledgeWarnings: boolean) => Promise<T>,
  options: { title?: string; confirmLabel?: string; cancelLabel?: string } = {},
): Promise<T | undefined> {
  try {
    return await call(false);
  } catch (err) {
    const req = confirmationOf(err);
    if (!req) throw err;
    const ok = await confirmDialog({
      title: options.title ?? 'Please check before saving',
      message: req.message,
      warnings: req.warnings,
      confirmLabel: options.confirmLabel ?? 'Save anyway',
      cancelLabel: options.cancelLabel ?? 'Go back',
    });
    if (!ok) return undefined;
    return call(true);
  }
}
