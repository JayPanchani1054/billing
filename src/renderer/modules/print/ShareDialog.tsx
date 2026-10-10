/**
 * Share dialog (print group): send the document on screen as a PDF by e-mail (a draft opens in the
 * user's mail program with the PDF attached) or on WhatsApp (chat opens with the message; the PDF is
 * shown in its folder to attach). Recipient and texts come from the party ledger and Invoice Printing
 * (print settings) › Sharing ('print.share.context'), editable here.
 *
 * Order of work: 'print.share.log' (data.export permission + edit-log 'export' entry, like printing) →
 * native 'share.email' / 'share.whatsapp' (main renders the PDF into <company>/exports/shared, never a
 * renderer-chosen path). Keys: ←/→ channel, Enter next field, Ctrl+A send, Esc close.
 */
import { useEffect, useRef, useState } from 'react';
import type { ShareChannel, ShareSubjectInput } from '../../../shared/types/print.ts';
import { api, native, showInFolder, useApiQuery, useCan, userMessage } from '../../app/index.ts';
import {
  Banner,
  Button,
  Field,
  Hotkeys,
  Modal,
  SegmentedControl,
  Spinner,
  Stack,
  TextArea,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import { initialDraft, normaliseMobile, recipients, shareDoneMessage, shareErrors, type ShareDraft } from './lib/share.ts';
import type { RenderedDocument } from './usePrinting.ts';

const CHANNELS: ReadonlyArray<{ value: ShareChannel; label: string }> = [
  { value: 'email', label: 'E-mail' },
  { value: 'whatsapp', label: 'WhatsApp' },
];

export interface ShareDialogProps {
  subject: ShareSubjectInput;
  /** The printable document (null while it is still being prepared). */
  render: () => RenderedDocument | null;
  onClose: () => void;
  /** Channel to start with (default: e-mail when the party has an address). */
  channel?: ShareChannel;
}

export function ShareDialog({ subject, render, onClose, channel }: ShareDialogProps) {
  const toast = useToast();
  const canExport = useCan('data.export');
  const ctx = useApiQuery('print.share.context', subject, { enabled: canExport, staleTime: 0 });
  const [draft, setDraft] = useState<ShareDraft | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void send() });

  useEffect(() => {
    if (ctx.data && draft === null) setDraft(initialDraft(ctx.data, channel));
  }, [ctx.data, draft, channel]);

  const errors = draft && showErrors ? shareErrors(draft) : {};
  const patch = (p: Partial<ShareDraft>): void => setDraft((d) => (d ? { ...d, ...p } : d));

  async function send(): Promise<void> {
    if (!draft || !ctx.data || busy) return;
    const errs = shareErrors(draft);
    if (Object.keys(errs).length > 0) {
      setShowErrors(true);
      return;
    }
    const doc = render();
    if (!doc) {
      toast.info('Still preparing the document', { message: 'Try again in a moment.' });
      return;
    }
    setBusy(true);
    setFailure(null);
    const fileName = ctx.data.fileName || doc.fileName.replace(/\.pdf$/i, '');
    const paper = { pageSize: doc.pageSize, landscape: doc.landscape, ...(doc.rollHeightMm !== undefined ? { rollHeightMm: doc.rollHeightMm } : {}) };
    try {
      const to = draft.channel === 'email' ? recipients(draft.to).join(', ') : normaliseMobile(draft.mobile);
      await api('print.share.log', { ...subject, channel: draft.channel, ...(to ? { to } : {}), fileName: `${fileName}.pdf` });
      if (draft.channel === 'email') {
        const res = await native('share.email', { html: doc.html, fileName, ...paper, ...(to ? { to } : {}), subject: draft.subject.trim(), body: draft.body });
        const msg = shareDoneMessage('email', res.opened);
        toast.success(msg.title, { message: msg.message, action: { label: 'Show in folder', onClick: () => showInFolder(res.pdfPath) } });
      } else {
        const res = await native('share.whatsapp', { html: doc.html, fileName, ...paper, ...(to ? { mobile: to } : {}), text: draft.whatsappText.trim() });
        const msg = shareDoneMessage('whatsapp', res.opened);
        toast.success(msg.title, { message: msg.message, action: { label: 'Show in folder', onClick: () => showInFolder(res.pdfPath) } });
      }
      onClose();
    } catch (err) {
      setFailure(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isEmail = draft?.channel !== 'whatsapp';
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Share ${ctx.data?.label ?? 'document'}`}
      description={isEmail ? 'Opens an e-mail draft in your mail program with the PDF attached.' : 'Opens WhatsApp with the message; attach the PDF from the folder that opens.'}
      initialFocusRef={firstRef}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={isEmail ? 'mail' : 'phone'} shortcut="Ctrl+A" loading={busy} disabled={!draft || !canExport} onClick={() => void send()}>
            {isEmail ? 'Open e-mail draft' : 'Open WhatsApp'}
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void send() }} />
      {!canExport ? (
        <Banner tone="warning" title="Sharing is an export">
          You need the Data › Export permission to share documents. Ask an administrator.
        </Banner>
      ) : ctx.error ? (
        <Banner tone="danger" title="Could not prepare the message">
          {userMessage(ctx.error)}
        </Banner>
      ) : !draft ? (
        <Spinner size="sm" label="Preparing" />
      ) : (
        <div ref={formRef}>
          <Stack gap={3}>
            {failure ? (
              <Banner tone="danger" title="Could not share">
                {failure}
              </Banner>
            ) : null}
            <Field label="Send by">
              <SegmentedControl aria-label="Send by" options={CHANNELS} value={draft.channel} onChange={(c) => patch({ channel: c })} />
            </Field>
            {draft.channel === 'email' ? (
              <>
                <Field
                  label="To"
                  error={errors.to}
                  hint={ctx.data?.email ? undefined : 'The party ledger has no e-mail address: type one, or leave it blank and fill it in the mail program.'}
                >
                  <TextInput ref={firstRef} value={draft.to} maxLength={2000} spellCheck={false} placeholder="accounts@example.com" onChange={(e) => patch({ to: e.target.value })} />
                </Field>
                <Field label="Subject" error={errors.subject}>
                  <TextInput value={draft.subject} maxLength={300} onChange={(e) => patch({ subject: e.target.value })} />
                </Field>
                <Field label="Message" error={errors.body} hint="Ctrl+Enter moves on; Ctrl+A opens the draft.">
                  <TextArea value={draft.body} rows={6} autoGrow maxRows={12} maxLength={20_000} onChange={(e) => patch({ body: e.target.value })} />
                </Field>
              </>
            ) : (
              <>
                <Field
                  label="Mobile"
                  error={errors.mobile}
                  hint={ctx.data?.mobile ? 'WhatsApp opens the chat with this number (+91).' : 'The party ledger has no mobile number: type one, or leave it blank to pick the contact in WhatsApp.'}
                >
                  <TextInput ref={firstRef} value={draft.mobile} maxLength={20} inputMode="tel" placeholder="98765 43210" onChange={(e) => patch({ mobile: e.target.value })} />
                </Field>
                <Field label="Message" error={errors.whatsappText}>
                  <TextArea value={draft.whatsappText} rows={4} autoGrow maxRows={8} maxLength={1000} onChange={(e) => patch({ whatsappText: e.target.value })} />
                </Field>
              </>
            )}
          </Stack>
        </div>
      )}
    </Modal>
  );
}
