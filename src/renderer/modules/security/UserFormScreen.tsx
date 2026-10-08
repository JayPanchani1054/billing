/**
 * 'security.user.form' (dialog) — create or alter a user. Params: { id?: number }.
 * Returns { id, username } to a pushForResult caller.
 */
import { useMemo, useState } from 'react';
import type { SecurityRole, SecurityUser } from '../../../shared/types/security.ts';
import { DISPLAY_NAME_MAX_LENGTH, USERNAME_MAX_LENGTH } from '../../../shared/types/security.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, isApiError, userMessage } from '../../app/lib/apiErrors.ts';
import { DialogScreen, useDirty, useNav, useScreenResult } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ScreenError, ScreenSkeleton } from '../../app/Screen.tsx';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, Field, FieldGroup, PasswordInput, Select, Stack, Switch, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { PasswordChecklist, UserStatusBadges, usePasswordPolicy } from './components.tsx';
import { useNow } from './hooks.ts';
import { otherActiveOwners, roleAssignBlock, userActionBlock } from './lib/access.ts';
import { draftFromUser, emptyUserDraft, isDraftDirty, roleOptionLabel, toSaveInput, userFormWarnings, validateUserDraft } from './lib/users.ts';
import type { UserDraft, UserDraftErrors } from './lib/users.ts';
import { AcceptKey } from './ResetPasswordDialog.tsx';

export function UserFormScreen({ params }: ScreenProps<{ id?: number }>) {
  const id = typeof params.id === 'number' ? params.id : undefined;
  const existing = useApiQuery('security.user.get', { id: id ?? 0 }, { enabled: id !== undefined, staleTime: 0 });
  const roles = useApiQuery('security.role.list', {});
  const users = useApiQuery('security.user.list', {});
  const nav = useNav();
  const title = id === undefined ? 'New User' : 'Alter User';
  const error = existing.error ?? roles.error ?? users.error;
  if (error || (id !== undefined && !existing.data) || !roles.data || !users.data) {
    return (
      <DialogScreen title={title} size="md" footer={<Button onClick={() => void nav.back()}>Close</Button>}>
        {error ? <ScreenError error={error} onRetry={() => void Promise.all([existing.error ? existing.refetch() : null, roles.error ? roles.refetch() : null, users.error ? users.refetch() : null])} /> : <ScreenSkeleton lines={5} />}
      </DialogScreen>
    );
  }
  const others = users.data.rows.filter((u) => u.id !== id).map((u) => u.username);
  return (
    <UserForm
      key={existing.data ? `${existing.data.id}:${existing.data.updatedAt}` : 'new'}
      title={title}
      user={existing.data ?? null}
      roles={roles.data.rows}
      allUsers={users.data.rows}
      otherNames={others}
    />
  );
}

function UserForm({
  title,
  user,
  roles,
  allUsers,
  otherNames,
}: {
  title: string;
  user: SecurityUser | null;
  roles: readonly SecurityRole[];
  allUsers: readonly SecurityUser[];
  otherNames: readonly string[];
}) {
  const nav = useNav();
  const toast = useToast();
  const now = useNow();
  const { returnResult } = useScreenResult<{ id: number; username: string }>();
  const policy = usePasswordPolicy();
  const session = useAppState().session;
  const save = useApiMutation('security.user.save');
  // Never pre-select a role the editor may not give (the server would refuse it).
  const assignable = roles.filter((r) => roleAssignBlock(session, r) === null);
  const defaultRole = assignable.find((r) => r.name === 'Data Entry') ?? assignable.find((r) => !r.isOwner) ?? assignable[0];
  const base = useMemo<UserDraft>(() => (user ? draftFromUser(user) : emptyUserDraft(defaultRole?.id ?? null)), [user, defaultRole]);
  const [d, setD] = useState<UserDraft>(base);
  const [errors, setErrors] = useState<UserDraftErrors>({});
  const [error, setError] = useState<string | null>(null);
  const self = user?.isSelf ?? false;
  const creating = user === null;
  /** Why this account cannot be changed by the current user at all (read-only form). */
  const lockedReason = user ? userActionBlock(session, user, 'alter', roles) : null;
  /** The only active Owner cannot be deactivated or moved to another role. */
  const onlyOwner = !!user && user.isOwner && user.isActive && otherActiveOwners(allUsers, user.id) === 0;
  const dirty = isDraftDirty(d, base);
  useDirty(dirty);

  const set = <K extends keyof UserDraft>(k: K, v: UserDraft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async () => {
    if (save.pending || lockedReason) return;
    if (!creating && !dirty) {
      nav.pop();
      return;
    }
    const e = validateUserDraft(d, policy, otherNames);
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    setError(null);
    try {
      const out = await save.mutate(toSaveInput(d));
      toast.success(creating ? `User “${out.username}” created` : `User “${out.username}” saved`, {
        message: creating && out.mustChangePassword ? 'Give them the password in person; they will choose their own at the first login.' : undefined,
      });
      returnResult({ id: out.id, username: out.username });
    } catch (err) {
      const f = fieldErrorsOf(err);
      const mapped: UserDraftErrors = { username: f.username, displayName: f.displayName, roleId: f.roleId, password: f.password };
      if (Object.values(mapped).some(Boolean)) setErrors(mapped);
      else if (isApiError(err) && err.code === 'CONFLICT') setErrors({ username: userMessage(err) });
      else setError(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const role = roles.find((r) => r.id === d.roleId) ?? null;
  const warnings = userFormWarnings(d, user, roles);
  const roleOptions = roles.map((r) => {
    const blocked = r.id !== user?.roleId && roleAssignBlock(session, r) !== null;
    return { value: String(r.id), label: blocked ? `${roleOptionLabel(r)} (not yours to give)` : roleOptionLabel(r), disabled: blocked };
  });
  const roleHint = self
    ? 'You cannot change your own role — ask another Owner.'
    : onlyOwner
      ? 'The only active Owner must stay an Owner. Make another user an Owner first.'
      : role
        ? (role.description ?? undefined)
        : 'What this user may do.';

  return (
    <DialogScreen
      title={user ? `${title} — ${user.username}` : title}
      description={creating ? 'The new user logs in with this username and password.' : undefined}
      size="md"
      footerStart={user ? <UserStatusBadges user={user} now={now} /> : undefined}
      footer={
        <>
          <Button onClick={() => void nav.back()} data-autofocus={lockedReason ? '' : undefined}>
            {lockedReason ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" icon="save" loading={save.pending} disabled={lockedReason !== null} shortcut="Ctrl+A" onClick={() => void submit()}>
            {creating ? 'Create user' : 'Save'}
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void submit()} />
      <div ref={formRef}>
        <Stack gap={4}>
          {lockedReason ? (
            <Banner tone="info" inline title="You can look, but not change this account">
              {lockedReason}
            </Banner>
          ) : null}
          {error ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : null}
          <fieldset className="bx-sec-fieldset" disabled={lockedReason !== null}>
            <Stack gap={4}>
              <FieldGroup columns={2}>
                <Field label="Username" required error={errors.username} hint="Used to log in. Not case-sensitive.">
                  <TextInput value={d.username} onChange={(e) => set('username', e.target.value)} maxLength={USERNAME_MAX_LENGTH} autoComplete="off" spellCheck={false} data-autofocus={lockedReason ? undefined : ''} />
                </Field>
                <Field label="Full name" optional error={errors.displayName} hint="Shown in the edit log and menus.">
                  <TextInput value={d.displayName} onChange={(e) => set('displayName', e.target.value)} maxLength={DISPLAY_NAME_MAX_LENGTH} placeholder={d.username || 'e.g. Ravi Kumar'} />
                </Field>
              </FieldGroup>
              <Field label="Role" required error={errors.roleId} hint={roleHint}>
                <Select value={d.roleId === null ? '' : String(d.roleId)} onChange={(v) => set('roleId', Number(v))} options={roleOptions} placeholder="Choose a role" disabled={self || onlyOwner} />
              </Field>
              <Switch
                checked={d.isActive}
                onChange={(v) => set('isActive', v)}
                disabled={self || (onlyOwner && d.isActive)}
                label={d.isActive ? 'Active — can log in' : 'Deactivated — cannot log in'}
                onText="Active"
                offText="Off"
              />
              {self ? (
                <Banner tone="info" inline title="This is you">
                  Change your own password with Change Password (it asks for your current password).
                </Banner>
              ) : (
                <FieldGroup legend={creating ? 'Password' : 'Set a new password (optional)'} description={creating ? undefined : 'Leave blank to keep the current password.'}>
                  <Stack gap={3}>
                    <FieldGroup columns={2}>
                      <Field label={creating ? 'Password' : 'New password'} required={creating} error={errors.password}>
                        <PasswordInput value={d.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
                      </Field>
                      <Field label="Type it again" required={creating || d.password !== ''} error={errors.confirm}>
                        <PasswordInput value={d.confirm} onChange={(e) => set('confirm', e.target.value)} autoComplete="new-password" />
                      </Field>
                    </FieldGroup>
                    {creating || d.password !== '' ? <PasswordChecklist policy={policy} password={d.password} username={d.username} showHistory={!creating} /> : null}
                  </Stack>
                </FieldGroup>
              )}
              {!self ? (
                <Switch checked={d.mustChangePassword} onChange={(v) => set('mustChangePassword', v)} label="Ask to choose a new password at the next login" />
              ) : null}
            </Stack>
          </fieldset>
          {warnings.length ? (
            <Banner tone="warning" inline title="Please note">
              {warnings.join(' ')}
            </Banner>
          ) : null}
        </Stack>
      </div>
    </DialogScreen>
  );
}
