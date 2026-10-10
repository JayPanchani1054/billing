/**
 * Change the data folder (company list → "Change…"): pick a folder, then move / copy / use.
 */
import { useState } from 'react';
import { api } from '../../app/api.ts';
import { native } from '../../app/bridge.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, Field, Modal, RadioGroup, Stack, TextInput, useHotkeys, useToast } from '../../ui/index.ts';

type Mode = 'move' | 'copy' | 'use';

const MODES: ReadonlyArray<{ value: Mode; label: string; description: string }> = [
  { value: 'move', label: 'Move my companies there', description: 'Your companies move to the new folder; the old folder is left empty.' },
  { value: 'copy', label: 'Copy my companies there', description: 'The new folder gets a copy; the old folder keeps its companies (you will work on the copy).' },
  { value: 'use', label: 'Use the companies already in that folder', description: 'Nothing is moved. Choose this when the folder already has Pevqori data.' },
];

export function DataFolderDialog({ onClose }: { onClose: () => void }) {
  const app = useAppState();
  const toast = useToast();
  const current = app.state?.dataDir ?? '';
  const hasCompanies = (app.state?.companies.length ?? 0) > 0;
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(hasCompanies ? 'move' : 'use');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    setError(null);
    try {
      const picked = await native('dialog.chooseFolder', { title: 'Choose the new data folder', defaultPath: current || undefined });
      if (picked) setPath(picked.path);
    } catch (err) {
      setError(userMessage(err));
    }
  };

  const apply = async () => {
    if (!path || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api('app.dataDir.set', { path, mode });
      app.applyState(next);
      toast.success('Data folder changed', { message: next.dataDir });
      onClose();
    } catch (err) {
      setError(fieldErrorsOf(err).path ?? userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissible={!busy}
      title="Change Data Folder"
      description="Where Pevqori keeps all companies on this computer."
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void apply()} loading={busy} disabled={!path} shortcut="Ctrl+A">
            {mode === 'move' ? 'Move data' : mode === 'copy' ? 'Copy data' : 'Use folder'}
          </Button>
        </>
      }
    >
      <DialogKeys onAccept={() => void apply()} />
      <Stack gap={4}>
        <Field label="Current folder">
          <TextInput value={current} readOnly mono />
        </Field>
        <Field label="New folder" required hint={path ? undefined : 'Choose a folder with the Browse button.'}>
          <TextInput
            value={path ?? ''}
            readOnly
            mono
            placeholder="No folder chosen"
            trailing={
              <Button size="sm" icon="folder" onClick={() => void browse()} data-autofocus="">
                Browse…
              </Button>
            }
          />
        </Field>
        <RadioGroup<Mode> label="What should happen to your companies?" options={hasCompanies ? MODES : MODES.filter((m) => m.value === 'use')} value={mode} onChange={setMode} />
        {mode !== 'use' ? (
          <Banner tone="info" inline>
            Close Pevqori on other computers that use this folder before continuing. Large data can take a minute.
          </Banner>
        ) : null}
        {error ? (
          <Banner tone="danger" title="The data folder was not changed">
            {error}
          </Banner>
        ) : null}
      </Stack>
    </Modal>
  );
}

function DialogKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
