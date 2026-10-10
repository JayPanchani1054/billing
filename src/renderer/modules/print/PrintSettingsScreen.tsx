/**
 * 'print.settings' — Invoice printing options, with a live preview of the latest sales invoice (or a
 * sample invoice when there is none yet). The ONLY editor of company config.invoice: F12 › Invoices
 * shows a read-only summary and opens this screen (Alt+I). Saves `{ invoice }` alone through
 * 'company.config.save' (needs Company › Manage), so it never overwrites F12's other sections.
 * Also the paper (sheet for Modern / Classic, receipt roll for Compact), the MRP column and the
 * e-mail / WhatsApp share texts (`config.share`, saved together with `invoice`).
 * Ctrl+A saves, Alt+P prints the preview. The bank select lists 'print.bankLedgers' (active ledgers
 * under Bank Accounts and its sub-groups); a blank UPI ID uses the chosen bank ledger's UPI ID.
 * (2.0) "Customize layout…" (Alt+L) opens the print preview's layout editor at company level over this
 * preview: what it changes is part of the draft (`invoice.layout` and the Invoice Printing options that
 * own a part or text) and is saved with Ctrl+A like the rest of the form.
 */
import { useMemo, useRef, useState } from 'react';
import { emptyPrintLayout, layoutWarnings, resolvePrintLayout, type PrintPartId } from '../../../shared/printLayout.ts';
import type { CompanyConfig, InvoicePaperSize, InvoiceTemplate, ReceiptRollWidth } from '../../../shared/settings.ts';
import { fillShareTemplate, shareTemplateErrors } from '../../../shared/shareText.ts';
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
  Button,
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
import { LayoutEditor } from './LayoutEditor.tsx';
import { editorModel, LEGACY_FLAGS, LEGACY_TEXTS, resolveDocLayout, setLayerText, setPartShown, type EditorPartRow, type EditorTextRow } from './lib/layoutParts.ts';
import { PAGE_SIZE_LABELS, pageSizeFor, resolveCopies, toggleCopy } from './lib/layout.ts';
import { bankSelectOptions, normaliseOptions, previewOverrides, sameOptions, settingsErrors, type SettingsErrors } from './lib/screenState.ts';
import { qrsOf, useDocumentQrs, usePrintActions } from './usePrinting.ts';

const TEMPLATE_OPTIONS: ReadonlyArray<{ value: InvoiceTemplate; label: string }> = [
  { value: 'modern', label: 'Modern' },
  { value: 'classic', label: 'Classic' },
  { value: 'compact', label: 'Compact receipt' },
];

const PAPER_OPTIONS: ReadonlyArray<{ value: InvoicePaperSize; label: string }> = (['A4', 'A5', 'A5-landscape', 'Letter', 'Legal'] as const).map((v) => ({
  value: v,
  label: PAGE_SIZE_LABELS[v],
}));

const ROLL_OPTIONS: ReadonlyArray<{ value: ReceiptRollWidth; label: string }> = [
  { value: '80mm', label: '80 mm' },
  { value: '58mm', label: '58 mm' },
];

type ShareTexts = CompanyConfig['share'];

/** Example values for the share text preview. */
const SHARE_EXAMPLE = { document: 'Tax Invoice', number: 'INV/12', date: '09-Oct-2026', amount: '1,180.00', party: 'Sharma Traders', period: '' } as const;

const COPY_TEXT: Readonly<Record<PrintCopy, string>> = {
  original: 'Original (for recipient)',
  duplicate: 'Duplicate (for transporter)',
  triplicate: 'Triplicate (for supplier)',
};

export function PrintSettingsScreen() {
  const q = useApiQuery('company.config.get', {});
  if (!q.data) return <Screen title="Invoice Printing" icon="print" loading={q.loading} error={q.error} onRetry={() => void q.refetch()} />;
  return <SettingsForm key={JSON.stringify([q.data.invoice, q.data.share])} saved={q.data.invoice} savedShare={q.data.share} />;
}

function SettingsForm({ saved, savedShare }: { saved: InvoicePrintOptions; savedShare: ShareTexts }) {
  const toast = useToast();
  const canEdit = useCan('company.manage');
  const readOnly = !canEdit;
  const [draft, setDraft] = useState<InvoicePrintOptions>(saved);
  const [share, setShare] = useState<ShareTexts>(savedShare);
  const shareDirty = JSON.stringify(share) !== JSON.stringify(savedShare);
  const shareErrs = shareTemplateErrors(share);
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = useApiMutation('company.config.save', { invalidates: ['print', 'vouchers'] });
  const dirty = !sameOptions(normaliseOptions(draft), normaliseOptions(saved)) || shareDirty;
  const banks = useApiQuery('print.bankLedgers', {});
  const bankOptions = useMemo(() => bankSelectOptions(banks.data, draft.bankLedgerId), [banks.data, draft.bankLedgerId]);
  const chosenBank = banks.data?.find((b) => b.ledgerId === draft.bankLedgerId) ?? null;
  const errors: SettingsErrors = showErrors ? settingsErrors(draft, chosenBank?.upiId ?? null) : {};
  const errorOf = (k: keyof InvoicePrintOptions): string | undefined => errors[k] ?? serverErrors[`invoice.${k}`];

  const patch = (p: Partial<InvoicePrintOptions>): void => {
    setDraft((d) => ({ ...d, ...p }));
    setSaveError(null);
  };

  const submit = async (): Promise<void> => {
    if (readOnly || !dirty || save.pending) return;
    const errs = settingsErrors(draft, chosenBank?.upiId ?? null);
    if (Object.keys(errs).length > 0 || Object.keys(shareErrs).length > 0) {
      setShowErrors(true);
      return;
    }
    try {
      await save.mutate({ invoice: normaliseOptions(draft), share: { emailSubject: share.emailSubject.trim(), emailBody: share.emailBody, whatsappText: share.whatsappText.trim() } });
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
  const pageSize = pageSizeFor(template, undefined, draft);
  const copies = doc ? resolveCopies(doc) : (['original'] as PrintCopy[]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = draft.layout ?? emptyPrintLayout();
  const previewLayers = useMemo(() => ({ company: layout }), [layout]);
  const resolved = useMemo(() => (doc ? resolveDocLayout(doc, previewLayers) : null), [doc, previewLayers]);
  const printing = usePrintActions(rootRef, { docs: docs ?? [], pageSize, documents: 1, ready, pageNumbers: !resolved?.hidden.has('pageNumbers') });

  // ── (2.0) Customize layout (company level): edits the draft; Ctrl+A saves it with the form ──
  const [customizing, setCustomizing] = useState(false);
  const [pick, setPick] = useState<{ id: PrintPartId; seq: number } | null>(null);
  const model = useMemo(() => {
    if (!doc || !customizing) return null;
    const options = { ...doc.options };
    for (const k of LEGACY_FLAGS) (options as Record<string, unknown>)[k] = draft[k];
    for (const k of LEGACY_TEXTS) (options as Record<string, unknown>)[k] = draft[k];
    return editorModel({
      doc,
      template,
      pageSize,
      level: 'company',
      layers: { company: layout, voucherType: doc.savedLayout?.voucherType ?? emptyPrintLayout(), print: emptyPrintLayout() },
      options,
      baseOptions: options,
      overrides: {},
      vtConfig: null,
      vtName: doc.voucherTypeName,
    });
  }, [doc, customizing, draft, layout, template, pageSize]);
  const layoutLines = useMemo(() => (doc && resolved ? layoutWarnings(doc, resolved) : []), [doc, resolved]);
  const onPart = (row: EditorPartRow, shown: boolean): void => {
    if (row.flag) patch({ [row.flag]: shown });
    else patch({ layout: setPartShown(layout, row.id, shown, resolvePrintLayout()) });
  };
  const onText = (row: EditorTextRow, value: string | null): void => {
    // An option text: '' prints none (as in the form); ↺ sends the built-in default (row.resetValue).
    if (row.option) patch({ [row.option]: value ?? row.resetValue ?? '' });
    else patch({ layout: setLayerText(layout, row.id, value) });
  };
  const layoutError = Object.entries(serverErrors).find(([k]) => k.startsWith('invoice.layout'));

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });

  return (
    <Screen
      title="Invoice Printing"
      subtitle="How invoices and vouchers look on paper"
      icon="print"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Alt+P Print this preview · Alt+E Save as PDF · Alt+L Customize layout · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || !dirty || save.pending, hidden: readOnly },
        { key: 'Alt+P', label: 'Print preview', icon: 'print', onClick: () => void printing.print(), disabled: !doc || printing.busy !== null },
        { key: 'Alt+E', label: 'Save preview as PDF', icon: 'download', onClick: () => void printing.savePdf(), disabled: !doc || printing.busy !== null },
        {
          key: 'Alt+L',
          label: customizing ? 'Back to the settings' : 'Customize layout…',
          icon: 'sliders',
          onClick: () => setCustomizing((c) => !c),
          disabled: !doc,
          group: 'layout',
          hint: 'Show or hide any part and change any text on every document',
          prominent: true,
        },
      ]}
    >
      {layoutError ? (
        <Banner tone="danger" title="The layout could not be saved">
          {layoutError[1]}
        </Banner>
      ) : null}
      {customizing && doc && model ? (
        <Grid columns="minmax(0, 1fr) 360px" gap={4} align="start">
          <PreviewPane
            items={[{ doc, copies: copies.slice(0, 1), qrs: qrsOf(qrs, doc.id) }]}
            template={template}
            pageSize={pageSize}
            rootRef={rootRef}
            paneRef={paneRef}
            preparing={!ready}
            label="Preview of the invoice layout"
            layers={previewLayers}
            editing={{ selected: pick?.id ?? null, onSelect: (pid) => setPick((p) => ({ id: pid, seq: (p?.seq ?? 0) + 1 })) }}
          />
          <LayoutEditor
            model={model}
            warnings={layoutLines}
            onPart={onPart}
            onText={onText}
            pick={pick}
            onEscape={() => paneRef.current?.focus()}
            readOnly={readOnly}
            description="Changes apply to every document unless its voucher type says otherwise. Ctrl+A saves them with the settings."
            footer={
              <Inline gap={2}>
                <Button size="sm" variant="primary" icon="save" disabled={readOnly || !dirty || save.pending} onClick={() => void submit()}>
                  Save
                </Button>
                <Button size="sm" disabled={readOnly || (layout.hide.length + layout.show.length + layout.text.length === 0)} onClick={() => patch({ layout: emptyPrintLayout() })}>
                  Reset layout
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCustomizing(false)}>
                  Done
                </Button>
              </Inline>
            }
          />
        </Grid>
      ) : (
      <Grid columns="minmax(320px, 440px) minmax(0, 1fr)" gap={5} align="start">
        <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Invoice print settings">
          <Stack gap={5}>
            {readOnly ? <ReadOnlyNotice /> : null}
            {saveError ? <Banner tone="danger" title="Could not save">{saveError}</Banner> : null}
            <FieldGroup legend="Layout">
              <Field label="Template" hint="Classic is the familiar boxed GST invoice; Compact prints on thermal receipt rolls.">
                <SegmentedControl aria-label="Template" options={TEMPLATE_OPTIONS} value={draft.template} disabled={readOnly} onChange={(t) => patch({ template: t })} />
              </Field>
              <Field label="Paper" hint="For the Modern and Classic templates (each print preview can still change it).">
                <Select<InvoicePaperSize> value={draft.paperSize} options={PAPER_OPTIONS} disabled={readOnly} onChange={(v) => patch({ paperSize: v })} />
              </Field>
              <Field label="Receipt roll" hint="For the Compact template: 80 mm or 58 mm thermal paper. The receipt is as long as its contents.">
                <SegmentedControl aria-label="Receipt roll width" options={ROLL_OPTIONS} value={draft.rollWidth} disabled={readOnly} onChange={(v) => patch({ rollWidth: v })} />
              </Field>
              <Field label="Copies" error={errorOf('copies')} hint="Each copy prints on its own page with its label.">
                <Stack gap={1}>
                  {PRINT_COPIES.map((c) => (
                    <Checkbox key={c} label={COPY_TEXT[c]} checked={draft.copies.includes(c)} disabled={readOnly} onChange={() => patch({ copies: toggleCopyAllowEmpty(draft.copies, c) })} />
                  ))}
                </Stack>
              </Field>
              <Switch label="Print right after saving an invoice (sales, credit / debit note, delivery note)" checked={draft.printAfterSave} disabled={readOnly} onChange={(v) => patch({ printAfterSave: v })} />
              <Switch label="HSN/SAC-wise tax summary" checked={draft.showHsnSummary} disabled={readOnly} onChange={(v) => patch({ showHsnSummary: v })} />
              <Switch label="Tax columns on every item line" checked={draft.itemwiseTax} disabled={readOnly} onChange={(v) => patch({ itemwiseTax: v })} />
              <Switch
                label="MRP column for items that have an MRP (receipts also show “You saved”)"
                checked={draft.showMrp}
                disabled={readOnly}
                onChange={(v) => patch({ showMrp: v })}
              />
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

            <FieldGroup
              legend="Sharing by e-mail and WhatsApp"
              description="Used by Share (Alt+W) on invoices, vouchers and statements. Placeholders: {document} {number} {date} {amount} {party} {company} {period}."
            >
              <Field label="E-mail subject" error={showErrors ? shareErrs.emailSubject : undefined} hint={`e.g. ${fillShareTemplate(share.emailSubject, { ...SHARE_EXAMPLE, company: doc?.company.displayName ?? 'Your company' })}`}>
                <TextInput value={share.emailSubject} readOnly={readOnly} maxLength={200} onChange={(e) => setShare((x) => ({ ...x, emailSubject: e.target.value }))} />
              </Field>
              <Field label="E-mail text" error={showErrors ? shareErrs.emailBody : undefined} hint="Ctrl+Enter moves to the next field.">
                <TextArea value={share.emailBody} readOnly={readOnly} rows={5} autoGrow maxRows={12} maxLength={4000} onChange={(e) => setShare((x) => ({ ...x, emailBody: e.target.value }))} />
              </Field>
              <Field label="WhatsApp message" error={showErrors ? shareErrs.whatsappText : undefined} hint="Keep it short: the PDF carries the details.">
                <TextArea value={share.whatsappText} readOnly={readOnly} rows={3} autoGrow maxRows={6} maxLength={1000} onChange={(e) => setShare((x) => ({ ...x, whatsappText: e.target.value }))} />
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
            <PreviewPane
              items={[{ doc, copies: copies.slice(0, 1), qrs: qrsOf(qrs, doc.id) }]}
              template={template}
              pageSize={pageSize}
              rootRef={rootRef}
              preparing={!ready}
              label="Preview of the invoice layout"
              layers={previewLayers}
            />
          ) : null}
        </Stack>
      </Grid>
      )}
    </Screen>
  );
}

/** Like toggleCopy, but lets the form reach "no copies" so the error can be shown. */
function toggleCopyAllowEmpty(copies: readonly PrintCopy[], c: PrintCopy): PrintCopy[] {
  if (copies.length === 1 && copies[0] === c) return [];
  return toggleCopy(copies, c);
}
