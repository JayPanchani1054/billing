/**
 * Change your own password — forced (before the workspace opens) or voluntary (user menu,
 * screen 'company.changePassword' as a dialog).
 */
import { useState } from 'react';
import { api } from '../../app/api.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { DialogScreen, useDirty, useNav } from '../../app/nav.tsx';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, Field, PasswordInput, Stack, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import { StrengthMeter } from './fields.tsx';
import { GateLayout } from './GateLayout.tsx';
import { passwordPolicyError } from './lib/password.ts';

interface FormState {
  current: string;
  next: string;
  confirm: string;
}

function usePasswordForm(onDone: () => void) {
  const app = useAppState();
  const [form, setForm] = useState<FormState>({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof FormState, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };

  const submit = async () => {
    if (busy) return;
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.current) e.current = 'Enter your current password';
    const policy = passwordPolicyError(form.next);
    if (policy) e.next = policy;
    else if (form.next === form.current) e.next = 'Choose a password different from the current one';
    else if (form.confirm !== form.next) e.confirm = 'The two passwords are different';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      await api('app.auth.changePassword', { currentPassword: form.current, newPassword: form.next });
      onDone();
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (f.currentPassword || f.newPassword) setErrors({ current: f.currentPassword, next: f.newPassword });
      else setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const username = app.session?.username ?? '';
  const dirty = form.current !== '' || form.next !== '' || form.confirm !== '';
  return { form, set, errors, error, busy, submit, username, dirty };
}

function PasswordFields({ f }: { f: ReturnType<typeof usePasswordForm> }) {
  return (
    <Stack gap={3}>
      <Field label="Current password" required error={f.errors.current}>
        <PasswordInput value={f.form.current} onChange={(e) => f.set('current', e.target.value)} autoComplete="current-password" data-autofocus="" autoFocus />
      </Field>
      <Field label="New password" required error={f.errors.next} hint="At least 8 characters with letters and digits.">
        <PasswordInput value={f.form.next} onChange={(e) => f.set('next', e.target.value)} autoComplete="new-password" />
      </Field>
      <StrengthMeter password={f.form.next} context={[f.username]} />
      <Field label="Type the new password again" required error={f.errors.confirm}>
        <PasswordInput value={f.form.confirm} onChange={(e) => f.set('confirm', e.target.value)} autoComplete="new-password" />
      </Field>
      {f.error ? (
        <Banner tone="danger" title="Password not changed">
          {f.error}
        </Banner>
      ) : null}
    </Stack>
  );
}

/** Gate shown when the administrator requires a new password before work can continue. */
export function ForcedChangePassword() {
  const app = useAppState();
  const f = usePasswordForm(() => void app.refresh());
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void f.submit() });
  const logout = async () => {
    try {
      app.applyState(await api('app.auth.logout'));
    } catch {
      void app.refresh();
    }
  };
  return (
    <GateLayout title="Choose a New Password" subtitle="Your administrator asked you to set a new password before continuing." width="narrow">
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          void f.submit();
        }}
      >
        <Stack gap={4}>
          <PasswordFields f={f} />
          <Button type="submit" variant="primary" loading={f.busy} fullWidth>
            Save new password
          </Button>
          <Button variant="link" onClick={() => void logout()}>
            Log out
          </Button>
        </Stack>
      </form>
    </GateLayout>
  );
}

/** Screen 'company.changePassword' (dialog). */
export function ChangePasswordScreen() {
  const nav = useNav();
  const toast = useToast();
  const f = usePasswordForm(() => {
    toast.success('Password changed', { message: 'Use the new password the next time you log in.' });
    nav.pop();
  });
  useDirty(f.dirty);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void f.submit() });
  return (
    <DialogScreen
      title="Change Password"
      description={f.username ? `For user “${f.username}”.` : undefined}
      size="sm"
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          <Button variant="primary" loading={f.busy} onClick={() => void f.submit()} shortcut="Ctrl+A">
            Change password
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void f.submit()} />
      <div ref={formRef}>
        <PasswordFields f={f} />
      </div>
    </DialogScreen>
  );
}

function AcceptKey({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
