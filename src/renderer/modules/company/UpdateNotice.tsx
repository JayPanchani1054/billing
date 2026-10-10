/**
 * Home notice (ModuleDef.gatewayNotices) for in-app updates: "Pevqori 2.1.0 is ready — Restart to update"
 * once a downloaded update is verified, or "Pevqori 2.1.0 is available" after a check found one. No hotkeys;
 * dismissible per version (localStorage, the notice simply returns when storage is unavailable). Renders
 * nothing while updates are off (test runs, unpackaged app, administrator policy) or up to date.
 */
import { useState } from 'react';
import { useAppState, useNav, userMessage } from '../../app/index.ts';
import { Banner, Button, useToast } from '../../ui/index.ts';
import { dismissKey, noticeFor, NOTICE_DISMISSED_KEY } from './lib/updateView.ts';
import { readStored, restartToUpdate, useUpdateStatus, writeStored } from './UpdatesPanel.tsx';

export function UpdateNotice() {
  const app = useAppState();
  const nav = useNav();
  const toast = useToast();
  const { status, setStatus } = useUpdateStatus();
  const [dismissed, setDismissed] = useState(() => readStored(NOTICE_DISMISSED_KEY));
  const [busy, setBusy] = useState(false);
  const notice = noticeFor(status, dismissed);
  if (!notice) return null;
  const canBackup = app.company !== null && app.can('data.backup');

  const restart = async () => {
    if (busy) return;
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
      tone={notice.ready ? 'success' : 'info'}
      icon="download"
      title={notice.title}
      onDismiss={() => {
        const key = dismissKey(notice);
        writeStored(NOTICE_DISMISSED_KEY, key);
        setDismissed(key);
      }}
      action={
        notice.ready ? (
          <Button size="sm" variant="primary" loading={busy} onClick={() => void restart()}>
            Restart to update
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => nav.push('company.about')}>
            See what's new
          </Button>
        )
      }
    >
      {notice.ready
        ? `Takes about a minute. Your companies and settings are kept${canBackup ? ', and the open company is backed up first' : ''}.`
        : 'Open About Pevqori to read what is new and download it.'}
    </Banner>
  );
}
