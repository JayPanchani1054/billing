import { useState } from 'react';
import { IconButton } from './IconButton.tsx';
import { TextInput } from './TextInput.tsx';
import type { TextInputProps } from './TextInput.tsx';

export interface PasswordInputProps extends Omit<TextInputProps, 'type' | 'trailing'> {
  /** Show a "Caps Lock is on" hint while typing (default true). */
  capsLockHint?: boolean;
}

/** Password field with a show/hide toggle (Alt+F8 toggles too) and a Caps Lock warning. */
export function PasswordInput({ capsLockHint = true, onKeyDown, onKeyUp, onBlur, suffix, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const [caps, setCaps] = useState(false);
  return (
    <TextInput
      {...rest}
      type={visible ? 'text' : 'password'}
      autoComplete={rest.autoComplete ?? 'current-password'}
      spellCheck={false}
      suffix={
        caps && capsLockHint ? (
          <span className="bx-input__caps" role="status">
            Caps Lock is on
          </span>
        ) : (
          suffix
        )
      }
      onKeyDown={(e) => {
        if (e.altKey && e.key === 'F8') {
          e.preventDefault();
          setVisible((v) => !v);
        }
        setCaps(e.getModifierState('CapsLock'));
        onKeyDown?.(e);
      }}
      onKeyUp={(e) => {
        setCaps(e.getModifierState('CapsLock'));
        onKeyUp?.(e);
      }}
      onBlur={(e) => {
        setCaps(false);
        onBlur?.(e);
      }}
      trailing={
        <IconButton
          icon={visible ? 'eye-off' : 'eye'}
          aria-label={visible ? 'Hide password' : 'Show password'}
          pressed={visible}
          size="sm"
          tooltip={false}
          onClick={() => setVisible((v) => !v)}
          disabled={rest.disabled}
        />
      }
    />
  );
}
