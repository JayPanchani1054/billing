/**
 * 'security.role.form' — create, alter, view (built-in) or copy a role.
 * Params: { id?: number; copyFrom?: number }. Returns { id, name } to a pushForResult caller.
 *
 * Permissions are grouped with a tri-state group checkbox. Turning a permission on also turns on what
 * it needs ("Create vouchers" needs "View vouchers"); turning one off also turns off what depends on
 * it. Someone who is not an Owner can only grant permissions they hold.
 */
import { useMemo, useState } from 'react';
import type { Permission } from '../../../shared/constants.ts';
import type { PermissionCatalog, SecurityRole } from '../../../shared/types/security.ts';
import { ROLE_DESCRIPTION_MAX_LENGTH, ROLE_NAME_MAX_LENGTH } from '../../../shared/types/security.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { isApiError, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav, useScreenResult } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { Screen } from '../../app/Screen.tsx';
import { useAppState } from '../../app/state.tsx';
import { Badge, Banner, Button, Checkbox, Field, FieldGroup, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import { catalogIndex, grantableFor, groupState, permissionChanges, roleNameProblem, toggleGroup, toggleNote, togglePermission } from './lib/permissionTree.ts';
import type { ToggleResult } from './lib/permissionTree.ts';

interface RoleParams {
  id?: number;
  copyFrom?: number;
}

export function RoleFormScreen({ params }: ScreenProps<RoleParams>) {
  const id = typeof params.id === 'number' ? params.id : undefined;
  const copyFrom = typeof params.copyFrom === 'number' ? params.copyFrom : undefined;
  const sourceId = id ?? copyFrom;
  const source = useApiQuery('security.role.get', { id: sourceId ?? 0 }, { enabled: sourceId !== undefined, staleTime: 0 });
  const catalog = useApiQuery('security.permissions.catalog', {}, { staleTime: 300_000 });
  const roles = useApiQuery('security.role.list', {});
  const title = id !== undefined ? (source.data?.isSystem ? 'Role' : 'Alter Role') : 'New Role';
  const error = source.error ?? catalog.error ?? roles.error;
  const ready = (sourceId === undefined || source.data) && catalog.data && roles.data;
  if (error || !ready) {
    return <Screen title={title} icon="shield" width="form" loading={!error} error={error} onRetry={() => void (source.error ? source.refetch() : catalog.refetch())} />;
  }
  const others = (roles.data?.rows ?? []).filter((r) => r.id !== id).map((r) => r.name);
  return (
    <RoleForm
      key={source.data ? `${source.data.id}:${source.data.updatedAt}:${copyFrom ?? ''}` : 'new'}
      mode={id !== undefined ? (source.data?.isSystem ? 'view' : 'alter') : 'create'}
      source={source.data ?? null}
      copied={copyFrom !== undefined}
      catalog={catalog.data as PermissionCatalog}
      otherNames={others}
    />
  );
}

function RoleForm({
  mode,
  source,
  copied,
  catalog,
  otherNames,
}: {
  mode: 'create' | 'alter' | 'view';
  source: SecurityRole | null;
  copied: boolean;
  catalog: PermissionCatalog;
  otherNames: readonly string[];
}) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const app = useAppState();
  const { returnResult } = useScreenResult<{ id: number; name: string }>();
  const save = useApiMutation('security.role.save');
  const del = useApiMutation('security.role.delete');
  const readOnly = mode === 'view';
  const session = app.session;
  const grantable = useMemo(() => grantableFor(session?.isOwner ?? false, session?.permissions ?? []), [session]);
  const index = useMemo(() => catalogIndex(catalog), [catalog]);

  const baseName = mode === 'alter' ? (source?.name ?? '') : copied && source ? `${source.name} (copy)` : '';
  const baseDescription = mode === 'alter' ? (source?.description ?? '') : copied && source ? (source.description ?? '') : '';
  const basePerms = useMemo<readonly Permission[]>(() => (source && (mode !== 'create' || copied) ? source.permissions : []), [source, mode, copied]);
  const [name, setName] = useState(baseName);
  const [description, setDescription] = useState(baseDescription);
  // A copy keeps only what this user may grant (the server would refuse the rest).
  const dropped = mode === 'create' ? basePerms.filter((p) => !grantable(p)) : [];
  const [selected, setSelected] = useState<Set<Permission>>(() => new Set(mode === 'create' ? basePerms.filter(grantable) : basePerms));
  const [note, setNote] = useState<string | null>(() =>
    dropped.length ? `Left out because you do not have them yourself: ${dropped.map((p) => index.get(p)?.fullLabel ?? p).join(', ')}.` : null,
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedPerms = mode === 'alter' ? basePerms : [];
  const changes = permissionChanges(savedPerms, selected);
  const fromBase = permissionChanges(basePerms, selected);
  const dirty = !readOnly && (name !== baseName || description !== baseDescription || fromBase.added.length + fromBase.removed.length > 0);

  const apply = (r: ToggleResult) => {
    setSelected(r.next);
    setNote(toggleNote(index, r));
  };

  const submit = async () => {
    if (readOnly || save.pending) return;
    const problem = roleNameProblem(name, otherNames);
    setNameError(problem);
    if (problem) return;
    if (mode === 'alter' && !dirty) {
      nav.pop();
      return;
    }
    if (selected.size === 0 && !(await confirm({ title: 'Save a role without permissions?', message: 'Users with this role will only be able to log in and see their session.', confirmLabel: 'Save anyway' }))) return;
    setError(null);
    try {
      const out = await save.mutate({ id: mode === 'alter' ? source?.id : undefined, name: name.trim(), description: description.trim() || null, permissions: [...selected] });
      toast.success(mode === 'alter' ? `Role “${out.name}” saved` : `Role “${out.name}” created`, {
        message: mode === 'alter' && out.userCount > 0 ? `The change applies to its ${out.userCount} user${out.userCount === 1 ? '' : 's'} from their next login.` : undefined,
      });
      returnResult({ id: out.id, name: out.name });
    } catch (err) {
      if (isApiError(err) && (err.code === 'CONFLICT' || err.code === 'VALIDATION') && /name/i.test(err.message)) setNameError(userMessage(err));
      else setError(userMessage(err));
    }
  };

  const remove = async () => {
    if (!source || mode !== 'alter') return;
    if (source.userCount > 0) {
      setError(`“${source.name}” is assigned to ${source.userCount} user${source.userCount === 1 ? '' : 's'}. Move them to another role first.`);
      return;
    }
    if (!(await confirm({ title: `Delete the role “${source.name}”?`, message: 'No user has this role. The deletion is recorded in the edit log.', confirmLabel: 'Delete role', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: source.id });
      toast.success(`Role “${source.name}” deleted`);
      nav.pop();
    } catch (err) {
      setError(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const titleText = mode === 'view' ? `Role — ${source?.name ?? ''}` : mode === 'alter' ? `Alter Role — ${source?.name ?? ''}` : 'New Role';

  return (
    <Screen
      title={titleText}
      subtitle={readOnly ? 'Built-in roles are read-only. Copy it to make your own version.' : 'Tick what people with this role may do.'}
      icon="shield"
      width="form"
      dirty={dirty}
      meta={
        source && mode !== 'create' ? (
          <span className="bx-sec-badges">
            {source.isSystem ? (
              <Badge tone="neutral" icon="lock">
                Built-in
              </Badge>
            ) : null}
            <Badge tone="info">
              {source.userCount} user{source.userCount === 1 ? '' : 's'}
            </Badge>
          </span>
        ) : undefined
      }
      hint={readOnly ? 'Alt+K Copy as new role · Esc Back' : 'Tab / Enter Move · Space Tick · Ctrl+A Save · Esc Back'}
      actions={[
        { key: 'Ctrl+A', label: mode === 'create' ? 'Create role' : 'Save', icon: 'save', primary: true, onClick: () => void submit(), hidden: readOnly },
        { key: 'Alt+K', label: 'Copy as new role', icon: 'copy', onClick: () => source && nav.replace('security.role.form', { copyFrom: source.id }), hidden: !source || mode === 'create' },
        { key: 'Alt+D', label: 'Delete role', icon: 'trash', onClick: () => void remove(), hidden: mode !== 'alter', disabled: (source?.userCount ?? 0) > 0, group: 'danger', hint: 'Only roles that no user has can be deleted.' },
      ]}
      footer={
        readOnly ? undefined : (
          <>
            <span className="bx-muted">
              {mode === 'alter' && (changes.added.length || changes.removed.length)
                ? `${changes.added.length} added · ${changes.removed.length} removed`
                : `${selected.size} permission${selected.size === 1 ? '' : 's'} ticked`}
            </span>
            <Button onClick={() => void nav.back()}>Cancel</Button>
            <Button variant="primary" icon="save" loading={save.pending} shortcut="Ctrl+A" onClick={() => void submit()}>
              {mode === 'create' ? 'Create role' : 'Save'}
            </Button>
          </>
        )
      }
    >
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={5}>
          {error ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          ) : null}
          {source?.isOwner ? (
            <Banner tone="info" title="The Owner role always has every permission">
              It cannot be changed, so there is always someone who can manage users and security.
            </Banner>
          ) : null}
          {!readOnly && !session?.isOwner ? (
            <Banner tone="info" inline title="Limited by your own access">
              You can only tick permissions that you have yourself. Ask an Owner for the others.
            </Banner>
          ) : null}
          <FieldGroup columns={2}>
            <Field label="Role name" required error={nameError}>
              <TextInput
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
                maxLength={ROLE_NAME_MAX_LENGTH}
                readOnly={readOnly}
                data-autofocus=""
                placeholder="e.g. Billing Clerk"
              />
            </Field>
            <Field label="Description" optional>
              <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={ROLE_DESCRIPTION_MAX_LENGTH} readOnly={readOnly} placeholder="What this role is for" />
            </Field>
          </FieldGroup>
          {note ? (
            <Banner tone="info" inline onDismiss={() => setNote(null)}>
              {note}
            </Banner>
          ) : null}
          <div className="bx-sec-perms" role="group" aria-label="Permissions">
            {catalog.groups.map((g) => {
              const state = groupState(g, selected);
              const count = g.items.filter((i) => selected.has(i.permission)).length;
              return (
                <section key={g.key} className="bx-sec-perm-group" aria-label={g.label}>
                  <div className="bx-sec-perm-group__head">
                    <Checkbox
                      checked={state === 'all'}
                      indeterminate={state === 'some'}
                      disabled={readOnly}
                      onChange={() => apply(toggleGroup(selected, g, grantable))}
                      label={<strong>{g.label}</strong>}
                      aria-label={`${g.label}: all permissions`}
                    />
                    <span className="bx-sec-perm-group__count">
                      {count} of {g.items.length}
                    </span>
                  </div>
                  <div className="bx-sec-perm-list">
                    {g.items.map((item) => {
                      const on = selected.has(item.permission);
                      const blocked = !on && !grantable(item.permission);
                      const changed = mode === 'alter' && on !== savedPerms.includes(item.permission);
                      return (
                        <div key={item.permission} className={cx('bx-sec-perm-item', changed && 'is-changed')}>
                          <Checkbox
                            checked={on}
                            disabled={readOnly || blocked}
                            onChange={(v) => apply(togglePermission(selected, item.permission, v, grantable))}
                            label={item.label}
                            description={blocked ? 'You do not have this permission yourself, so you cannot grant it.' : item.description}
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </Stack>
      </form>
    </Screen>
  );
}
