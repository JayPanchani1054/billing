import { useLayoutEffect, useRef } from 'react';
import type { ChangeEvent, Ref, TextareaHTMLAttributes } from 'react';
import { useFieldControl } from './fieldContext.ts';
import { useMergedRefs } from './hooks/useMergedRefs.ts';
import { cx } from './lib/cx.ts';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Grow with content between `rows` and `maxRows`. */
  autoGrow?: boolean;
  maxRows?: number;
  /** Show "n / maxLength" under the field. */
  showCount?: boolean;
  onValueChange?: (value: string) => void;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Multi-line text (narration, addresses). In Enter-advance forms use Ctrl+Enter to move on. */
export function TextArea({
  invalid,
  autoGrow = false,
  maxRows = 8,
  rows = 3,
  showCount = false,
  onValueChange,
  className,
  onChange,
  ref,
  ...rest
}: TextAreaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const merged = useMergedRefs(innerRef, ref);
  const field = useFieldControl({
    id: rest.id,
    'aria-describedby': rest['aria-describedby'],
    'aria-invalid': rest['aria-invalid'],
    invalid,
    required: rest.required,
    disabled: rest.disabled,
  });

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || !autoGrow) return;
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 18;
    const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom) + Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    const max = line * maxRows + pad;
    el.style.height = `${Math.min(el.scrollHeight + (cs.boxSizing === 'border-box' ? Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth) : 0), max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  });

  const length = typeof rest.value === 'string' ? rest.value.length : undefined;
  return (
    <div className={cx('bx-textarea-wrap', showCount && 'has-count')}>
      <textarea
        ref={merged}
        rows={rows}
        className={cx('bx-textarea', field.invalid && 'is-invalid', className)}
        {...rest}
        id={field.id}
        aria-describedby={field['aria-describedby']}
        aria-invalid={field['aria-invalid']}
        required={field.required}
        disabled={field.disabled}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
      />
      {showCount && rest.maxLength ? (
        <span className="bx-textarea__count bx-num" aria-live="polite">
          {length ?? 0} / {rest.maxLength}
        </span>
      ) : null}
    </div>
  );
}
