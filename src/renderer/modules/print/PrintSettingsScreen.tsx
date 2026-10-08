/**
 * 'print.settings' — Invoice printing options (F12 › Invoice printing), with a live preview of the
 * latest sales invoice (or a sample invoice when there is none yet). Saves company config.invoice
 * through 'company.config.save' (needs Company › Manage). Ctrl+A saves, Alt+P prints the preview.
 */
import { useMemo, useRef, useState } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { InvoicePrintOptions, PrintCopy } from '../../../shared/types/print.ts';
import { PRINT_COPIES } from '../../../shared/types/print.ts';
import {
  fieldErrorsOf,
  ReadOnlyNotice,
  Screen,
  useApiMutation,
  useApiQuery,
  useBooks,
  useCan,
  userMessage,
} from '../../app/index.ts';
import {
  Banner,
  Checkbox,
  Field,
  FieldGroup,
  Grid,
  Inline,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TextArea,
  TextInput,
  useDebouncedValue,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';
import { PreviewPane } from './components.tsx';
import { pageSizeFor, resolveCopies, toggleCopy } from './lib/layout.ts';
import { normaliseOptions, previewOverrides, sameOptions, settingsErrors, type SettingsErrors } from './lib/screenState.ts';
import { qrsOf, useDocumentQrs, usePrintActions } from './usePrinting.ts';

const TEMPLATE_OPTIONS: ReadonlyArray<{ value: InvoiceTemplate; label: string }> = [
  { value: 'modern', label: 'Modern' },
  { value: 'classic', label: 'Classic' },
  { value: 'compact', label: 'Compact 80 mm' },
];

const COPY_TEXT: Readonly<Record<PrintCopy, string>> = {
  original: 'Original (for recipient)',
  duplicate: 'Duplicate (for transporter)',
  triplicate: 'Triplicate (for supplier)',
};

export function PrintSettingsScreen() {
  const q = useApiQuery('company.config.get', {});
  if (!q.data) return <Screen title="Invoice Printing" icon="print" loading={q.loading} error={q.error} onRetry={() => void q.refetch()} />;
  return <SettingsForm key={JSON.stringify(q.data.invoice)} saved={q.data.invoice} />;
}

function SettingsForm({ saved }: { saved: InvoicePrintOptions }) {
  const toast = useToast();
  const canEdit = useCan('company.manage');
  const readOnly = !canEdit;
  const [draft, setDraft] = useState<InvoicePrintOptions>(saved);
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = useApiMutation('company.config.save', { invalidates: ['print', 'vouchers'] });
  const dirty = !sameOptions(normaliseOptions(draft), normaliseOptions(saved));
  const errors: SettingsErrors = showErrors ? settingsErrors(draft) : {};
  const errorOf = (k: keyof InvoicePrintOptions): string | undefined => errors[k] ?? serverErrors[`invoice.${k}`];

  const patch = (p: Partial<InvoicePrintOptions>): void => {
    setDraft((d) => ({ ...d, ...p }));
    setSaveError(null);
  };

  const submit = async (): Promise<void> => {
    if (readOnly || !dirty || save.pending) return;
    const errs = settingsErrors(draft);
    if (Object.keys(errs).length > 0) {
      setShowErrors(true);
      return;
    }
    try {
      await save.mutate({ invoice: normaliseOptions(draft) });
      setServerErrors({});
      toast.success('Invoice print settings saved');
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (Object.keys(f).length > 0) setServerErrors(f);
      else setSaveError(userMessage(err));
    }
  };

  // ── Live preview: the latest sales invoice, or a sample (no sales yet, or no access to vouchers) ──
  const { booksFrom } = useBooks();
  const canSeeVouchers = useCan('vouchers.view');
  const latest = useApiQuery(
    'vouchers.list',
    { from: booksFrom, to: '2099-12-31', baseTypes: ['sales'], sort: 'date_desc', limit: 1, includeCancelled: false, includeOptional: false },
    { enabled: canSeeVouchers },
  );
  const sampleId = canSeeVouchers && !latest.error ? (latest.data?.rows[0]?.id ?? null) : null;
  const latestSettled = !canSeeVouchers || latest.data !== undefined || latest.error !== null;
  const overridesJson = useDebouncedValue(JSON.stringify(previewOverrides(draft)), 300);
  const overrides = useMemo(() => JSON.parse(overridesJson) as ReturnType<typeof previewOverrides>, [overridesJson]);
  const real = useApiQuery('print.voucherData', { id: sampleId ?? 0, overrides }, { enabled: sampleId !== null, keepPrevious: true });
  const sample = useApiQuery('print.sample', { overrides }, { enabled: latestSettled && sampleId === null, keepPrevious: true });
  const doc = sampleId !== null ? real.data : sample.data;
  const docs = useMemo(() => (doc ? [doc] : undefined), [doc]);
  const { qrs, ready } = useDocumentQrs(docs);
  const template = draft.template;
  const pageSize = pageSizeFor(template);
  const copies = doc ? resolveCopies(doc) : (['original'] as PrintCopy[]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const printing = usePrintActions(rootRef, { docs: docs ?? [], pageSize, documents: 1, ready });
  const banks = useApiQuery('print.bankLedgers', {});
  const bankOptions = useMemo(
    () => [{ value: '', label: 'None' }, ...(banks.data ?? []).map((b) => ({ value: String(b.ledgerId), label: b.accountNo ? `${b.ledgerName} · A/c ${b.accountNo}` : b.ledgerName }))],
    [banks.data],
  );
  const chosenBank = banks.data?.find((b) => b.ledgerId === draft.bankLedgerId) ?? null;

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });

  return (
    <Screen
      title="Invoice Printing"
      subtitle="How invoices and vouchers look on paper"
      icon="print"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Alt+P Print this preview · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || !dirty || save.pending, hidden: readOnly },
        { key: 'Alt+P', label: 'Print preview', icon: 'print', onClick: () => void printing.print(), disabled: !doc || printing.busy !== null },
        { key: 'Alt+E', label: 'Save preview as PDF', icon: 'download', onClick: () => void printing.savePdf(), disabled: !doc || printing.busy !== null },
      ]}
    >
      <Grid columns="minmax(320px, 440px) minmax(0, 1fr)" gap={5} align="start">
        <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Invoice print settings">
          <Stack gap={5}>
            {readOnly ? <ReadOnlyNotice /> : null}
            {saveError ? <Banner tone="danger" title="Could not save">{saveError}</Banner> : null}
            <FieldGroup legend="Layout">
              <Field label="Template" hint="Classic is the boxed Tally-style invoice; Compact prints on 80 mm receipt rolls.">
                <SegmentedControl aria-label="Template" options={TEMPLATE_OPTIONS} value={draft.template} disabled={readOnly} onChange={(t) => patch({ template: t })} />
              </Field>
              <Field label="Copies" error={errorOf('copies')} hint="Each copy prints on its own page with its label.">
                <Stack gap={1}>
                  {PRINT_COPIES.map((c) => (
                    <Checkbox key={c} label={COPY_TEXT[c]} checked={draft.copies.includes(c)} disabled={readOnly} onChange={() => patch({ copies: toggleCopyAllowEmpty(draft.copies, c) })} />
                  ))}
                </Stack>
              </Field>
              <Switch label="Print right after saving an invoice" checked={draft.printAfterSave} disabled={readOnly} onChange={(v) => patch({ printAfterSave: v })} />
              <Switch label="HSN/SAC-wise tax summary" checked={draft.showHsnSummary} disabled={readOnly} onChange={(v) => patch({ showHsnSummary: v })} />
              <Switch label="Tax columns on every item line" checked={draft.itemwiseTax} disabled={readOnly} onChange={(v) => patch({ itemwiseTax: v })} />
            </FieldGroup>

            <FieldGroup legend="Payment details" description="Printed on sales invoices so customers know how to pay.">
              <Switch label="Show bank account details" checked={draft.showBankDetails} disabled={readOnly} onChange={(v) => patch({ showBankDetails: v })} />
              <Field
                label="Bank account"
                error={errorOf('bankLedgerId')}
                hint={
                  draft.showBankDetails && draft.bankLedgerId === null
                    ? 'Choose the bank ledger whose account number and IFSC should print.'
                    : chosenBank && !chosenBank.accountNo
                      ? 'This bank ledger has no account number yet — add it in the ledger.'
                      : undefined
                }
              >
                <Select
                  value={draft.bankLedgerId === null ? '' : String(draft.bankLedgerId)}
                  options={bankOptions}
                  disabled={readOnly || !draft.showBankDetails}
                  onChange={(v: string) => patch({ bankLedgerId: v === '' ? null : Number(v) })}
                />
              </Field>
              <Switch label="UPI QR code for payment" checked={draft.showUpiQr} disabled={readOnly} onChange={(v) => patch({ showUpiQr: v })} />
              <Field label="UPI ID" error={errorOf('upiId')} hint={chosenBank?.upiId && !draft.upiId.trim() ? `Leave blank to use ${chosenBank.upiId} from the bank ledger.` : 'For example shop@okhdfcbank. The QR code carries the invoice amount.'}>
                <TextInput value={draft.upiId} readOnly={readOnly} maxLength={320} spellCheck={false} placeholder="name@bank" onChange={(e) => patch({ upiId: e.target.value })} />
              </Field>
            </FieldGroup>

            <FieldGroup legend="Text on the invoice">
              <Field label="Signatory" error={errorOf('signatoryLabel')}>
                <TextInput value={draft.signatoryLabel} readOnly={readOnly} maxLength={100} onChange={(e) => patch({ signatoryLabel: e.target.value })} />
              </Field>
              <Field label="Declaration" error={errorOf('declaration')} hint="Ctrl+Enter moves to the next field.">
                <TextArea value={draft.declaration} readOnly={readOnly} rows={3} autoGrow maxRows={8} maxLength={2000} onChange={(e) => patch({ declaration: e.target.value })} />
              </Field>
              <Field label="Terms & conditions" error={errorOf('terms')} optional>
                <TextArea value={draft.terms} readOnly={readOnly} rows={3} autoGrow maxRows={10} maxLength={4000} placeholder="e.g. Goods once sold will not be taken back. Subject to Pune jurisdiction." onChange={(e) => patch({ terms: e.target.value })} />
              </Field>
            </FieldGroup>
          </Stack>
        </form>
        <Stack gap={2}>
          <Inline gap={2}>
            <strong>Preview</strong>
            <span>{doc ? (doc.sample ? 'Sample invoice (no sales yet)' : `${doc.title} ${doc.number ?? ''}`) : 'Loading…'}</span>
          </Inline>
          {real.error || sample.error ? <Banner tone="danger" title="Preview unavailable">{userMessage(real.error ?? sample.error)}</Banner> : null}
          {doc ? (
            <PreviewPane items={[{ doc, copies: copies.slice(0, 1), qrs: qrsOf(qrs, doc.id) }]} template={template} pageSize={pageSize} rootRef={rootRef} preparing={!ready} label="Preview of the invoice layout" />
          ) : null}
        </Stack>
      </Grid>
    </Screen>
  );
}

/** Like toggleCopy, but lets the form reach "no copies" so the error can be shown. */
function toggleCopyAllowEmpty(copies: readonly PrintCopy[], c: PrintCopy): PrintCopy[] {
  if (copies.length === 1 && copies[0] === c) return [];
  return toggleCopy(copies, c);
}
