/**
 * First run: explain where data lives and confirm (or choose) the data folder.
 */
import { useState } from 'react';
import { api } from '../../app/api.ts';
import { native } from '../../app/bridge.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, Icon, Kbd, Stack, useHotkeys } from '../../ui/index.ts';
import { GateLayout } from './GateLayout.tsx';

export function DataFolderSetup() {
  const app = useAppState();
  const current = app.state?.dataDir ?? '';
  const [busy, setBusy] = useState<'use' | 'choose' | 'existing' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyFolder = async (path: string, which: 'use' | 'choose' | 'existing') => {
    setBusy(which);
    setError(null);
    try {
      app.applyState(await api('app.dataDir.set', { path, mode: 'use' }));
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const choose = async (which: 'choose' | 'existing') => {
    setError(null);
    try {
      const picked = await native('dialog.chooseFolder', {
        title: which === 'existing' ? 'Choose the folder that has your Pevqori data' : 'Choose a folder for Pevqori data',
        defaultPath: current || undefined,
      });
      if (picked) await applyFolder(picked.path, which);
    } catch (err) {
      setError(userMessage(err));
    }
  };

  useHotkeys({ 'Ctrl+A': () => void applyFolder(current, 'use') }, [current]);

  return (
    <GateLayout
      title="Where should Pevqori keep your data?"
      subtitle="All your companies are saved in one folder on this computer. You can change it later."
      footer={<span>Version {app.state?.appVersion}</span>}
    >
      <Stack gap={4}>
        <div className="bx-folder-box">
          <Icon name="folder" size="lg" className="bx-folder-box__icon" />
          <div className="bx-folder-box__text">
            <span className="bx-folder-box__label">Suggested folder</span>
            <code className="bx-folder-box__path">{current}</code>
          </div>
        </div>
        <ul className="bx-tips">
          <li>Pick a folder that is included in your backups.</li>
          <li>If you can, avoid the C: drive where Windows is installed — a Windows reinstall can wipe it.</li>
          <li>Pevqori also makes its own encrypted backups; you can choose where in Configuration (F12) › Backup.</li>
        </ul>
        {error ? (
          <Banner tone="danger" title="That folder can't be used">
            {error}
          </Banner>
        ) : null}
        <div className="bx-gate__actions">
          <Button variant="primary" icon="check" loading={busy === 'use'} disabled={busy !== null} onClick={() => void applyFolder(current, 'use')} autoFocus shortcut="Ctrl+A">
            Use this folder
          </Button>
          <Button icon="folder" loading={busy === 'choose'} disabled={busy !== null} onClick={() => void choose('choose')}>
            Choose another folder…
          </Button>
        </div>
        <div className="bx-gate__secondary">
          <Button variant="link" disabled={busy !== null} onClick={() => void choose('existing')}>
            I already have Pevqori data elsewhere
          </Button>
          <span className="bx-muted">
            {' '}
            — for example after moving to a new computer. <Kbd keys="Tab" size="sm" tone="subtle" /> to reach it.
          </span>
        </div>
      </Stack>
    </GateLayout>
  );
}
