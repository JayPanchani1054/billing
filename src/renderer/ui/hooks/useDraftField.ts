import { useCallback, useState } from 'react';
import type { ChangeEvent, FocusEvent as ReactFocusEvent } from 'react';
import { useLatestRef } from './useLatestRef.ts';

export type DraftParse<V> = { ok: true; value: V } | { ok: false; error: string };

export interface DraftFieldOptions<V> {
  value: V;
  /** Display text for a committed value. */
  format: (value: V) => string;
  parse: (text: string) => DraftParse<V>;
  onChange: (value: V) => void;
  /** Final adjustment on commit (clamp, round). */
  normalize?: (value: V) => V;
  /** Validation that only applies on commit (range). Return an error message or null. */
  validate?: (value: V) => string | null;
  onCommit?: (value: V) => void;
  equals?: (a: V, b: V) => boolean;
}

export interface DraftField {
  /** Text to show in the input. */
  text: string;
  /** Error from the last failed commit (cleared as soon as the text parses again). */
  error: string | null;
  focused: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onFocus: (e: ReactFocusEvent<HTMLInputElement>) => void;
  onBlur: (e: ReactFocusEvent<HTMLInputElement>) => void;
  /** Parse + normalise + emit now (Enter, blur). Returns false when the text is invalid. */
  commit: () => boolean;
  /** Replace the draft text (e.g. after a keyboard step). */
  setText: (text: string) => void;
}

/**
 * Text-draft state for formatted inputs (numbers, amounts, dates):
 * - while focused the user edits free text; every keystroke that parses emits `onChange` live;
 * - on blur/commit the value is normalised and the text re-formatted;
 * - text that does not parse is kept (never silently discarded) and flagged via `error`.
 */
export function useDraftField<V>(options: DraftFieldOptions<V>): DraftField {
  const opts = useLatestRef(options);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const draftRef = useLatestRef(draft);

  const same = (a: V, b: V) => (opts.current.equals ? opts.current.equals(a, b) : Object.is(a, b));

  const commit = useCallback((): boolean => {
    const o = opts.current;
    const text = draftRef.current ?? o.format(o.value);
    const r = o.parse(text);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    const v = o.normalize ? o.normalize(r.value) : r.value;
    const invalid = o.validate?.(v) ?? null;
    if (invalid) {
      setError(invalid);
      return false;
    }
    if (!(o.equals ? o.equals(v, o.value) : Object.is(v, o.value))) o.onChange(v);
    setError(null);
    setDraft(null);
    o.onCommit?.(v);
    return true;
  }, [opts, draftRef]);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setDraft(text);
    const r = opts.current.parse(text);
    if (r.ok) {
      setError(null);
      if (!same(r.value, opts.current.value)) opts.current.onChange(r.value);
    }
  };

  const onFocus = () => {
    setFocused(true);
    if (draftRef.current === null) setDraft(opts.current.format(opts.current.value));
  };

  const onBlur = () => {
    setFocused(false);
    commit();
  };

  const text = draft ?? options.format(options.value);
  return { text, error, focused, onChange, onFocus, onBlur, commit, setText: setDraft };
}
