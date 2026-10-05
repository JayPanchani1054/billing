/**
 * Login to a password-protected company (company is open, waiting for a user).
 */
import { useRef, useState } from 'react';
import { api } from '../../app/api.ts';
import { ApiError, userMessage } from '../../app/lib/apiErrors.ts';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, Field, PasswordInput, Stack, TextInput, useEnterAdvance } from '../../ui/index.ts';
import { GateLayout } from './GateLayout.tsx';

function lastUserKey(companyId: string): string {
  return `bahi.login.${companyId}`;
}

function readLastUser(companyId: string): string {
  try {
    return window.localStorage.getItem(lastUserKey(companyId)) ?? '';
  } catch {
    return '';
  }
}

function rememberUser(companyId: string, username: string): void {
  try {
    window.localStorage.setItem(lastUserKey(companyId), username);
  } catch {
    // not remembered
  }
}

export function LoginScreen() {
  const app = useAppState();
  const pending = app.state?.pendingLogin;
  const companyId = pending?.companyId ?? '';
  const [username, setUsername] = useState(() => readLastUser(companyId));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) {
      setError({ title: 'Enter your username and password', body: 'Both are needed to open this company.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api('app.auth.login', { username: username.trim(), password });
      rememberUser(companyId, username.trim());
      app.applyState(next);
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.code === 'LOCKED') setError({ title: 'Login is locked for now', body: err.message });
      else if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') setError({ title: 'That did not work', body: 'The username or password is incorrect. Passwords are case-sensitive.' });
      else setError({ title: 'Could not log in', body: userMessage(err) });
      requestAnimationFrame(() => passwordRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const otherCompany = async () => {
    try {
      app.applyState(await api('app.company.close'));
    } catch (err) {
      setError({ title: 'Could not close the company', body: userMessage(err) });
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });

  return (
    <GateLayout title={`Log in to ${pending?.companyName ?? 'company'}`} subtitle="This company is password protected." width="narrow">
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap={3}>
          <Field label="Username" required>
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus={!username} spellCheck={false} />
          </Field>
          <Field label="Password" required>
            <PasswordInput ref={passwordRef} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!username} />
          </Field>
          {error ? (
            <Banner tone="danger" title={error.title}>
              {error.body}
            </Banner>
          ) : null}
          <Button type="submit" variant="primary" loading={busy} fullWidth data-enter-target="">
            Log in
          </Button>
          <Button variant="link" onClick={() => void otherCompany()} disabled={busy}>
            Open a different company
          </Button>
        </Stack>
      </form>
    </GateLayout>
  );
}
