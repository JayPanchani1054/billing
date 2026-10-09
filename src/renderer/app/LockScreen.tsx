/**
 * Lock screen (phase 'locked'): the idle timeout ended the session of a secured company. The
 * workspace stays mounted underneath — hidden and inert (App.tsx) — so nothing on it can be read,
 * and logging in again as the same user resumes exactly where they left off, unsaved entries
 * included. Someone else logging in gets a fresh workspace; closing the company discards it.
 * Covers everything (dialogs and toasts included) and fences every hotkey while shown.
 */
import { useRef, useState } from 'react';
import { GateLayout } from '../modules/company/GateLayout.tsx';
import { Banner, Button, Field, HotkeyScope, PasswordInput, Stack, TextInput, useEnterAdvance } from '../ui/index.ts';
import { useFocusTrap } from '../ui/hooks/useFocusTrap.ts';
import { api } from './api.ts';
import { ApiError, userMessage } from './lib/apiErrors.ts';
import { lockReasonText } from './lib/sessionLock.ts';
import { useAppState } from './state.tsx';

export function LockScreen() {
  const app = useAppState();
  const locked = app.session;
  const companyName = app.company?.name ?? app.state?.pendingLogin?.companyName ?? 'company';
  const [username, setUsername] = useState(locked?.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The topmost focus trap: a dialog left open in the hidden workspace cannot pull focus back.
  useFocusTrap(rootRef, { active: true, initialFocus: 'none', restoreFocus: false });
  const otherUser = !!locked && username.trim() !== '' && username.trim().toLowerCase() !== locked.username.toLowerCase();

  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) {
      setError({ title: 'Enter your username and password', body: 'Both are needed to unlock.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api('app.auth.login', { username: username.trim(), password });
      app.applyState(next); // same user → the workspace resumes; anyone else → a fresh one
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.code === 'LOCKED') setError({ title: 'Login is locked for now', body: err.message });
      else if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') setError({ title: 'That did not work', body: 'The username or password is incorrect. Passwords are case-sensitive.' });
      else setError({ title: 'Could not unlock', body: userMessage(err) });
      requestAnimationFrame(() => passwordRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const closeCompany = async () => {
    try {
      app.applyState(await api('app.company.close'));
    } catch (err) {
      setError({ title: 'Could not close the company', body: userMessage(err) });
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });

  return (
    <div ref={rootRef} className="bx-lock" role="dialog" aria-modal="true" aria-labelledby="bx-lock-title" data-bx-overlay="">
      {/* A blocking hotkey layer: no global or screen key reaches the hidden workspace. */}
      <HotkeyScope blocking>
        <GateLayout title={`${companyName} is locked`} subtitle={lockReasonText(locked?.idleTimeoutMs)} width="narrow" titleId="bx-lock-title">
          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Stack gap={3}>
              <p className="bx-lock__note">
                {locked
                  ? `Log in again as ${locked.displayName || locked.username} to continue where you left off — open screens and unsaved entries are kept.`
                  : 'Log in again to continue.'}
              </p>
              <Field label="Username" required>
                <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus={!username} spellCheck={false} />
              </Field>
              <Field label="Password" required>
                <PasswordInput ref={passwordRef} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!username} />
              </Field>
              {otherUser ? (
                <Banner tone="warning" title="Logging in as someone else">
                  The work left open by {locked?.displayName || locked?.username} is closed without saving.
                </Banner>
              ) : null}
              {error ? (
                <Banner tone="danger" title={error.title}>
                  {error.body}
                </Banner>
              ) : null}
              <Button type="submit" variant="primary" loading={busy} fullWidth>
                {otherUser ? 'Log in' : 'Unlock'}
              </Button>
              <Button variant="link" onClick={() => void closeCompany()} disabled={busy}>
                Close the company (unsaved entries are lost)
              </Button>
            </Stack>
          </form>
        </GateLayout>
      </HotkeyScope>
    </div>
  );
}
