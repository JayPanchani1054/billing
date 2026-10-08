/**
 * Dialogs of the reconciliation screen: tolerance settings (run) and the supplier follow-up e-mail.
 */
import { useRef, useState } from 'react';
import type { ReconSource, ReconTolerance } from '../../../shared/types/gstrecon.ts';
import { DEFAULT_RECON_TOLERANCE } from '../../../shared/types/gstrecon.ts';
import { native, useApiQuery, userMessage } from '../../app/index.ts';
import { AmountInput, Banner, Button, Field, Modal, NumberInput, Spinner, Stack, Switch, TextArea, TextInput, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import { mailtoUrl, partyWord, toleranceErrors, toleranceFromDraft } from './lib/recon.ts';
import type { ToleranceDraft } from './lib/recon.ts';

// ───────────────────────────── Tolerance ─────────────────────────────

export interface ToleranceDialogProps {
  open: boolean;
  value: ReconTolerance;
  busy: boolean;
  onRun: (t: ReconTolerance) => void;
  onClose: () => void;
}

/** "Matching rules" — edit the tolerance and run (Ctrl+A). */
export function ToleranceDialog({ open, value, busy, onRun, onClose }: ToleranceDialogProps) {
  if (!open) return null;
  return <ToleranceDialogBody value={value} busy={busy} onRun={onRun} onClose={onClose} />;
}

function ToleranceDialogBody({ value, busy, onRun, onClose }: Omit<ToleranceDialogProps, 'open'>) {
  const [draft, setDraft] = useState<ToleranceDraft>({ ...value });
  const [shown, setShown] = useState(false);
  const errors = shown ? toleranceErrors(draft) : {};
  const submit = (): void => {
    setShown(true);
    const t = toleranceFromDraft(draft);
    if (t) onRun(t);
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: submit });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Matching rules"
      description="How close the portal and your books must be for a document to count as matched."
      footerStart={
        <Button variant="ghost" onClick={() => setDraft({ ...DEFAULT_RECON_TOLERANCE })}>
          Reset to defaults
        </Button>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="refresh" shortcut="Ctrl+A" loading={busy} onClick={submit}>
            Reconcile
          </Button>
        </>
      }
    >
      <ToleranceKeys onSubmit={submit} />
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={3}>
          <Field label="Allowed difference per tax head" hint="Taxable value, IGST, CGST, SGST and cess are each compared. ₹1.00 means a ₹1.00 difference still matches; ₹1.01 does not." error={errors.amountPaise}>
            <AmountInput value={draft.amountPaise} onChange={(v) => setDraft((d) => ({ ...d, amountPaise: v }))} symbol min={0} data-autofocus />
          </Field>
          <Field label="Allowed date difference (days)" hint="0 means the invoice dates must be the same." error={errors.dateDays}>
            <NumberInput value={draft.dateDays} onChange={(v) => setDraft((d) => ({ ...d, dateDays: v }))} min={0} max={366} step={1} />
          </Field>
          <Field label="Smart invoice-number matching" hint="Ignores case, spaces, / - _ . and leading zeros, and the year part when that is unambiguous: INV/001/25-26 = inv-1-2526 = INV1.">
            <Switch checked={draft.fuzzyDocNo} onChange={(v) => setDraft((d) => ({ ...d, fuzzyDocNo: v }))} />
          </Field>
        </Stack>
      </form>
    </Modal>
  );
}

function ToleranceKeys({ onSubmit }: { onSubmit: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onSubmit() }, [onSubmit]);
  return null;
}

// ───────────────────────────── Follow-up e-mail ─────────────────────────────

export interface FollowUpDialogProps {
  open: boolean;
  period: string;
  source: ReconSource;
  gstin: string | null;
  onClose: () => void;
}

/** Plain-text e-mail asking the supplier to correct their return: copy, or open in the e-mail app. */
export function FollowUpDialog({ open, period, source, gstin, onClose }: FollowUpDialogProps) {
  if (!open || !gstin) return null;
  return <FollowUpBody period={period} source={source} gstin={gstin} onClose={onClose} />;
}

function FollowUpBody({ period, source, gstin, onClose }: { period: string; source: ReconSource; gstin: string; onClose: () => void }) {
  const toast = useToast();
  const q = useApiQuery('gstrecon.supplierFollowUp', { period, source, supplierGstin: gstin }, { staleTime: 0 });
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const mail = q.data;
  const text = mail ? `Subject: ${mail.subject}\n\n${mail.body}` : '';
  const copy = async (): Promise<void> => {
    if (!mail) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('E-mail copied — paste it into your e-mail');
    } catch {
      toast.error('Could not copy to the clipboard', { message: 'Select the text and press Ctrl+C instead.' });
    }
  };
  const url = mail ? mailtoUrl(mail.subject, mail.body) : null;
  const openMail = async (): Promise<void> => {
    if (!url) return;
    try {
      await native('shell.openExternal', { url });
    } catch (err) {
      toast.error('Could not open your e-mail app', { message: userMessage(err) });
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Follow-up for ${mail?.name ?? gstin}`}
      description={mail ? `${mail.counts.missingInPortal} not reported · ${mail.counts.mismatched} with different details · ${mail.counts.missingInBooks} not in our books` : `${partyWord(source)} ${gstin}`}
      initialFocusRef={copyRef}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button icon="mail" disabled={!url} onClick={() => void openMail()} title={url ? undefined : 'Too long for an e-mail link — copy it instead'}>
            Open in e-mail app
          </Button>
          <Button ref={copyRef} variant="primary" icon="copy" shortcut="Alt+K" disabled={!mail} onClick={() => void copy()}>
            Copy e-mail
          </Button>
        </>
      }
    >
      <FollowUpKeys onCopy={() => void copy()} />
      {q.loading ? (
        <Spinner label="Preparing the e-mail" />
      ) : q.error ? (
        <Banner tone="danger" title="The e-mail could not be prepared">
          {userMessage(q.error)}
        </Banner>
      ) : mail ? (
        <Stack gap={3}>
          <Field label="Subject">
            <TextInput value={mail.subject} readOnly />
          </Field>
          <Field label="Message" hint="Plain text — edit it in your e-mail app after pasting.">
            <TextArea className="bx-gr-mail" value={mail.body} readOnly rows={16} autoGrow maxRows={24} />
          </Field>
        </Stack>
      ) : null}
    </Modal>
  );
}

function FollowUpKeys({ onCopy }: { onCopy: () => void }) {
  useHotkeys({ 'Alt+K': () => onCopy() }, [onCopy]);
  return null;
}
