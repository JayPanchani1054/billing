/**
 * 'security.settings' — company security on/off, automatic logout, password rules, lockout and
 * expiry, explained for small-business owners. Settings can be prepared while security is off; they
 * apply once it is on.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SecuritySettings, SecurityUser } from '../../../shared/types/security.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { useAppState, useCan } from '../../app/state.tsx';
import { Banner, Button, Callout, Field, Icon, Inline, NumberInput, Panel, Stack, Switch, useEnterAdvance, useToast } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import {
  changedKeys,
  describeExpiry,
  describeIdle,
  describeLockout,
  describeStrength,
  draftOf,
  IDLE_PRESETS,
  patchOf,
  recommendations,
  settingsErrors,
} from './lib/settingsForm.ts';
import type { SettingsDraft, SettingsErrors, SettingsKey } from './lib/settingsForm.ts';
import { formatMinutes } from './lib/time.ts';
import { DisableSecurityDialog, EnableSecurityDialog } from './SecurityToggleDialogs.tsx';

export function SecuritySettingsScreen() {
  const settings = useApiQuery('security.settings.get', {});
  const users = useApiQuery('security.user.list', {});
  if (!settings.data || !users.data)
    return (
      <Screen
        title="Security Settings"
        icon="shield"
        width="form"
        loading={!settings.error && !users.error}
        error={settings.error ?? users.error}
        onRetry={() => void (settings.error ? settings.refetch() : users.refetch())}
      />
    );
  return <SettingsForm key={JSON.stringify(settings.data)} saved={settings.data} users={users.data.rows} />;
}

function SettingsForm({ saved, users }: { saved: SecuritySettings; users: readonly SecurityUser[] }) {
  const app = useAppState();
  const nav = useNav();
  const toast = useToast();
  const save = useApiMutation('security.settings.save');
  const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(saved));
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'enable' | 'disable' | null>(null);
  const securityOn = app.company?.features.security ?? false;
  const canAudit = useCan('audit.view');
  const session = app.session;
  const canTurnOff = securityOn && !!session?.isOwner && !session.implicit;
  const changed = changedKeys(saved, draft);
  const dirty = changed.length > 0;
  const owners = useMemo(() => users.filter((u) => u.isOwner), [users]);
  const activeOwners = owners.filter((u) => u.isActive).length;
  const tips = recommendations(draft, { securityEnabled: securityOn, activeOwners });

  const set = <K extends SettingsKey>(k: K, v: SettingsDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async () => {
    if (!dirty || save.pending) return;
    const e = settingsErrors(draft);
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    setError(null);
    try {
      await save.mutate(patchOf(saved, draft));
      toast.success('Security settings saved', { message: securityOn ? 'New logins and password changes follow the new rules.' : 'They apply once security is turned on.' });
    } catch (err) {
      const f = fieldErrorsOf(err) as SettingsErrors;
      if (Object.keys(f).length) setErrors(f);
      else setError(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const isChanged = (k: SettingsKey) => changed.includes(k);

  return (
    <Screen
      title="Security Settings"
      subtitle="Passwords, automatic logout and protection against guessing."
      icon="shield"
      width="form"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Alt+U Users & roles · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !dirty },
        securityOn
          ? { key: 'Alt+O', label: 'Turn security off', icon: 'unlock', onClick: () => setDialog('disable'), disabled: !canTurnOff, hint: canTurnOff ? undefined : 'Only an Owner can turn security off.', group: 'state' }
          : { key: 'Alt+O', label: 'Turn security on', icon: 'lock', onClick: () => setDialog('enable'), group: 'state' },
        { key: 'Alt+U', label: 'Users & roles', icon: 'users', onClick: () => nav.push('security.users'), group: 'more' },
        { key: 'Alt+L', label: 'Edit log', icon: 'book', onClick: () => nav.push('security.audit'), hidden: !canAudit, group: 'more' },
      ]}
      footer={
        <>
          <Button onClick={() => void nav.back()}>Close</Button>
          <Button variant="primary" icon="save" disabled={!dirty} loading={save.pending} shortcut="Ctrl+A" onClick={() => void submit()}>
            Save {dirty ? `(${changed.length} change${changed.length === 1 ? '' : 's'})` : ''}
          </Button>
        </>
      }
    >
      <Stack gap={5}>
        <Panel title="Password protection" headingLevel={2}>
          <div className="bx-sec-state">
            <span className={cx('bx-sec-state__icon', securityOn && 'is-on')} aria-hidden="true">
              <Icon name={securityOn ? 'lock' : 'unlock'} size="lg" />
            </span>
            <div className="bx-sec-state__body">
              <p className="bx-sec-state__title">{securityOn ? 'Security is on' : 'Security is off'}</p>
              <p className="bx-sec-state__text">
                {securityOn
                  ? `Everyone logs in with their own username and password and sees only what their role allows. ${activeOwners} active Owner${activeOwners === 1 ? '' : 's'}.`
                  : 'Anyone who opens this company can see and change everything, and the edit log records all changes under “owner”. Turn security on when more than one person uses this computer.'}
              </p>
            </div>
            {securityOn ? (
              <Button icon="unlock" disabled={!canTurnOff} onClick={() => setDialog('disable')} shortcut="Alt+O">
                Turn off…
              </Button>
            ) : (
              <Button variant="primary" icon="lock" onClick={() => setDialog('enable')} shortcut="Alt+O">
                Turn on…
              </Button>
            )}
          </div>
        </Panel>

        {error ? (
          <Banner tone="danger" title="Settings were not saved" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        ) : null}

        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <Stack gap={5}>
            <Panel title="Automatic logout" headingLevel={2} description="Protects an unattended computer.">
              <SettingRow label="Log out after inactivity" explain={describeIdle(draft.idleTimeoutMinutes)} changed={isChanged('idleTimeoutMinutes')}>
                <Field label="Idle timeout in minutes" hideLabel error={errors.idleTimeoutMinutes} hint="0 = never; otherwise 5 to 240 minutes.">
                  <NumberInput value={draft.idleTimeoutMinutes} onChange={(v) => set('idleTimeoutMinutes', v)} min={0} max={240} step={5} suffix="minutes" grouping={false} />
                </Field>
                <Inline gap={1}>
                  {IDLE_PRESETS.map((m) => (
                    <Button key={m} size="sm" variant={draft.idleTimeoutMinutes === m ? 'secondary' : 'ghost'} aria-pressed={draft.idleTimeoutMinutes === m} onClick={() => set('idleTimeoutMinutes', m)}>
                      {m === 0 ? 'Never' : m < 60 ? `${m} min` : formatMinutes(m)}
                    </Button>
                  ))}
                </Inline>
              </SettingRow>
            </Panel>

            <Panel title="Password rules" headingLevel={2} description={describeStrength(draft)}>
              <SettingRow label="Minimum length" explain="Long passwords are the best protection. 10–12 characters is a good choice." changed={isChanged('passwordMinLength')}>
                <Field label="Minimum password length" hideLabel error={errors.passwordMinLength} hint="8 to 64 characters.">
                  <NumberInput value={draft.passwordMinLength} onChange={(v) => set('passwordMinLength', v)} min={8} max={64} step={1} suffix="characters" grouping={false} />
                </Field>
              </SettingRow>
              <SettingRow label="Upper- and lower-case letters" explain="For example “Mehta2026” rather than “mehta2026”." changed={isChanged('requireMixedCase')}>
                <Switch checked={draft.requireMixedCase ?? false} onChange={(v) => set('requireMixedCase', v)} aria-label="Require upper- and lower-case letters" />
              </SettingRow>
              <SettingRow label="A symbol" explain="At least one character such as @ # $ % &." changed={isChanged('requireSymbol')}>
                <Switch checked={draft.requireSymbol ?? false} onChange={(v) => set('requireSymbol', v)} aria-label="Require a symbol" />
              </SettingRow>
              <SettingRow label="Password expiry" explain={describeExpiry(draft.passwordExpiryDays)} changed={isChanged('passwordExpiryDays')}>
                <Field label="Password expiry in days" hideLabel error={errors.passwordExpiryDays} hint="0 = never; up to 365 days.">
                  <NumberInput value={draft.passwordExpiryDays} onChange={(v) => set('passwordExpiryDays', v)} min={0} max={365} step={30} suffix="days" grouping={false} />
                </Field>
              </SettingRow>
            </Panel>

            <Panel title="Wrong passwords" headingLevel={2} description={describeLockout(draft.lockoutThreshold, draft.lockoutMinutes)}>
              <SettingRow label="Lock the account after" explain="Stops someone from guessing passwords one after another." changed={isChanged('lockoutThreshold')}>
                <Field label="Failed attempts before locking" hideLabel error={errors.lockoutThreshold} hint="3 to 10 attempts in a row.">
                  <NumberInput value={draft.lockoutThreshold} onChange={(v) => set('lockoutThreshold', v)} min={3} max={10} step={1} suffix="wrong passwords" grouping={false} />
                </Field>
              </SettingRow>
              <SettingRow label="Keep it locked for" explain="An Owner can unlock it sooner from Users & Roles." changed={isChanged('lockoutMinutes')}>
                <Field label="Lockout duration in minutes" hideLabel error={errors.lockoutMinutes} hint="1 to 60 minutes.">
                  <NumberInput value={draft.lockoutMinutes} onChange={(v) => set('lockoutMinutes', v)} min={1} max={60} step={1} suffix="minutes" grouping={false} />
                </Field>
              </SettingRow>
            </Panel>
          </Stack>
        </form>

        {tips.length ? (
          <Callout tone="info" title="Recommendations">
            <ul className="bx-sec-tips">
              {tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
      </Stack>

      {dialog === 'enable' ? <EnableSecurityDialog owners={owners} onClose={() => setDialog(null)} /> : null}
      {dialog === 'disable' && session ? <DisableSecurityDialog username={session.username} onClose={() => setDialog(null)} /> : null}
    </Screen>
  );
}

function SettingRow({ label, explain, changed, children }: { label: string; explain: ReactNode; changed: boolean; children: ReactNode }) {
  return (
    <div className={cx('bx-sec-setting', changed && 'is-changed')}>
      <div>
        <div className="bx-sec-setting__label">{label}</div>
        <div className="bx-sec-setting__explain">{explain}</div>
      </div>
      <Stack gap={2}>{children}</Stack>
    </div>
  );
}
