/**
 * Home notice (ModuleDef.gatewayNotices) for in-app updates — ONE line (2.1): "Pevqori 2.1.1 is ready ·
 * Restart to update ×" once a downloaded update is verified, or "Pevqori 2.1.1 is available · See what's
 * new ×" after a check found one (the action is the link at the end of the line). "Restart to update" asks first (the reassurance — companies and settings
 * kept, the open company backed up first — is in that dialog). No hotkeys; dismissible per version
 * (localStorage, the notice simply returns when storage is unavailable). Renders nothing while updates are
 * off (test runs, unpackaged app, administrator policy) or up to date.
 */
import { useState } from 'react';
import { useAppState, useConfirm, useNav, userMessage } from '../../app/index.ts';
import { Banner, Button, useToast } from '../../ui/index.ts';
import { dismissKey, noticeFor, NOTICE_DISMISSED_KEY, restartConfirm } from './lib/updateView.ts';
import { readStored, restartToUpdate, useUpdateStatus, writeStored } from './UpdatesPanel.tsx';

export function UpdateNotice() {
  const app = useAppState();
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const { status, setStatus } = useUpdateStatus();
  const [dismissed, setDismissed] = useState(() => readStored(NOTICE_DISMISSED_KEY));
  const [busy, setBusy] = useState(false);
  const notice = noticeFor(status, dismissed);
  if (!notice) return null;
  const canBackup = app.company !== null && app.can('data.backup');

  const restart = async () => {
    if (busy || !(await confirm(restartConfirm(canBackup)))) return;
    setBusy(true);
    try {
      setStatus(await restartToUpdate({ backupFirst: canBackup }));
    } catch (err) {
      // The notice always backs up first; About Pevqori lets the user install without the backup.
      const reason = err instanceof Error && !('code' in err) ? err.message : userMessage(err);
      toast.error('The update was not installed', { message: canBackup ? `${reason.replace(/[.\s]*$/, '.')} You can also install it from About Pevqori without a backup.` : reason });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Banner
      tone="info"
      className="bx-gateway__try"
      title={notice.title}
      onDismiss={() => {
        const key = dismissKey(notice);
        writeStored(NOTICE_DISMISSED_KEY, key);
        setDismissed(key);
      }}
      action={
        <Button size="sm" variant="link" loading={busy} onClick={notice.ready ? () => void restart() : () => nav.push('company.about')}>
          {notice.action}
        </Button>
      }
    />
  );
}
