/**
 * Small building blocks shared by the security screens: status badges, the live password checklist,
 * the field-level diff table, action badges and fingerprints.
 */
import { Fragment, useMemo } from 'react';
import type { PasswordPolicyInfo, SecurityUser, AuditFieldChange } from '../../../shared/types/security.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { Badge, Icon, IconButton, Tooltip, useToast } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';
import { actionLabel, actionTone, groupedHash } from './lib/auditQuery.ts';
import { diffRows, KIND_LABEL } from './lib/diffFormat.ts';
import type { FormattedValue } from './lib/diffFormat.ts';
import { checkPassword, historyNote } from './lib/passwordRules.ts';
import { userBadges } from './lib/users.ts';

/** The company's password policy (any logged-in user may read it). */
export function usePasswordPolicy(): PasswordPolicyInfo | null {
  const q = useApiQuery('security.passwordPolicy', {}, { staleTime: 60_000 });
  return q.data ?? null;
}

export function UserStatusBadges({ user, now }: { user: SecurityUser; now: Date }) {
  const badges = userBadges(user, now);
  return (
    <span className="bx-sec-badges">
      {badges.map((b) => (
        <Badge key={b.key} tone={b.tone} size="sm" title={b.title} dot={b.key === 'active' || b.key === 'inactive' || b.key === 'locked'}>
          {b.label}
        </Badge>
      ))}
    </span>
  );
}

/** Live checklist of the company's password rules (✓ met / ○ not yet). */
export function PasswordChecklist({ policy, password, username, showHistory = true }: { policy: PasswordPolicyInfo | null; password: string; username: string; showHistory?: boolean }) {
  const checks = checkPassword(policy, password, username);
  const met = checks.filter((c) => c.ok).length;
  return (
    <div aria-live="polite">
      <ul className="bx-sec-rules" aria-label={`Password rules: ${met} of ${checks.length} met`}>
        {checks.map((c) => (
          <li key={c.id} className={cx('bx-sec-rules__item', c.ok && 'is-ok')}>
            <Icon name={c.ok ? 'check-circle' : 'dot'} size="xs" />
            <span>
              {c.label}
              <span className="bx-sr-only">{c.ok ? ' (met)' : ' (not yet)'}</span>
            </span>
          </li>
        ))}
      </ul>
      {showHistory ? <p className="bx-sec-rules__note">{historyNote(policy)}</p> : null}
    </div>
  );
}

export function ActionBadge({ action }: { action: string }) {
  return (
    <Badge tone={actionTone(action)} size="sm">
      {actionLabel(action)}
    </Badge>
  );
}

function DiffValue({ value, as }: { value: FormattedValue; as: 'del' | 'ins' | 'span' }) {
  const cls = cx('bx-sec-diff__value', value.style === 'json' && 'bx-sec-diff__value--json', value.style === 'empty' && 'bx-sec-diff__value--empty');
  const title = value.raw ?? undefined;
  if (value.style === 'empty') return <span className={cls} title={title}>{value.text}</span>;
  if (as === 'del')
    return (
      <del className={cls} title={title}>
        {value.text}
      </del>
    );
  if (as === 'ins')
    return (
      <ins className={cls} title={title}>
        {value.text}
      </ins>
    );
  return (
    <span className={cls} title={title}>
      {value.text}
    </span>
  );
}

/**
 * Field-level diff: Field | Before → After, with added (green, underlined) / removed (red, struck)
 * values. Long diffs are grouped under their top-level section.
 */
export function DiffTable({ changes, truncated = false, caption }: { changes: readonly AuditFieldChange[]; truncated?: boolean; caption?: string }) {
  const rows = useMemo(() => diffRows(changes), [changes]);
  const grouped = rows.length > 12;
  if (rows.length === 0) return <p className="bx-muted">No field-level changes were recorded for this entry.</p>;
  let lastSection = '';
  return (
    <table className="bx-sec-diff">
      {caption ? <caption className="bx-sr-only">{caption}</caption> : null}
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Before</th>
          <th scope="col" className="bx-sec-diff__arrow" aria-label="becomes" />
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const header = grouped && r.section !== lastSection;
          lastSection = r.section;
          return (
            <Fragment key={r.key}>
              {header ? (
                <tr className="bx-sec-diff__section">
                  <td colSpan={4}>{r.section}</td>
                </tr>
              ) : null}
              <tr className={`bx-sec-diff__row--${r.kind}`}>
                <td className="bx-sec-diff__field">
                  {r.label}
                  <span className="bx-sr-only"> — {KIND_LABEL[r.kind]}</span>
                </td>
                <td>{r.kind === 'added' ? <span className="bx-sec-diff__value bx-sec-diff__value--empty">—</span> : <DiffValue value={r.before} as={r.kind === 'removed' || r.kind === 'changed' ? 'del' : 'span'} />}</td>
                <td className="bx-sec-diff__arrow" aria-hidden="true">
                  →
                </td>
                <td>{r.kind === 'removed' ? <span className="bx-sec-diff__value bx-sec-diff__value--empty">removed</span> : <DiffValue value={r.after} as="ins" />}</td>
              </tr>
            </Fragment>
          );
        })}
        {truncated ? (
          <tr>
            <td colSpan={4} className="bx-muted">
              Only the first changes are shown. Open “Raw data” to see everything that was recorded.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

/** A SHA-256 fingerprint in groups, selectable, with a copy button. */
export function Fingerprint({ hash, groups = 8, label = 'fingerprint' }: { hash: string | null; groups?: number; label?: string }) {
  const toast = useToast();
  if (!hash) return <span className="bx-muted">—</span>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      toast.success('Copied', { message: `The full ${label} is on the clipboard.` });
    } catch {
      toast.error('Could not copy', { message: 'Select the text and copy it with Ctrl+C.' });
    }
  };
  return (
    <span className="bx-sec-badges">
      <Tooltip content={hash}>
        <span className="bx-sec-hash" tabIndex={0} aria-label={`${label} ${hash}`}>
          {groupedHash(hash, groups)}
          {hash.length > groups * 8 ? ' …' : ''}
        </span>
      </Tooltip>
      <IconButton icon="copy" size="sm" aria-label={`Copy ${label}`} onClick={() => void copy()} />
    </span>
  );
}
