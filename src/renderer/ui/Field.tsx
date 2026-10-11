import { useId, useMemo } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import { FieldContext } from './fieldContext.ts';
import type { FieldContextValue } from './fieldContext.ts';
import { cx } from './lib/cx.ts';

export { FieldContext, useFieldControl } from './fieldContext.ts';

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  /**
   * Helper text under the control. Replaced by `error` when present. 2.1 (D4/D23): shown while the field
   * has focus, otherwise visually hidden (still in the DOM and in `aria-describedby`).
   */
  hint?: ReactNode;
  /**
   * The hint states something that applies right now ("Books are locked up to …", "Future date — Ctrl+T"):
   * shown without focus, like an error, until the caller drops it.
   */
  hintApplies?: boolean;
  /** Inline validation message: say what happened + what to do ("GSTIN must be 15 characters — check the last digit"). */
  error?: ReactNode;
  required?: boolean;
  /** Shows "(optional)" after the label — use on forms where most fields are required. */
  optional?: boolean;
  disabled?: boolean;
  /** 'stack' (label above, default) or 'inline' ("Label : value" row). */
  layout?: 'stack' | 'inline';
  /** Label column width for inline layout (default var(--field-label-width)). */
  labelWidth?: number | string;
  /** Visually hide the label (still announced). */
  hideLabel?: boolean;
  /** Content at the right of the label row (stack layout), e.g. a link or a counter. */
  labelAction?: ReactNode;
  /** Control id override (default: generated). */
  htmlFor?: string;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Label + control + hint/error. Controls from the kit placed inside read the Field context and wire
 * up `id`, `aria-describedby`, `aria-invalid`, `required` and `disabled` automatically.
 */
export function Field({
  label,
  hint,
  hintApplies = false,
  error,
  required = false,
  optional = false,
  disabled = false,
  layout = 'stack',
  labelWidth,
  hideLabel = false,
  labelAction,
  htmlFor,
  className,
  style,
  children,
  ...rest
}: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? `${autoId}-control`;
  const labelId = `${autoId}-label`;
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== '';
  const describedBy = hasError ? errorId : hasHint ? hintId : undefined;

  const ctx = useMemo<FieldContextValue>(
    () => ({ id, labelId, describedBy, invalid: hasError, required, disabled }),
    [id, labelId, describedBy, hasError, required, disabled],
  );

  const s: CSSProperties | undefined =
    labelWidth !== undefined ? ({ ...style, '--field-label-w': typeof labelWidth === 'number' ? `${labelWidth}px` : labelWidth } as CSSProperties) : style;

  return (
    <FieldContext.Provider value={ctx}>
      <div
        className={cx('bx-field', `bx-field--${layout}`, hasError && 'is-invalid', disabled && 'is-disabled', className)}
        style={s}
        {...rest}
      >
        <div className={cx('bx-field__label-row', hideLabel && 'bx-sr-only')}>
          <label className="bx-field__label" htmlFor={id} id={labelId}>
            {label}
            {required ? (
              <span className="bx-field__required" aria-hidden="true">
                *
              </span>
            ) : null}
            {optional && !required ? <span className="bx-field__optional">(optional)</span> : null}
          </label>
          {labelAction && layout === 'stack' ? <span className="bx-field__label-action">{labelAction}</span> : null}
        </div>
        {layout === 'inline' ? (
          <span className="bx-field__colon" aria-hidden="true">
            :
          </span>
        ) : null}
        <div className="bx-field__control">{children}</div>
        {hasError ? (
          <p className="bx-field__message bx-field__message--error" id={errorId}>
            <Icon name="alert" size="xs" className="bx-field__message-icon" />
            <span>{error}</span>
          </p>
        ) : hasHint ? (
          <p className={cx('bx-field__message', hintApplies && 'bx-field__message--applies')} id={hintId}>
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

export interface FieldGroupProps extends HTMLAttributes<HTMLFieldSetElement> {
  legend?: ReactNode;
  /** Description under the legend. */
  description?: ReactNode;
  /** Arrange child Fields in N columns (default 1). */
  columns?: 1 | 2 | 3 | 4;
  ref?: Ref<HTMLFieldSetElement>;
}

/** A titled group of fields (fieldset + legend), optionally in columns. */
export function FieldGroup({ legend, description, columns = 1, className, children, ...rest }: FieldGroupProps) {
  return (
    <fieldset className={cx('bx-fieldgroup', `bx-fieldgroup--cols-${columns}`, className)} {...rest}>
      {legend ? <legend className="bx-fieldgroup__legend">{legend}</legend> : null}
      {description ? <p className="bx-fieldgroup__description">{description}</p> : null}
      <div className="bx-fieldgroup__fields">{children}</div>
    </fieldset>
  );
}
