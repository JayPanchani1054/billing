/**
 * Reset another user's password (Owner / security manager). The user is asked to choose their own
 * password at the next login unless that is switched off. Also unlocks the account.
 */
import { useState } from 'react';
import type { SecurityUser } from '../../../shared/types/security.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { Banner, Button, Field, Modal, PasswordInput, Stack, Switch, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import { PasswordChecklist, usePasswordPolicy } from './components.tsx';
import { firstPasswordProblem } from './lib/passwordRules.ts';

export function ResetPasswordDialog({ user, onClose }: { user: SecurityUser; onClose: (changed: boolean) => void }) {
  const policy = usePasswordPolicy();
  const toast = useToast();
  const reset = useApiMutation('security.user.resetPassword');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (reset.pending) return;
    const p = password === '' ? 'Enter the new password' : firstPasswordProblem(policy, password, user.username);
    const e = p ? { password: p } : confirm !== password ? { confirm: 'The two passwords are different' } : {};
    setErrors(e);
    if (e.password || e.confirm) return;
    setError(null);
    try {
      await reset.mutate({ id: user.id, newPassword: password, mustChange });
      toast.success(`Password reset for “${user.username}”`, {
        message: mustChange ? 'Give them the new password in person. They will choose their own at the next login.' : 'Give them the new password in person.',
      });
      onClose(true);
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (f.newPassword) setErrors({ password: f.newPassword });
      else setError(userMessage(err));
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });

  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title={`Reset Password — ${user.displayName}`}
      description={`Sets a new password for “${user.username}” and unlocks the account.`}
      size="sm"
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="primary" icon="key" loading={reset.pending} shortcut="Ctrl+A" onClick={() => void submit()}>
            Reset password
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void submit()} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="New password" required error={errors.password}>
            <PasswordInput
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setErrors({});
              }}
              autoComplete="new-password"
              data-autofocus=""
            />
          </Field>
          <PasswordChecklist policy={policy} password={password} username={user.username} />
          <Field label="Type it again" required error={errors.confirm}>
            <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          <Switch checked={mustChange} onChange={setMustChange} label="Ask them to choose their own password at the next login" />
          {error ? (
            <Banner tone="danger" title="Password not reset">
              {error}
            </Banner>
          ) : null}
        </Stack>
      </div>
    </Modal>
  );
}

export function AcceptKey({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
