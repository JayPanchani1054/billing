/**
 * 'security.users' — Users & Roles workspace (tabs). Params: { tab?: 'users' | 'roles' }.
 *
 * Users: list with status (active / locked / must change / expired), last login; create/alter
 * (dialog screen 'security.user.form'), reset password, unlock, delete → "Deactivate instead".
 * Roles: list with user counts; create/alter/copy (screen 'security.role.form'), delete unused roles.
 * Actions the server would refuse (Owner accounts for non-Owners, users with stronger roles, yourself,
 * the only active Owner) are disabled with the reason as their hint (lib/access.ts).
 */
import { useMemo, useRef, useState } from 'react';
import type { SecurityRole, SecurityUser, UserDeleteRefusal } from '../../../shared/types/security.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { isApiError, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav, useScreenActions } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { Screen } from '../../app/Screen.tsx';
import { useAppState, useCan } from '../../app/state.tsx';
import { Badge, Banner, Button, Checkbox, DataTable, EmptyState, Inline, Stack, Tabs, TextInput, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { UserStatusBadges } from './components.tsx';
import { useNow } from './hooks.ts';
import { formatDateTime, relativeTime } from './lib/time.ts';
import { userActionBlock } from './lib/access.ts';
import type { UserAction } from './lib/access.ts';
import { auditHistoryParams } from './lib/auditQuery.ts';
import { lastLoginText, statusRank } from './lib/users.ts';
import { ResetPasswordDialog } from './ResetPasswordDialog.tsx';

type TabId = 'users' | 'roles';

export function UsersRolesScreen({ params }: ScreenProps<{ tab?: TabId }>) {
  const [tab, setTab] = useState<TabId>(params.tab === 'roles' ? 'roles' : 'users');
  const app = useAppState();
  const nav = useNav();
  const users = useApiQuery('security.user.list', {}, { keepPrevious: true });
  const roles = useApiQuery('security.role.list', {});
  const securityOn = app.company?.features.security ?? false;

  return (
    <Screen
      title="Users & Roles"
      subtitle="Who can open this company and what each person may do."
      icon="users"
      hint={tab === 'users' ? 'Enter Alter · Alt+C New user · Alt+R Reset password · Alt+U Unlock · Alt+V Deactivate · Alt+H History · Alt+2 Roles' : 'Enter Open · Alt+C New role · Alt+K Copy · Alt+D Delete · Alt+H History · Alt+1 Users'}
      actions={[
        { key: 'Alt+1', label: 'Users', icon: 'user', onClick: () => setTab('users'), group: 'view', disabled: tab === 'users' },
        { key: 'Alt+2', label: 'Roles', icon: 'shield', onClick: () => setTab('roles'), group: 'view', disabled: tab === 'roles' },
        { key: 'Alt+S', label: 'Security settings', icon: 'settings', onClick: () => nav.push('security.settings'), group: 'more' },
      ]}
    >
      <Stack gap={3}>
        {!securityOn ? (
          <Banner
            tone="info"
            title="Security is off"
            action={
              <Button size="sm" icon="lock" onClick={() => nav.push('security.settings')}>
                Turn on…
              </Button>
            }
          >
            Anyone who opens this company has full access. You can add users and roles now — they apply as soon as security is turned on.
          </Banner>
        ) : null}
        <Tabs
          aria-label="Users and roles"
          value={tab}
          onChange={(id) => setTab(id === 'roles' ? 'roles' : 'users')}
          items={[
            {
              id: 'users',
              label: 'Users',
              icon: 'user',
              badge: users.data ? <Badge size="sm">{users.data.total}</Badge> : undefined,
              content: <UsersTab />,
            },
            {
              id: 'roles',
              label: 'Roles',
              icon: 'shield',
              badge: roles.data ? <Badge size="sm">{roles.data.total}</Badge> : undefined,
              content: <RolesTab />,
            },
          ]}
        />
      </Stack>
    </Screen>
  );
}

// ───────────────────────────── Users ─────────────────────────────

function UsersTab() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow();
  const canAudit = useCan('audit.view');
  const session = useAppState().session;
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(true);
  const debounced = useDebouncedValue(search.trim(), 200);
  const q = useApiQuery('security.user.list', { search: debounced || undefined, activeOnly: showInactive ? undefined : true }, { keepPrevious: true });
  const rows = q.data?.rows ?? [];
  // Full lists (cached by the parent screen) for the "only Owner" and role-permission checks.
  const allUsers = useApiQuery('security.user.list', {}).data?.rows;
  const roles = useApiQuery('security.role.list', {}).data?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const selected = rows.find((r) => String(r.id) === cursor) ?? null;
  const [resetFor, setResetFor] = useState<SecurityUser | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);
  const block = (action: UserAction) => (selected ? userActionBlock(session, selected, action, roles, allUsers) : null);
  const resetBlock = block('resetPassword');
  const unlockBlock = block('unlock');
  const activeBlock = block(selected && !selected.isActive ? 'reactivate' : 'deactivate');
  const unlock = useApiMutation('security.user.unlock');
  const save = useApiMutation('security.user.save');

  const openForm = async (id?: number) => {
    const r = await nav.pushForResult<{ id: number }>('security.user.form', id === undefined ? {} : { id });
    if (r) setCursor(String(r.id));
  };

  const doUnlock = async (u: SecurityUser) => {
    try {
      await unlock.mutate({ id: u.id });
      toast.success(`“${u.username}” can log in again`, { message: 'The failed-attempt counter was reset.' });
    } catch (err) {
      toast.error('Could not unlock', { message: userMessage(err) });
    }
  };

  const setActive = async (u: SecurityUser, isActive: boolean) => {
    try {
      await save.mutate({ id: u.id, username: u.username, displayName: u.displayName, roleId: u.roleId, isActive });
      toast.success(isActive ? `“${u.username}” is active again` : `“${u.username}” is deactivated`, {
        message: isActive ? 'They can log in with their existing password.' : 'They can no longer log in. Their entries in the edit log are kept.',
      });
    } catch (err) {
      toast.error(isActive ? 'Could not reactivate' : 'Could not deactivate', { message: userMessage(err) });
    }
  };

  const confirmDeactivate = async (u: SecurityUser) => {
    const ok = await confirm({
      title: `Deactivate “${u.username}”?`,
      message: `${u.displayName} will no longer be able to log in. Their entries in the edit log are kept, and you can reactivate them at any time (Alt+V).`,
      confirmLabel: 'Deactivate',
      tone: 'danger',
    });
    if (ok) await setActive(u, false);
  };

  /** The server never deletes users; it explains why and we offer deactivation instead. */
  const doDelete = async (u: SecurityUser) => {
    try {
      await api('security.user.delete', { id: u.id });
    } catch (err) {
      const refusal = isApiError(err) && err.code === 'BUSINESS_RULE' ? (err.details as UserDeleteRefusal | undefined) : undefined;
      if (refusal?.suggestion === 'deactivate') {
        if (!refusal.isActive) {
          toast.info(`“${u.username}” is already deactivated`, { message: userMessage(err) });
          return;
        }
        const blocked = userActionBlock(session, u, 'deactivate', roles, allUsers);
        if (blocked) {
          toast.info('Users can’t be deleted', { message: `${userMessage(err)} ${blocked}` });
          return;
        }
        const ok = await confirm({
          title: `Users can’t be deleted — deactivate “${u.username}”?`,
          message: (
            <>
              {userMessage(err)} You can reactivate {u.displayName} at any time.
            </>
          ),
          confirmLabel: 'Deactivate instead',
          tone: 'danger',
        });
        if (ok) await setActive(u, false);
        return;
      }
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };

  useScreenActions([
    { key: 'Alt+C', label: 'New user', icon: 'plus', primary: true, onClick: () => void openForm() },
    { key: 'Alt+A', label: 'Alter user', icon: 'edit', onClick: () => selected && void openForm(selected.id), disabled: !selected },
    {
      key: 'Alt+R',
      label: 'Reset password',
      icon: 'key',
      onClick: () => selected && !resetBlock && setResetFor(selected),
      disabled: !selected || resetBlock !== null,
      hint: resetBlock ?? 'Set a new password for the selected user.',
    },
    {
      key: 'Alt+U',
      label: 'Unlock',
      icon: 'unlock',
      onClick: () => selected && !unlockBlock && void doUnlock(selected),
      disabled: !selected || unlockBlock !== null || (!selected.locked && selected.failedAttempts === 0),
      hint: unlockBlock ?? 'Clear a lockout after too many wrong passwords.',
    },
    selected && !selected.isActive
      ? {
          key: 'Alt+V',
          label: 'Reactivate',
          icon: 'check-circle',
          onClick: () => !activeBlock && void setActive(selected, true),
          disabled: activeBlock !== null,
          group: 'danger',
          hint: activeBlock ?? 'Let this user log in again with their existing password.',
        }
      : {
          key: 'Alt+V',
          label: 'Deactivate…',
          icon: 'x-circle',
          onClick: () => selected && !activeBlock && void confirmDeactivate(selected),
          disabled: !selected || activeBlock !== null,
          group: 'danger',
          hint: activeBlock ?? 'Stop this user from logging in. Their history is kept.',
        },
    {
      key: 'Alt+H',
      label: 'Edit history',
      icon: 'clock',
      onClick: () => selected && nav.push('security.audit', auditHistoryParams('user', selected.id, selected.username)),
      disabled: !selected,
      hidden: !canAudit,
      group: 'more',
      hint: 'Every change to this user, password resets and unlocks.',
    },
    { key: 'Alt+D', label: 'Delete…', icon: 'trash', onClick: () => selected && void doDelete(selected), disabled: !selected || selected.isSelf, group: 'danger', hint: 'Users are kept for the edit log — you will be offered to deactivate instead.' },
  ]);

  const columns = useMemo<Column<SecurityUser>[]>(
    () => [
      {
        key: 'username',
        header: 'User',
        minWidth: 180,
        sortable: true,
        value: (u) => u.username,
        render: (u) => (
          <span className="bx-sec-user">
            <span className="bx-sec-user__name">{u.displayName}</span>
            <span className="bx-sec-user__login">{u.username}</span>
          </span>
        ),
      },
      { key: 'roleName', header: 'Role', width: 150, sortable: true },
      {
        key: 'status',
        header: 'Status',
        minWidth: 220,
        sortable: true,
        sortValue: (u) => statusRank(u),
        value: (u) => (u.isActive ? (u.locked ? 'Locked' : 'Active') : 'Deactivated'),
        render: (u) => <UserStatusBadges user={u} now={now} />,
      },
      {
        key: 'lastLoginAt',
        header: 'Last login',
        width: 150,
        sortable: true,
        sortValue: (u) => u.lastLoginAt ?? '',
        value: (u) => lastLoginText(u, now),
        title: (u) => (u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Has not logged in yet'),
      },
      {
        key: 'password',
        header: 'Password',
        width: 170,
        value: (u) => (u.passwordExpiresAt ? (u.passwordExpired ? 'Expired' : `Expires ${relativeTime(u.passwordExpiresAt, now)}`) : `Set ${relativeTime(u.passwordChangedAt, now)}`),
        title: (u) => `Set on ${formatDateTime(u.passwordChangedAt)}${u.passwordExpiresAt ? `; expires ${formatDateTime(u.passwordExpiresAt)}` : ''}`,
      },
    ],
    [now],
  );

  return (
    <Stack gap={3}>
      <Inline gap={3} align="center">
        <div className="bx-sec-filters__search">
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // ↓ / Enter from the search box go to the list (keyboard-first).
              if ((e.key === 'ArrowDown' || e.key === 'Enter') && !e.altKey && !e.ctrlKey && !e.shiftKey) {
                e.preventDefault();
                gridRef.current?.focus();
              }
            }}
            leadingIcon="search"
            placeholder="Search users by name"
            aria-label="Search users"
          />
        </div>
        <Checkbox checked={showInactive} onChange={setShowInactive} label="Show deactivated users" />
      </Inline>
      {q.error ? (
        <Banner tone="danger" title="Users could not be loaded" action={<Button size="sm" onClick={() => void q.refetch()}>Try again</Button>}>
          {userMessage(q.error)}
        </Banner>
      ) : null}
      <div className="bx-sec-table">
        <DataTable<SecurityUser>
          aria-label="Users"
          autoFocus
          gridRef={gridRef}
          columns={columns}
          rows={rows}
          getRowKey={(u) => String(u.id)}
          selectedKey={cursor}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(u) => void openForm(u.id)}
          loading={q.loading}
          typeToJump={(u) => u.username}
          empty={
            <EmptyState
              icon="users"
              title={debounced ? 'No user matches your search' : 'No users yet'}
              body={debounced ? 'Check the spelling or clear the search.' : 'Press Alt+C to add the first user.'}
              action={debounced ? undefined : <Button icon="plus" onClick={() => void openForm()}>New user</Button>}
            />
          }
        />
      </div>
      {resetFor ? <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} /> : null}
    </Stack>
  );
}

// ───────────────────────────── Roles ─────────────────────────────

function RolesTab() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canAudit = useCan('audit.view');
  const q = useApiQuery('security.role.list', {});
  const rows = q.data?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const selected = rows.find((r) => String(r.id) === cursor) ?? null;
  const del = useApiMutation('security.role.delete');

  const open = async (roleParams: { id?: number; copyFrom?: number }) => {
    const r = await nav.pushForResult<{ id: number }>('security.role.form', roleParams);
    if (r) setCursor(String(r.id));
  };

  const doDelete = async (r: SecurityRole) => {
    if (r.isSystem) {
      toast.info(`“${r.name}” is a built-in role`, { message: 'Built-in roles cannot be deleted.' });
      return;
    }
    if (r.userCount > 0) {
      toast.warning(`“${r.name}” is in use`, { message: `It is assigned to ${r.userCount} user${r.userCount === 1 ? '' : 's'}. Move them to another role first.` });
      return;
    }
    if (!(await confirm({ title: `Delete the role “${r.name}”?`, message: 'No user has this role. The deletion is recorded in the edit log.', confirmLabel: 'Delete role', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: r.id });
      setCursor(null);
      toast.success(`Role “${r.name}” deleted`);
    } catch (err) {
      toast.error('Could not delete the role', { message: userMessage(err) });
    }
  };

  useScreenActions([
    { key: 'Alt+C', label: 'New role', icon: 'plus', primary: true, onClick: () => void open({}) },
    { key: 'Alt+A', label: selected?.isSystem ? 'View role' : 'Alter role', icon: selected?.isSystem ? 'eye' : 'edit', onClick: () => selected && void open({ id: selected.id }), disabled: !selected },
    { key: 'Alt+K', label: 'Copy as new role', icon: 'copy', onClick: () => selected && void open({ copyFrom: selected.id }), disabled: !selected, hint: 'Start a new role from the selected role’s permissions.' },
    {
      key: 'Alt+H',
      label: 'Edit history',
      icon: 'clock',
      onClick: () => selected && nav.push('security.audit', auditHistoryParams('role', selected.id, selected.name)),
      disabled: !selected,
      hidden: !canAudit,
      group: 'more',
      hint: 'Every change to this role’s permissions.',
    },
    {
      key: 'Alt+D',
      label: 'Delete role',
      icon: 'trash',
      onClick: () => selected && void doDelete(selected),
      disabled: !selected || selected.isSystem || selected.userCount > 0,
      group: 'danger',
      hint: 'Only custom roles that no user has can be deleted.',
    },
  ]);

  const columns = useMemo<Column<SecurityRole>[]>(
    () => [
      {
        key: 'name',
        header: 'Role',
        minWidth: 200,
        sortable: true,
        render: (r) => (
          <span className="bx-sec-badges">
            <span className="bx-sec-user__name">{r.name}</span>
            {r.isSystem ? (
              <Badge size="sm" tone="neutral" icon="lock">
                Built-in
              </Badge>
            ) : null}
            {r.isOwner ? (
              <Badge size="sm" tone="brand">
                Full access
              </Badge>
            ) : null}
          </span>
        ),
      },
      { key: 'description', header: 'Description', minWidth: 220, value: (r) => r.description ?? '' },
      { key: 'permissions', header: 'Permissions', width: 120, kind: 'number', value: (r) => r.permissions.length, render: (r) => (r.isOwner ? 'All' : String(r.permissions.length)) },
      {
        key: 'users',
        header: 'Users',
        width: 130,
        kind: 'number',
        sortable: true,
        value: (r) => r.userCount,
        render: (r) => (r.userCount === r.activeUserCount ? String(r.userCount) : `${r.activeUserCount} active / ${r.userCount}`),
      },
    ],
    [],
  );

  return (
    <Stack gap={3}>
      {q.error ? (
        <Banner tone="danger" title="Roles could not be loaded" action={<Button size="sm" onClick={() => void q.refetch()}>Try again</Button>}>
          {userMessage(q.error)}
        </Banner>
      ) : null}
      <div className="bx-sec-table">
        <DataTable<SecurityRole>
          aria-label="Roles"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          selectedKey={cursor}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => void open({ id: r.id })}
          loading={q.loading}
          empty={<EmptyState icon="shield" title="No roles" body="Press Alt+C to create one." />}
        />
      </div>
      <p className="bx-muted">Built-in roles cannot be changed — copy one (Alt+K) to make your own. Role changes apply to each user from their next login.</p>
    </Stack>
  );
}
