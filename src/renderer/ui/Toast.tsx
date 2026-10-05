import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Portal } from './Portal.tsx';
import { cx } from './lib/cx.ts';
import type { StatusTone } from './types.ts';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  tone?: StatusTone;
  /** One line: what happened ("Voucher saved"). */
  title: string;
  /** Optional detail / what to do next. */
  message?: string;
  action?: ToastAction;
  /** ms before auto-dismiss; 0 = stays until dismissed. Default 5000 (errors 8000). */
  duration?: number;
  /** Replace an existing toast with the same id instead of stacking. */
  id?: string;
}

export interface ToastApi {
  show: (options: ToastOptions) => string;
  success: (title: string, options?: Omit<ToastOptions, 'title' | 'tone'>) => string;
  error: (title: string, options?: Omit<ToastOptions, 'title' | 'tone'>) => string;
  info: (title: string, options?: Omit<ToastOptions, 'title' | 'tone'>) => string;
  warning: (title: string, options?: Omit<ToastOptions, 'title' | 'tone'>) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

interface ToastRecord extends Required<Pick<ToastOptions, 'tone' | 'title' | 'duration'>> {
  id: string;
  message?: string;
  action?: ToastAction;
}

const MAX_TOASTS = 4;

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON: Readonly<Record<StatusTone, IconName>> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert',
  danger: 'x-circle',
};

let seq = 0;

export interface ToastProviderProps {
  children?: ReactNode;
  /** Max visible toasts (oldest dropped). Default 4. */
  max?: number;
}

/** Provides useToast(); renders the toast stack (bottom-right; offset with --toast-inset-right/bottom). */
export function ToastProvider({ children, max = MAX_TOASTS }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const clear = useCallback(() => setToasts([]), []);

  const show = useCallback(
    (o: ToastOptions): string => {
      const tone = o.tone ?? 'info';
      const id = o.id ?? `toast-${++seq}`;
      const record: ToastRecord = {
        id,
        tone,
        title: o.title,
        message: o.message,
        action: o.action,
        duration: o.duration ?? (tone === 'danger' ? 8000 : 5000),
      };
      setToasts((list) => {
        const without = list.filter((t) => t.id !== id);
        const next = [...without, record];
        return next.length > max ? next.slice(next.length - max) : next;
      });
      return id;
    },
    [max],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, opts) => show({ ...opts, title, tone: 'success' }),
      error: (title, opts) => show({ ...opts, title, tone: 'danger' }),
      info: (title, opts) => show({ ...opts, title, tone: 'info' }),
      warning: (title, opts) => show({ ...opts, title, tone: 'warning' }),
      dismiss,
      clear,
    }),
    [show, dismiss, clear],
  );

  const polite = toasts.filter((t) => t.tone !== 'danger');
  const assertive = toasts.filter((t) => t.tone === 'danger');

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Portal>
        <div className="bx-toast-region" data-bx-overlay="">
          <div className="bx-toast-stack" role="region" aria-label="Notifications">
            <div aria-live="assertive" aria-atomic="false" className="bx-toast-live">
              {assertive.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
              ))}
            </div>
            <div aria-live="polite" aria-atomic="false" className="bx-toast-live">
              {polite.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
              ))}
            </div>
          </div>
        </div>
      </Portal>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.duration);
  const startedAt = useRef(0);

  useEffect(() => {
    remaining.current = toast.duration;
  }, [toast.duration, toast.title, toast.message]);

  useEffect(() => {
    if (toast.duration <= 0 || paused) return undefined;
    startedAt.current = Date.now();
    const t = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, toast.id, toast.duration, onDismiss]);

  return (
    <div
      className={cx('bx-toast', `bx-toast--${toast.tone}`)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="bx-toast__icon">
        <Icon name={TONE_ICON[toast.tone]} size="md" />
      </span>
      <div className="bx-toast__content">
        <p className="bx-toast__title">{toast.title}</p>
        {toast.message ? <p className="bx-toast__message">{toast.message}</p> : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          className="bx-toast__action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="bx-toast__close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <Icon name="close" size="sm" />
      </button>
    </div>
  );
}

/** Access the toast API. Must be inside <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be used inside <ToastProvider>.');
  return ctx;
}
