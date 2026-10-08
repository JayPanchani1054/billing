/**
 * Turning company security on (create or confirm the Owner) and off (Owner re-enters their password).
 * After either, the app state is refreshed: turning security on ends the open-access session, so the
 * login screen appears; turning it off keeps the current session.
 */
import { useMemo, useState } from 'react';
import type { SecurityUser } from '../../../shared/types/security.ts';
import { api } from '../../app/api.ts';
import { invalidate } from '../../app/queryClient.ts';
import { fieldErrorsOf, isApiError, userMessage } from '../../app/lib/apiErrors.ts';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, Field, Modal, PasswordInput, SegmentedControl, Select, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { PasswordChecklist, usePasswordPolicy } from './components.tsx';
import { firstPasswordProblem } from './lib/passwordRules.ts';
import { usernameProblem } from './lib/users.ts';
import { AcceptKey } from './ResetPasswordDialog.tsx';

type Mode = 'new' | 'existing';

export function EnableSecurityDialog({ owners, onClose }: { owners: readonly SecurityUser[]; onClose: () => void }) {
  const app = useAppState();
  const toast = useToast();
  const policy = usePasswordPolicy();
  const [mode, setMode] = useState<Mode>(owners.length > 0 ? 'existing' : 'new');
  const [username, setUsername] = useState(owners.length > 0 ? owners[0].username : 'owner');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ username?: string; password?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ownerOptions = useMemo(() => owners.map((o) => ({ value: o.username, label: `${o.displayName} (${o.username})${o.isActive ? '' : ' — deactivated'}` })), [owners]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setErrors({});
    setPassword('');
    setConfirm('');
    setUsername(m === 'existing' && owners.length ? owners[0].username : 'owner');
  };

  const submit = async () => {
    if (busy) return;
    const e: typeof errors = {};
    if (mode === 'new') {
      const u = usernameProblem(username);
      if (u) e.username = u;
      const p = password === '' ? 'Choose a password' : firstPasswordProblem(policy, password, username);
      if (p) e.password = p;
      else if (confirm !== password) e.confirm = 'The two passwords are different';
    } else if (!password) e.password = `Enter the password of “${username}”`;
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api('security.enable', { username: username.trim(), displayName: displayName.trim() || undefined, password });
      invalidate();
      toast.success('Security is on', { message: `Log in as “${r.ownerUsername}” to continue.` });
      onClose();
      // The open-access session has ended: the shell shows the login screen.
      await app.refresh();
    } catch (err) {
      const f = fieldErrorsOf(err);
      // A refused Owner password counts as a failed login: never leave it sitting in the field.
      if (mode === 'existing' || (isApiError(err) && err.code === 'LOCKED')) {
        setPassword('');
        setConfirm('');
      }
      if (f.username || f.password) setErrors({ username: f.username, password: f.password });
      else setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });

  return (
    <Modal
      open
      onClose={onClose}
      title="Turn On Security"
      description="From now on everyone logs in with a username and password. You will be asked to log in right after this."
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="lock" loading={busy} shortcut="Ctrl+A" onClick={() => void submit()}>
            Turn on and log in
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void submit()} />
      <div ref={formRef}>
        <Stack gap={4}>
          {owners.length > 0 ? (
            <SegmentedControl<Mode>
              aria-label="Owner"
              value={mode}
              onChange={switchMode}
              options={[
                { value: 'existing', label: 'Use an existing Owner' },
                { value: 'new', label: 'Create a new Owner' },
              ]}
            />
          ) : null}
          {mode === 'existing' ? (
            <>
              <Field label="Owner" required error={errors.username} hint="This Owner already exists from an earlier time security was on.">
                <Select value={username} onChange={setUsername} options={ownerOptions} data-autofocus="" />
              </Field>
              <Field label="Their password" required error={errors.password}>
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            </>
          ) : (
            <>
              <Stack gap={3}>
                <Field label="Owner username" required error={errors.username} hint="The Owner can do everything, including managing users and turning security off.">
                  <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus="" />
                </Field>
                <Field label="Full name" optional>
                  <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username || 'e.g. Rakesh Mehta'} />
                </Field>
                <Field label="Password" required error={errors.password}>
                  <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                </Field>
                <PasswordChecklist policy={policy} password={password} username={username} showHistory={false} />
                <Field label="Type it again" required error={errors.confirm}>
                  <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                </Field>
              </Stack>
              <Banner tone="warning" inline title="Keep this password safe">
                Bahi ERP cannot recover a forgotten Owner password. Write it down and keep it somewhere safe, or add a second Owner later.
              </Banner>
            </>
          )}
          {error ? (
            <Banner tone="danger" title="Security was not turned on">
              {error}
            </Banner>
          ) : null}
        </Stack>
      </div>
    </Modal>
  );
}

export function DisableSecurityDialog({ username, onClose }: { username: string; onClose: () => void }) {
  const app = useAppState();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!password) {
      setFieldError('Enter your password to confirm');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('security.disable', { password });
      invalidate();
      toast.success('Security is off', { message: 'Anyone who opens this company now has full access. Users and roles are kept.' });
      onClose();
      await app.refresh();
    } catch (err) {
      const f = fieldErrorsOf(err);
      // Wrong passwords count as failed logins: clear the field so it is typed again deliberately.
      setPassword('');
      if (f.password) setFieldError(f.password);
      else setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });

  return (
    <Modal
      open
      onClose={onClose}
      role="alertdialog"
      title="Turn Off Security?"
      description="Anyone who opens this company will have full access without a password."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Keep security on</Button>
          <Button variant="danger" icon="unlock" loading={busy} shortcut="Ctrl+A" onClick={() => void submit()}>
            Turn off
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void submit()} />
      <div ref={formRef}>
        <Stack gap={3}>
          <ul className="bx-sec-tips">
            <li>Users, roles and the edit log are kept and apply again when you turn security back on.</li>
            <li>Changes are still recorded in the edit log, but under the name “owner”.</li>
          </ul>
          <Field label={`Password of “${username}”`} required error={fieldError}>
            <PasswordInput
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setFieldError(null);
              }}
              autoComplete="current-password"
              data-autofocus=""
            />
          </Field>
          {error ? (
            <Banner tone="danger" title="Security is still on">
              {error}
            </Banner>
          ) : null}
        </Stack>
      </div>
    </Modal>
  );
}
