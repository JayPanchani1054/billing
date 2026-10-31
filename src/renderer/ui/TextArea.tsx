import { useEffect, useLayoutEffect, useRef } from 'react';
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

/**
 * autoGrow: the height that shows the whole text, from `rows` up to `maxRows` lines (then it scrolls). The one
 * sizing rule — run after every render and again when the field's width changes, as the same text wraps to
 * another number of lines in a narrower or wider column (e.g. a side panel appearing next to the voucher grid).
 * Returns the width it fitted at (`clientWidth`).
 */
function fitToContent(el: HTMLTextAreaElement, maxRows: number): number {
  const cs = getComputedStyle(el);
  const line = Number.parseFloat(cs.lineHeight) || 18;
  const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom) + Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
  el.style.height = 'auto';
  const max = line * maxRows + pad;
  el.style.height = `${Math.min(el.scrollHeight + (cs.boxSizing === 'border-box' ? Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth) : 0), max)}px`;
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  return el.clientWidth;
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
  /** autoGrow: the width of the last fit — a size change at that width is the fit's own height. */
  const fittedWidth = useRef(-1);
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
    if (el && autoGrow) fittedWidth.current = fitToContent(el, maxRows);
  });

  // The column narrows or widens without a render of this field: fit again. Only a new WIDTH counts — the fit
  // itself changes the height, which must not start another round — and the fit runs in the next frame, outside
  // the observer's callback (a size changed inside it is reported as "ResizeObserver loop completed with
  // undelivered notifications").
  useEffect(() => {
    const el = innerRef.current;
    if (!el || !autoGrow || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === fittedWidth.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        fittedWidth.current = fitToContent(el, maxRows);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [autoGrow, maxRows]);

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
