/**
 * 'security.session' — My Session: who is logged in, their role and permissions, the automatic-logout
 * countdown, password age/expiry and the previous login (with failed attempts in between).
 * Open to every logged-in user (it only shows their own session).
 */
import { useEffect, useMemo, useState } from 'react';
import { Screen, useApiQuery, useNav, userMessage, useScreen, useShell } from '../../app/index.ts';
import { Badge, Banner, Button, Icon, KeyValueList, Panel, Skeleton, Stack } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import { useNow } from './hooks.ts';
import { idleDeadline, idleExplanation, idleLevel, passwordStatus, permissionCountText, permissionSummary, previousLoginStatus } from './lib/session.ts';
import type { PermissionSummaryGroup } from './lib/session.ts';
import { formatCountdown, formatDateTime, relativeTime } from './lib/time.ts';

/** Latest local key press / click (epoch ms) while this screen is mounted. */
function useLastActivity(): number | null {
  const [last, setLast] = useState<number | null>(null);
  useEffect(() => {
    let pending = 0;
    const onActivity = () => {
      const t = Date.now();
      // Re-render at most every 2 s however fast someone types.
      if (t - pending < 2_000) return;
      pending = t;
      setLast(t);
    };
    window.addEventListener('keydown', onActivity, true);
    window.addEventListener('pointerdown', onActivity, true);
    return () => {
      window.removeEventListener('keydown', onActivity, true);
      window.removeEventListener('pointerdown', onActivity, true);
    };
  }, []);
  return last;
}

export function SessionScreen() {
  const nav = useNav();
  const shell = useShell();
  const q = useApiQuery('security.mySession', {}, { staleTime: 0 });
  const catalog = useApiQuery('security.permissions.catalog', {}, { staleTime: 300_000 });
  // Tick every second only while the screen is showing (stacked screens stay mounted).
  const { visible } = useScreen();
  const now = useNow(visible ? 1_000 : 60_000);
  const lastActivity = useLastActivity();
  const s = q.data;

  const groups = useMemo(() => (s ? permissionSummary(catalog.data, s.permissions, s.isOwner) : []), [s, catalog.data]);
  const deadline = s ? idleDeadline(s, lastActivity) : null;
  const level = s ? idleLevel(deadline, s.idleTimeoutMinutes, now.getTime()) : 'none';
  const pwd = s ? passwordStatus(s, now) : null;
  const prev = s ? previousLoginStatus(s, now) : null;
  const canChangePassword = !!s && !s.implicit && s.securityEnabled;

  return (
    <Screen
      title="My Session"
      subtitle="Who is logged in, what you may do, and when you will be logged out."
      icon="user"
      width="form"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Alt+W Change password · Alt+L My activity · Alt+Q Log out · Esc Back"
      actions={[
        { key: 'Alt+W', label: 'Change password', icon: 'key', onClick: () => nav.push('company.changePassword'), hidden: !canChangePassword },
        {
          key: 'Alt+L',
          label: 'My activity',
          icon: 'book',
          onClick: () => s?.userId != null && nav.push('security.audit', { userId: s.userId }),
          hidden: !s?.canViewAudit || s.userId == null,
          hint: 'Your entries in the edit log.',
        },
        { key: 'Alt+U', label: 'Users & roles', icon: 'users', onClick: () => nav.push('security.users'), hidden: !s?.canManageSecurity, group: 'more' },
        { key: 'Alt+S', label: 'Security settings', icon: 'settings', onClick: () => nav.push('security.settings'), hidden: !s?.canManageSecurity, group: 'more' },
        { key: 'Alt+Q', label: 'Log out', icon: 'logout', onClick: () => void shell.logout(), hidden: !canChangePassword, group: 'danger' },
      ]}
    >
      {s ? (
        <Stack gap={5}>
          {s.implicit || !s.securityEnabled ? (
            <Banner tone="info" title="Security is off">
              Nobody logs in, so everyone who opens this company works as “{s.username}” with full access.
              {s.canManageSecurity ? ' Turn security on in Security Settings when more than one person uses this computer.' : ''}
            </Banner>
          ) : null}

          <Panel title="Logged in as" headingLevel={2}>
            <div className="bx-sec-state">
              <span className="bx-sec-state__icon is-on" aria-hidden="true">
                <Icon name="user" size="lg" />
              </span>
              <div className="bx-sec-state__body">
                <p className="bx-sec-state__title">
                  {s.displayName}{' '}
                  <span className="bx-sec-badges">
                    <Badge tone={s.isOwner ? 'brand' : 'neutral'} size="sm">
                      {s.role}
                    </Badge>
                    {s.implicit ? (
                      <Badge tone="neutral" size="sm">
                        No login
                      </Badge>
                    ) : null}
                  </span>
                </p>
                <KeyValueList
                  layout="inline"
                  labelWidth={150}
                  items={[
                    { key: 'username', label: 'Username', value: s.username },
                    { key: 'started', label: 'Session started', value: `${formatDateTime(s.startedAt)} (${relativeTime(s.startedAt, now)})` },
                    { key: 'previous', label: 'Previous login', value: prev ? <span className={toneClass(prev.tone)}>{prev.text}</span> : '—' },
                    { key: 'password', label: 'Password', value: pwd ? <span className={toneClass(pwd.tone)}>{pwd.text}</span> : '—' },
                  ]}
                />
              </div>
            </div>
          </Panel>

          {prev?.tone === 'warning' ? (
            <Banner tone="warning" title="Failed login attempts on your account">
              {prev.text}
            </Banner>
          ) : null}
          {pwd && (pwd.tone === 'warning' || pwd.tone === 'danger') ? (
            <Banner tone={pwd.tone} title="Your password needs changing" action={canChangePassword ? <Button size="sm" icon="key" shortcut="Alt+W" onClick={() => nav.push('company.changePassword')}>
                    Change password
                  </Button> : undefined}>
              {pwd.text}
            </Banner>
          ) : null}

          <Panel title="Automatic logout" headingLevel={2} description={idleExplanation(s)}>
            {deadline !== null ? (
              <div className="bx-sec-idle" role="timer" aria-live="off" aria-label={`Time left before automatic logout: ${formatCountdown(deadline - now.getTime())}`}>
                <span className={cx('bx-sec-countdown', level === 'low' && 'is-low', level === 'expired' && 'is-expired')}>{formatCountdown(deadline - now.getTime())}</span>
                <span className="bx-muted">
                  {level === 'expired'
                    ? 'The idle time is up — your next action will ask you to log in again.'
                    : `left if you stop now (about ${formatDateTime(new Date(deadline).toISOString())}). Any key press or click restarts it.`}
                </span>
              </div>
            ) : (
              <p className="bx-muted">{s.idleTimeoutMinutes <= 0 && s.securityEnabled && !s.implicit ? 'No automatic logout.' : 'Not applicable.'}</p>
            )}
          </Panel>

          <Panel
            title="What you may do"
            headingLevel={2}
            description={`${catalog.data || s.isOwner ? `${permissionCountText(groups, s.isOwner)}. ` : ''}Permissions come from your role and are fixed at login — after a change by the Owner, log out and in again.`}
          >
            {catalog.error ? (
              <Banner tone="danger" inline title="The permission list could not be loaded" action={<Button size="sm" onClick={() => void catalog.refetch()}>Try again</Button>}>
                {userMessage(catalog.error)}
              </Banner>
            ) : !catalog.data ? (
              <Skeleton lines={4} />
            ) : (
              <PermissionList groups={groups} />
            )}
          </Panel>
        </Stack>
      ) : null}
    </Screen>
  );
}

function toneClass(tone: string): string | undefined {
  return tone === 'warning' ? 'bx-sec-text--warning' : tone === 'danger' ? 'bx-sec-text--danger' : undefined;
}

function PermissionList({ groups }: { groups: readonly PermissionSummaryGroup[] }) {
  return (
    <div className="bx-sec-perms">
      {groups.map((g) => (
        <section key={g.key} className="bx-sec-perm-group" aria-label={`${g.label}: ${g.heldCount} of ${g.items.length}`}>
          <div className="bx-sec-perm-group__head">
            <strong>{g.label}</strong>
            <span className="bx-sec-perm-group__count">
              {g.heldCount} of {g.items.length}
            </span>
          </div>
          <ul className="bx-sec-perm-summary">
            {g.items.map((i) => (
              <li key={i.permission} className={cx('bx-sec-perm-summary__item', i.held && 'is-held')} title={i.description}>
                <Icon name={i.held ? 'check-circle' : 'x-circle'} size="xs" />
                <span>
                  {i.label}
                  <span className="bx-sr-only">{i.held ? ' — allowed' : ' — not allowed'}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
