/**
 * Small pieces shared by the accounts screens: state picker (with 96 Other Countries for
 * overseas parties), name cell, delete-with-explanation flow.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { stateOptions } from '../../../shared/gst/states.ts';
import type { StateOption } from '../../../shared/gst/states.ts';
import { isApiError, userMessage } from '../../app/lib/apiErrors.ts';
import { Badge, Icon, Picker, useHotkeys } from '../../ui/index.ts';
import type { ControlSize } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';

const STATES: readonly StateOption[] = stateOptions({ includeForeign: true, includeSpecial: true }).filter((s) => s.value !== '99');

export function StatePicker({
  value,
  onChange,
  invalid,
  disabled,
  readOnly,
  placeholder,
  size,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string;
  onChange: (code: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  size?: ControlSize;
  id?: string;
  /** Needed outside a <Field> (e.g. a grid cell): the placeholder is not an accessible name. */
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  const selected = useMemo(() => STATES.find((s) => s.value === value) ?? null, [value]);
  return (
    <Picker<StateOption>
      id={id}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      size={size}
      items={STATES}
      getKey={(s) => s.value}
      getLabel={(s) => s.label}
      getAlias={(s) => s.alpha}
      value={selected}
      onChange={(s) => onChange(s?.value ?? '')}
      placeholder={placeholder ?? 'Type a state, code or short name (e.g. MH)'}
      invalid={invalid}
      disabled={disabled}
      readOnly={readOnly}
      emptyText="No state matches"
    />
  );
}

/** Name with alias and status badges, for list/tree cells. */
export function NameCell({ name, alias, inactive, predefined, extra }: { name: string; alias?: string | null; inactive?: boolean; predefined?: boolean; extra?: ReactNode }) {
  return (
    <span className={cx('bx-acc-name', inactive && 'is-inactive')}>
      <span className="bx-truncate">{name}</span>
      {alias ? <span className="bx-acc-name__alias">({alias})</span> : null}
      {inactive ? (
        <Badge size="sm" tone="neutral">
          Inactive
        </Badge>
      ) : null}
      {predefined ? (
        <Badge size="sm" tone="neutral" variant="outline">
          Built-in
        </Badge>
      ) : null}
      {extra}
    </span>
  );
}

/** Positive confirmation line under a valid identifier. */
export function OkHint({ children }: { children: ReactNode }) {
  return (
    <span className="bx-acc-ok">
      <Icon name="check-circle" size="xs" /> {children}
    </span>
  );
}

/** A delete refusal from the server (BUSINESS_RULE) — its message explains what still uses the master. */
export function deleteRefusal(err: unknown): string | null {
  return isApiError(err) && (err.code === 'BUSINESS_RULE' || err.code === 'CONFLICT') ? userMessage(err) : null;
}

/**
 * Ctrl+A inside a Modal: render as a child of the Modal so the key binds to the dialog's own
 * (blocking) hotkey scope, not the screen underneath.
 */
export function DialogAccept({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() }, [onAccept]);
  return null;
}

/**
 * After a failed save: move focus to the first field marked invalid (aria-invalid) inside `root`,
 * once React has rendered the errors (ARCHITECTURE §7 — errors inline, focus the first invalid field).
 */
export function focusFirstInvalid(root: HTMLElement | null): void {
  if (!root) return;
  requestAnimationFrame(() => {
    const el = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: 'center' });
  });
}
