/**
 * Small form pieces shared by the company screens: state picker, GSTIN hint, password strength.
 */
import { useMemo } from 'react';
import { stateOptions } from '../../../shared/gst/states.ts';
import type { StateOption } from '../../../shared/gst/states.ts';
import { validateGstin } from '../../../shared/gst/gstin.ts';
import { stateName } from '../../../shared/gst/states.ts';
import { Icon, Picker } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import { passwordStrength } from './lib/password.ts';

/** States a company can be registered in: 01–38 and 97 (no 96 abroad / 99 centre). */
const COMPANY_STATES: readonly StateOption[] = stateOptions({ includeSpecial: true }).filter((s) => s.value !== '99');

export function StatePicker({
  value,
  onChange,
  invalid,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (code: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const selected = useMemo(() => COMPANY_STATES.find((s) => s.value === value) ?? null, [value]);
  return (
    <Picker<StateOption>
      items={COMPANY_STATES}
      getKey={(s) => s.value}
      getLabel={(s) => s.label}
      getAlias={(s) => s.alpha}
      value={selected}
      onChange={(s) => onChange(s?.value ?? '')}
      placeholder="Type a state, code or short name (e.g. MH)"
      invalid={invalid}
      disabled={disabled}
      autoFocus={autoFocus}
      emptyText="No state matches"
    />
  );
}

/** Positive confirmation under a valid GSTIN: "Maharashtra · PAN AAPFU0939F". */
export function GstinOk({ gstin }: { gstin: string }) {
  const v = validateGstin(gstin);
  if (!v.valid) return null;
  return (
    <span className="bx-gstin-ok">
      <Icon name="check-circle" size="xs" /> Valid GSTIN · {stateName(v.stateCode)}
      {v.pan ? ` · PAN ${v.pan}` : ''}
    </span>
  );
}

/** Four-segment strength meter with the label and the top tip. */
export function StrengthMeter({ password, context = [] }: { password: string; context?: readonly string[] }) {
  const s = passwordStrength(password, context);
  if (!password) return null;
  return (
    <div className={cx('bx-strength', `bx-strength--${s.score}`)}>
      <div className="bx-strength__bar" role="meter" aria-label="Password strength" aria-valuemin={0} aria-valuemax={4} aria-valuenow={s.score} aria-valuetext={s.label}>
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={cx('bx-strength__seg', n <= s.score && 'is-on')} />
        ))}
      </div>
      <span className="bx-strength__label">{s.label}</span>
      {s.tips[0] ? <span className="bx-strength__tip">{s.tips[0]}</span> : null}
    </div>
  );
}
