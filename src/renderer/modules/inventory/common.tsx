/** Small shared pieces of the inventory screens. */
import type { ReactNode } from 'react';
import { fieldErrorsOf, isApiError, useFeatures, useNav, userMessage } from '../../app/index.ts';
import { Button, EmptyState, useHotkeys } from '../../ui/index.ts';
import { formErrorKey } from './lib/itemForm.ts';

/** Other modules whose screens show inventory masters (stock reports, vouchers, GST HSN summaries). */
export const INVENTORY_INVALIDATES: readonly string[] = ['stock', 'reports', 'vouchers', 'gst'];

/** Focus (and scroll to) a control by element id. Returns true when found. */
export function focusField(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  el.focus();
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  return true;
}

/** Focus the first field (in `order`) that has an error. */
export function focusFirstError(errors: Record<string, string | undefined>, order: readonly string[], idOf: (key: string) => string): void {
  for (const k of order) if (errors[k] && focusField(idOf(k))) return;
  for (const k of Object.keys(errors)) if (errors[k] && focusField(idOf(k))) return;
}

/**
 * Split an API error into field messages (keys like 'openings.0.qty') and a general message for a
 * banner (business rule, lock, conflict…). Validation errors without a known field also go to the banner.
 */
export function splitApiError(err: unknown, knownField: (key: string) => boolean): { fields: Record<string, string>; message: string | null } {
  const raw = fieldErrorsOf(err);
  const fields: Record<string, string> = {};
  const loose: string[] = [];
  for (const [path, msg] of Object.entries(raw)) {
    const key = formErrorKey(path);
    if (knownField(key)) fields[key] = msg;
    else loose.push(msg);
  }
  if (Object.keys(fields).length === 0) return { fields, message: loose.length ? loose.join(' ') : userMessage(err) };
  return { fields, message: loose.length ? loose.join(' ') : null };
}

export const isLocked = (err: unknown): boolean => isApiError(err) && err.code === 'LOCKED';

/** Registers Ctrl+A inside a dialog screen (dialog hotkeys must live inside DialogScreen). */
export function AcceptKey({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}

/** Shown instead of a screen when inventory (or a needed inventory feature) is turned off. */
export function FeatureOff({ title, body }: { title: string; body: ReactNode }) {
  const nav = useNav();
  return (
    <EmptyState
      icon="box"
      title={title}
      body={body}
      action={
        nav.canOpen('company.features') ? (
          <Button variant="primary" icon="settings" onClick={() => nav.push('company.features')}>
            Open Features (F11)
          </Button>
        ) : undefined
      }
    />
  );
}

/** True when the company keeps inventory (F11). */
export function useInventoryOn(): boolean {
  return useFeatures().inventory;
}
