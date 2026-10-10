/**
 * 'company.about' — version and environment details; 'company.shortcuts' — full-page shortcuts.
 */
import { useEffect, useState } from 'react';
import type { NativeActions } from '../../../shared/bridge.ts';
import { native } from '../../app/bridge.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { ShortcutsTable, useShortcutRows } from '../../app/ShortcutsOverlay.tsx';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, Card, KeyValueList, Stack, TextInput } from '../../ui/index.ts';

type AppInfo = NativeActions['app.info']['out'];

export function AboutScreen() {
  const app = useAppState();
  const nav = useNav();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    native('app.info', undefined).then(
      (i) => alive && setInfo(i),
      (err: unknown) => alive && setError(userMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, []);

  const show = (path: string) => void native('shell.showItem', { path }).catch(() => undefined);
  const dataDir = app.state?.dataDir ?? '';

  return (
    <Screen
      title="About Pevqori"
      subtitle="Offline GST accounting, invoicing and inventory for Indian businesses."
      icon="info"
      width="form"
      actions={[{ key: 'F1', label: 'Shortcuts', icon: 'keyboard', onClick: () => nav.push('company.shortcuts') }]}
    >
      <Stack gap={4}>
        {error ? <Banner tone="warning">{error}</Banner> : null}
        <Card title="Version" headingLevel={2}>
          <KeyValueList
            items={[
              { key: 'v', label: 'Pevqori', value: info?.version ?? app.state?.appVersion ?? '' },
              { key: 'p', label: 'Windows build', value: info ? `${info.platform} ${info.arch}` : '' },
              { key: 'e', label: 'Electron', value: info?.electron ?? '' },
              { key: 'c', label: 'Chromium', value: info?.chrome ?? '' },
              { key: 'n', label: 'Node.js', value: info?.node ?? '' },
            ]}
          />
        </Card>
        <Card title="Where your data is" headingLevel={2}>
          <Stack gap={3}>
            <FolderRow label="Companies" path={dataDir} onShow={show} />
            {info ? <FolderRow label="Logs" path={info.logDir} onShow={show} /> : null}
          </Stack>
        </Card>
        <p className="bx-muted">Your data never leaves this computer unless you export or back it up yourself.</p>
      </Stack>
    </Screen>
  );
}

function FolderRow({ label, path, onShow }: { label: string; path: string; onShow: (p: string) => void }) {
  return (
    <div className="bx-folder-row">
      <span className="bx-folder-row__label">{label}</span>
      <code className="bx-folder-row__path bx-truncate" title={path}>
        {path}
      </code>
      <Button size="sm" variant="ghost" icon="external" onClick={() => onShow(path)}>
        Show in folder
      </Button>
    </div>
  );
}

export function ShortcutsScreen() {
  const [query, setQuery] = useState('');
  const rows = useShortcutRows();
  return (
    <Screen title="Keyboard Shortcuts" subtitle="Everything in Pevqori works from the keyboard." icon="keyboard" width="form">
      <Stack gap={4}>
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search shortcuts — e.g. sales, period, print" leadingIcon="search" aria-label="Search shortcuts" autoFocus />
        <ShortcutsTable rows={rows} query={query} />
      </Stack>
    </Screen>
  );
}
