/**
 * Delete a company (moved to the trash folder inside the data folder): typed-name confirmation
 * and, for a password-protected company, the owner's credentials.
 */
import { useId, useRef, useState } from 'react';
import { api } from '../../app/api.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import type { CompanyListItem } from '../../../shared/types/app.ts';
import { Banner, Button, Field, Modal, PasswordInput, Stack, TextInput, useEnterAdvance, useHotkeys } from '../../ui/index.ts';

export function DeleteCompanyDialog({ company, onClose, onDeleted }: { company: CompanyListItem; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const matches = typed.trim() === company.name.trim();
  const ready = matches && (!company.securityEnabled || password !== '') && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      await api('app.company.delete', {
        id: company.id,
        confirmName: typed.trim(),
        username: company.securityEnabled && username.trim() ? username.trim() : undefined,
        password: company.securityEnabled ? password : undefined,
      });
      onDeleted();
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors(f);
      if (Object.keys(f).length === 0) setError(userMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissible={!busy}
      role="alertdialog"
      title={`Delete ${company.name}?`}
      description="The company disappears from this list. Its file is moved to the trash folder inside your data folder, not erased."
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep company
          </Button>
          <Button variant="danger" icon="trash" loading={busy} disabled={!ready} onClick={() => void submit()} shortcut="Ctrl+A">
            Delete company
          </Button>
        </>
      }
    >
      <DeleteKeys onAccept={() => void submit()} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label={`Type “${company.name}” to confirm`} required error={errors.confirmName} hint={<span id={hintId}>This makes sure the right company is deleted.</span>}>
            <TextInput ref={inputRef} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} invalid={typed !== '' && !matches} />
          </Field>
          {company.securityEnabled ? (
            <>
              <Field label="Owner username" optional hint="Leave empty to accept any owner of this company.">
                <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
              </Field>
              <Field label="Owner password" required error={errors.password}>
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            </>
          ) : null}
          {error ? (
            <Banner tone="danger" title="The company was not deleted">
              {error}
            </Banner>
          ) : null}
        </Stack>
      </div>
    </Modal>
  );
}

function DeleteKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
