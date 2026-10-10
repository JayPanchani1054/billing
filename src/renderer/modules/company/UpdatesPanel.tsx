/**
 * About › Updates (2.0): check for a new version, download it, "Restart to update" / "Install when I quit",
 * the weekly-check switch and the release notes. Every rule (texts, which buttons) comes from the pure
 * view-model lib/updateView.ts; this file only renders it and calls the main process
 * (src/main/updates/service.ts, NativeActions 'updates.*'). The renderer never passes a URL, path or version.
 * No hotkeys: the panel is reached with the mouse or Tab from About Pevqori (Go To › About).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import type { UpdateStatus } from '../../../shared/bridge.ts';
import { api, hasBridge, native, onBridgeEvent, useAppState, userMessage } from '../../app/index.ts';
import { Banner, Button, Card, Checkbox, Inline, ProgressBar, ScrollArea, Stack, Switch, useToast } from '../../ui/index.ts';
import { ASKED_AUTOMATIC_KEY, shouldAskAutomatic, updateView } from './lib/updateView.ts';
import type { UpdateActionId } from './lib/updateView.ts';

export function readStored(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the question / notice simply shows again next time.
  }
}

/** The main process's update status, kept current through the 'update-status' bridge event. */
export function useUpdateStatus(): { status: UpdateStatus | null; setStatus: (s: UpdateStatus) => void; supported: boolean } {
  const supported = hasBridge();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!supported) return undefined;
    let alive = true;
    const off = onBridgeEvent('update-status', (s) => {
      if (alive) setStatus(s);
    });
    native('updates.status', undefined).then(
      (s) => {
        if (alive) setStatus(s);
      },
      () => undefined, // an older main process without updates: the panel stays hidden
    );
    return () => {
      alive = false;
      off();
    };
  }, [supported]);
  return { status, setStatus, supported };
}

/**
 * "Restart to update": optionally back up the open company to its default backup folder first (a failed
 * backup stops the install and says why), then ask main to quit and install. Main asks about unsaved work.
 */
export async function restartToUpdate(options: { backupFirst: boolean }): Promise<UpdateStatus> {
  if (options.backupFirst) {
    try {
      await api('data.backup.create', {});
    } catch (err) {
      throw new Error(`The backup did not finish, so the update was not installed: ${userMessage(err)}`);
    }
  }
  return native('updates.install', { when: 'now' });
}

export function UpdatesPanel() {
  const app = useAppState();
  const toast = useToast();
  const { status, setStatus, supported } = useUpdateStatus();
  const [running, setRunning] = useState<UpdateActionId | 'mode' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupFirst, setBackupFirst] = useState(true);
  const [asked, setAsked] = useState(() => readStored(ASKED_AUTOMATIC_KEY) === '1');
  const canBackup = app.company !== null && app.can('data.backup');
  const notesId = useId();
  const hintId = useId();

  const run = useCallback(
    async (id: UpdateActionId) => {
      if (running) return;
      setRunning(id);
      setError(null);
      try {
        let next: UpdateStatus;
        if (id === 'check') next = await native('updates.check', undefined);
        else if (id === 'download') next = await native('updates.download', undefined);
        else if (id === 'on-quit') next = await native('updates.install', { when: 'on-quit' });
        else next = await restartToUpdate({ backupFirst: backupFirst && canBackup });
        setStatus(next);
      } catch (err) {
        setError(err instanceof Error && !('code' in err) ? err.message : userMessage(err));
      } finally {
        setRunning(null);
      }
    },
    [running, backupFirst, canBackup, setStatus],
  );

  const setWeekly = async (weekly: boolean) => {
    if (running) return;
    setRunning('mode');
    setError(null);
    try {
      setStatus(await native('updates.setMode', { mode: weekly ? 'weekly' : 'manual' }));
      writeStored(ASKED_AUTOMATIC_KEY, '1');
      setAsked(true);
      if (weekly) toast.success('Pevqori will check for updates once a week');
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setRunning(null);
    }
  };

  if (!supported) return null;
  const view = updateView(status, new Date());
  const ready = status?.state === 'ready';

  return (
    <Card title="Updates" headingLevel={2}>
      <Stack gap={3}>
        {shouldAskAutomatic(status, asked) ? (
          <Banner
            tone="info"
            icon="refresh"
            title="Check for updates automatically once a week?"
            action={
              <Inline gap={2}>
                <Button size="sm" variant="primary" loading={running === 'mode'} onClick={() => void setWeekly(true)}>
                  Turn on
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    writeStored(ASKED_AUTOMATIC_KEY, '1');
                    setAsked(true);
                  }}
                >
                  Not now
                </Button>
              </Inline>
            }
          >
            Pevqori only contacts the update server when you allow it. No company data is ever sent.
          </Banner>
        ) : null}

        {view.tone === 'danger' ? (
          <Banner tone="danger">{view.headline}</Banner>
        ) : (
          <div role="status" aria-live="polite" aria-busy={view.busy || undefined}>
            <p>
              <strong>{view.headline}</strong>
            </p>
            {view.detail ? <p className="bx-muted">{view.detail}</p> : null}
            {view.lastChecked ? <p className="bx-muted">Last checked {view.lastChecked}.</p> : null}
          </div>
        )}

        {view.progress ? <ProgressBar value={view.progress.percent} label="Download progress" showValue valueText={view.progress.text} /> : null}

        {error ? <Banner tone="danger">{error}</Banner> : null}

        {ready && canBackup ? (
          <Checkbox label="Back up the open company first" description="Saved in its usual backup folder before Pevqori restarts." checked={backupFirst} onChange={setBackupFirst} />
        ) : null}

        {view.actions.length > 0 ? (
          <Inline gap={2}>
            {view.actions.map((a) => (
              <Button
                key={a.id}
                variant={a.primary ? 'primary' : 'secondary'}
                icon={a.id === 'download' ? 'download' : a.id === 'check' ? 'refresh' : undefined}
                loading={running === a.id}
                disabled={view.busy || (running !== null && running !== a.id)}
                onClick={() => void run(a.id)}
              >
                {a.label}
              </Button>
            ))}
          </Inline>
        ) : null}

        {view.notes ? (
          <div>
            <p id={notesId}>
              <strong>{view.notes.title}</strong>
            </p>
            {/* One named region (the scroll box, focusable when it overflows), not two with the same name. */}
            <ScrollArea maxHeight={220} aria-labelledby={notesId}>
              {view.notes.text.split('\n').map((line, i) => (line.trim() ? <p key={i}>{line}</p> : <br key={i} />))}
            </ScrollArea>
          </div>
        ) : null}

        {view.modeSwitch.visible ? (
          <Stack gap={1}>
            <Switch
              label="Check automatically once a week"
              checked={view.modeSwitch.checked}
              disabled={view.modeSwitch.disabled || running === 'mode'}
              aria-describedby={view.modeSwitch.hint ? hintId : undefined}
              onChange={(on) => void setWeekly(on)}
            />
            {view.modeSwitch.hint ? (
              <p id={hintId} className="bx-muted">
                {view.modeSwitch.hint}
              </p>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}
