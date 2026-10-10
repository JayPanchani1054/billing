/**
 * 'print.voucher' {id, copies?, template?, pageSize?, autoPrint?, share?} — print preview of one voucher:
 * template (Modern / Classic / Compact), paper (A4 / A5 / A5 landscape / Letter / Legal / 80 mm and
 * 58 mm rolls), printer for direct printing, copies (Original / Duplicate / Triplicate), Print (Alt+P),
 * Save as PDF (Alt+E), Share by e-mail / WhatsApp (Alt+W; `share` opens it at once), previous / next
 * voucher of the same type (PgUp / PgDn), open the voucher (Alt+V).
 *
 * (2.0) Customize what prints (Alt+L, R5): the layout editor beside the preview shows / hides every part
 * and changes every printed text — for this print (the default; per voucher type, offered again for the
 * rest of the session), or saved for the voucher type (Masters › Alter) or for all documents (Company ›
 * Manage). Parts and texts an Invoice Printing option owns go through the preview overrides and are saved
 * to that option (lib/layoutParts.ts). Print, PDF and Share print exactly the preview. Print after saving
 * (`autoPrint`) uses the saved layouts only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { InvoicePrintOptions, PrintCopy, PrintPageSize, ShareChannel } from '../../../shared/types/print.ts';
import { PRINT_COPIES, PRINT_PAGE_SIZES } from '../../../shared/types/print.ts';
import {
  EMPTY_PRINT_LAYOUT,
  emptyPrintLayout,
  layoutWarnings,
  resolvePrintLayout,
  shadowedByLegacy,
  validatePrintLayout,
  type PrintLayoutSpec,
  type PrintPartId,
} from '../../../shared/printLayout.ts';
import { EXPORT_DENIED_HINT_TEXT } from './lib/share.ts';
import { Screen, useApiMutation, useApiQuery, useCan, useCompany, useConfirm, useNav, userMessage, type ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DropdownMenu, EmptyState, Grid, Inline, Stack, useDebouncedValue, useToast } from '../../ui/index.ts';
import { PreviewPane, PrintControls, WarningsBanner } from './components.tsx';
import { LayoutEditor } from './LayoutEditor.tsx';
import { ShareDialog } from './ShareDialog.tsx';
import { isRoll, pageSizeFor, resolveCopies, resolveTemplate, templateForPageSize, toggleCopy } from './lib/layout.ts';
import {
  companyPatch,
  editorModel,
  emptyEdit,
  isEmptyEdit,
  overridesAfterSave,
  parseSessionEdit,
  remainingPerPrint,
  resolveDocLayout,
  serialiseSessionEdit,
  sessionKey,
  setLayerText,
  setPartShown,
  VOUCHER_TYPE_RESET,
  voucherTypePatch,
  type EditorPartRow,
  type EditorTextRow,
  type LayoutOverrides,
  type PerPrintEdit,
} from './lib/layoutParts.ts';
import { cycle } from './lib/screenState.ts';
import { qrsOf, useDocumentQrs, usePrintActions, usePrinterChoice } from './usePrinting.ts';

export interface PrintVoucherParams {
  id: number;
  /** 1–3 or a list of copies; default Invoice Printing (print settings) › Copies. */
  copies?: number | PrintCopy[];
  template?: InvoiceTemplate;
  pageSize?: PrintPageSize;
  /** Send to the printer as soon as the preview is ready (print after saving a voucher). */
  autoPrint?: boolean;
  /** Open the Share dialog once the document is ready (Share from the voucher view): a channel or true. */
  share?: ShareChannel | true;
}

const TEMPLATES: readonly InvoiceTemplate[] = ['modern', 'classic', 'compact'];
const SIZES: readonly PrintPageSize[] = PRINT_PAGE_SIZES;
const NO_EDIT: PerPrintEdit = Object.freeze(emptyEdit()) as PerPrintEdit;

/** This print's layout of a voucher type, remembered for the session (a convenience: never required). */
function readSessionEdit(companyId: string, vtId: number): PerPrintEdit | null {
  try {
    return parseSessionEdit(window.sessionStorage.getItem(sessionKey(companyId, vtId)));
  } catch {
    return null;
  }
}

function writeSessionEdit(companyId: string, vtId: number, edit: PerPrintEdit): void {
  try {
    if (isEmptyEdit(edit)) window.sessionStorage.removeItem(sessionKey(companyId, vtId));
    else window.sessionStorage.setItem(sessionKey(companyId, vtId), serialiseSessionEdit(edit));
  } catch {
    /* session memory is a convenience only */
  }
}

export function PrintVoucherScreen({ params }: ScreenProps<PrintVoucherParams>) {
  const nav = useNav();
  const company = useCompany();
  const confirm = useConfirm();
  const toast = useToast();
  const [id, setId] = useState<number>(params.id);
  const validId = Number.isInteger(id) && id > 0;

  // ── (2.0) This print's layout, per voucher type: layer + option overrides (debounced into the query) ──
  const [vtId, setVtId] = useState<number | null>(null);
  const [edits, setEdits] = useState<Readonly<Record<number, PerPrintEdit>>>({});
  const edit = vtId !== null ? (edits[vtId] ?? NO_EDIT) : NO_EDIT;
  const overridesJson = JSON.stringify(edit.overrides);
  const sentJson = useDebouncedValue(overridesJson, 300);
  const sent = useMemo(() => JSON.parse(sentJson) as LayoutOverrides, [sentJson]);
  const input = Object.keys(sent).length > 0 ? { id, overrides: sent } : { id };
  const q = useApiQuery('print.voucherData', input, { enabled: validId, keepPrevious: true });
  const doc = q.data;
  useEffect(() => {
    if (doc && !q.isPrevious && doc.voucherTypeId !== vtId) setVtId(doc.voucherTypeId);
  }, [doc, q.isPrevious, vtId]);
  // The document and the overrides it was built with belong to the same voucher type and are current.
  const layoutCurrent = !!doc && doc.voucherTypeId === vtId && sentJson === overridesJson;

  // Option values without this print's overrides (placeholders of the option-owned texts).
  const baseOptions = useRef(new Map<number, InvoicePrintOptions>());
  if (doc && !q.isPrevious && Object.keys(sent).length === 0 && doc.voucherTypeId === vtId) baseOptions.current.set(doc.voucherTypeId, doc.options);

  // Session memory: changes made to this voucher type earlier in the session are offered, never applied unasked.
  const [offer, setOffer] = useState<PerPrintEdit | null>(null);
  useEffect(() => {
    if (vtId === null || params.autoPrint || !isEmptyEdit(edits[vtId])) setOffer(null);
    else setOffer(readSessionEdit(company.id, vtId));
    // Only when the voucher type changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vtId]);
  const updateEdit = (next: PerPrintEdit): void => {
    if (vtId === null) return;
    setEdits((e) => ({ ...e, [vtId]: next }));
    writeSessionEdit(company.id, vtId, next);
    setOffer(null);
  };

  const [templateChoice, setTemplateChoice] = useState<InvoiceTemplate | undefined>(params.template);
  const [sizeChoice, setSizeChoice] = useState<PrintPageSize | undefined>(params.pageSize);
  const [copiesChoice, setCopiesChoice] = useState<number | PrintCopy[] | undefined>(params.copies);

  const template = doc ? resolveTemplate(doc, templateChoice) : (templateChoice ?? 'modern');
  const pageSize = pageSizeFor(template, sizeChoice, doc?.options);
  const printer = usePrinterChoice(isRoll(pageSize) ? 'roll' : 'sheet');
  const copies = useMemo(() => (doc ? resolveCopies(doc, copiesChoice) : (['original'] as PrintCopy[])), [doc, copiesChoice]);
  const docs = useMemo(() => (doc ? [doc] : undefined), [doc]);
  const { qrs, ready } = useDocumentQrs(docs);
  const layers = useMemo(() => ({ print: edit.layer }), [edit.layer]);
  const resolved = useMemo(() => (doc ? resolveDocLayout(doc, layers) : null), [doc, layers]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const actions = usePrintActions(rootRef, {
    docs: docs ?? [],
    pageSize,
    documents: copies.length,
    ready: ready && !q.isPrevious && layoutCurrent,
    deviceName: printer.printer || undefined,
    pageNumbers: !resolved?.hidden.has('pageNumbers'),
  });

  // Print after save: once, when the document and its QR codes are ready.
  const autoPrinted = useRef(false);
  useEffect(() => {
    if (!params.autoPrint || autoPrinted.current || !doc || !ready || q.isPrevious || !layoutCurrent) return;
    autoPrinted.current = true;
    void actions.print();
  }, [params.autoPrint, doc, ready, q.isPrevious, layoutCurrent, actions]);

  const setTemplate = (t: InvoiceTemplate): void => {
    setTemplateChoice(t);
    // The compact receipt goes on the configured roll; the others back on the configured sheet.
    if (t === 'compact' ? sizeChoice !== undefined && !isRoll(sizeChoice) : sizeChoice !== undefined && isRoll(sizeChoice)) setSizeChoice(undefined);
  };
  const setPageSize = (s: PrintPageSize): void => {
    setSizeChoice(s);
    setTemplateChoice(templateForPageSize(template, s, doc?.defaultTemplate ?? 'modern'));
  };
  const toggle = (c: PrintCopy): void => setCopiesChoice(toggleCopy(copies, c));
  const go = (target: number | null): void => {
    if (target !== null) setId(target);
  };

  // Share (Alt+W): opened from here, or at once when the screen was opened to share.
  const canExport = useCan('data.export');
  const [sharing, setSharing] = useState<ShareChannel | true | null>(null);
  const autoShared = useRef(false);
  useEffect(() => {
    if (!params.share || autoShared.current || !doc || !ready || q.isPrevious) return;
    autoShared.current = true;
    if (canExport) setSharing(params.share);
  }, [params.share, doc, ready, q.isPrevious, canExport]);

  // ── (2.0) The layout editor ──
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState<{ id: PrintPartId; seq: number } | null>(null);
  const canAlterTypes = useCan('masters.alter');
  const canViewTypes = useCan('masters.view');
  const canManage = useCan('company.manage');
  const vt = useApiQuery('accounts.voucherType.get', { id: vtId ?? 0 }, { enabled: editing && canViewTypes && vtId !== null && vtId > 0 });
  const vtConfig = vt.data?.config ?? null;
  const saveType = useApiMutation('accounts.voucherType.save', { invalidates: ['print', 'accounts', 'company'] });
  const saveCompany = useApiMutation('company.config.save', { invalidates: ['print', 'accounts', 'company'] });
  const saving = saveType.pending || saveCompany.pending;

  const savedLayers = useMemo(
    () => ({ company: doc?.savedLayout?.company ?? EMPTY_PRINT_LAYOUT, voucherType: doc?.savedLayout?.voucherType ?? EMPTY_PRINT_LAYOUT }),
    [doc],
  );
  const options = useMemo<InvoicePrintOptions | null>(() => (doc ? { ...doc.options, ...edit.overrides } : null), [doc, edit.overrides]);
  const model = useMemo(() => {
    if (!doc || !options || !editing) return null;
    return editorModel({
      doc,
      template,
      pageSize,
      level: 'print',
      layers: { ...savedLayers, print: edit.layer },
      options,
      baseOptions: baseOptions.current.get(doc.voucherTypeId) ?? doc.options,
      overrides: edit.overrides,
      vtConfig,
      vtName: doc.voucherTypeName,
    });
  }, [doc, options, editing, template, pageSize, savedLayers, edit, vtConfig]);
  const layoutLines = useMemo(() => (doc && resolved ? layoutWarnings(doc, resolved) : []), [doc, resolved]);

  const toggleEditing = (): void => {
    if (editing) paneRef.current?.focus();
    setEditing((e) => !e);
  };
  const onPart = (row: EditorPartRow, shown: boolean): void => {
    if (row.flag) {
      const base = baseOptions.current.get(vtId ?? -1);
      const overrides = { ...edit.overrides };
      if (base && base[row.flag] === shown) delete overrides[row.flag];
      else overrides[row.flag] = shown;
      updateEdit({ ...edit, overrides });
    } else {
      updateEdit({ ...edit, layer: setPartShown(edit.layer, row.id, shown, resolvePrintLayout(savedLayers.company, savedLayers.voucherType)) });
    }
  };
  const onText = (row: EditorTextRow, value: string | null): void => {
    if (row.option) {
      const overrides = { ...edit.overrides };
      if (value === null) delete overrides[row.option];
      else overrides[row.option] = value;
      updateEdit({ ...edit, overrides });
    } else {
      updateEdit({ ...edit, layer: setLayerText(edit.layer, row.id, value) });
    }
  };

  /** The voucher type's stored layer (the voucher type itself when readable; else what the document carries). */
  const storedTypeLayer = (): PrintLayoutSpec => (vtConfig ? validatePrintLayout(vtConfig.printLayout ?? null, 'voucherType').value : savedLayers.voucherType);

  const saveForType = async (): Promise<void> => {
    if (!doc || isEmptyEdit(edit) || saving) return;
    const patch = voucherTypePatch(edit, { company: savedLayers.company, voucherType: storedTypeLayer() });
    if (patch.issues.length > 0) {
      toast.error('Could not save the layout', { message: patch.issues[0] });
      return;
    }
    try {
      await saveType.mutate({ id: doc.voucherTypeId, config: patch.config });
      updateEdit({
        layer: remainingPerPrint(edit.layer, { company: savedLayers.company, voucherType: patch.layer }, { texts: patch.writtenTexts }),
        overrides: overridesAfterSave(edit.overrides, 'voucherType', vtConfig),
      });
      toast.success(`Saved for ${doc.voucherTypeName}`, { message: `Every ${doc.voucherTypeName} document now prints this way.` });
    } catch (err) {
      toast.error('Could not save the layout', { message: userMessage(err) });
    }
  };

  const saveForAll = async (): Promise<void> => {
    if (!doc || isEmptyEdit(edit) || saving) return;
    const patch = companyPatch(edit, { company: doc.options.layout ?? EMPTY_PRINT_LAYOUT });
    if (patch.issues.length > 0) {
      toast.error('Could not save the layout', { message: patch.issues[0] });
      return;
    }
    try {
      await saveCompany.mutate({ invoice: patch.invoice });
      const after = shadowedByLegacy({ company: patch.layer, voucherType: savedLayers.voucherType }, { voucherType: vtConfig as Record<string, unknown> | null });
      updateEdit({ layer: remainingPerPrint(edit.layer, after), overrides: overridesAfterSave(edit.overrides, 'company', vtConfig) });
      toast.success('Saved for all documents', { message: 'Every document now prints this way unless its voucher type says otherwise.' });
    } catch (err) {
      toast.error('Could not save the layout', { message: userMessage(err) });
    }
  };

  const reset = async (key: string): Promise<void> => {
    if (!doc) return;
    if (key === 'print') {
      const ok = await confirm({
        title: 'Undo the changes made to this print?',
        message: `This print goes back to what is saved for ${doc.voucherTypeName} and for all documents.`,
        confirmLabel: 'Undo changes',
      });
      if (ok) updateEdit(emptyEdit());
      return;
    }
    try {
      if (key === 'voucherType') {
        const ok = await confirm({
          title: `Reset what is saved for ${doc.voucherTypeName}?`,
          message: `Parts hidden or shown and wording saved for ${doc.voucherTypeName}, and its own HSN summary, bank details, UPI QR, item-wise tax and MRP choices are removed. Its print title, declaration and terms stay (Masters › Voucher Types). ${doc.voucherTypeName} documents then print as set for all documents.`,
          confirmLabel: 'Reset',
          tone: 'danger',
        });
        if (!ok) return;
        await saveType.mutate({ id: doc.voucherTypeId, config: VOUCHER_TYPE_RESET });
        toast.success(`${doc.voucherTypeName} prints as set for all documents`);
      } else if (key === 'company') {
        const ok = await confirm({
          title: 'Reset what is saved for all documents?',
          message: 'Parts hidden or shown and wording saved for all documents are removed. Invoice Printing settings (template, bank details, UPI QR, HSN summary, declaration, terms, signatory) stay.',
          confirmLabel: 'Reset',
          tone: 'danger',
        });
        if (!ok) return;
        await saveCompany.mutate({ invoice: { layout: emptyPrintLayout() } });
        toast.success('Documents print as set in Invoice Printing');
      }
    } catch (err) {
      toast.error('Could not reset the layout', { message: userMessage(err) });
    }
  };

  const prevId = doc && !q.isPrevious ? doc.navigation.prevId : null;
  const nextId = doc && !q.isPrevious ? doc.navigation.nextId : null;
  const vtName = doc?.voucherTypeName ?? 'this voucher type';
  const unsaved = !isEmptyEdit(edit);
  const typeReason = !canAlterTypes ? `Saving for ${vtName} needs the “Alter masters” permission.` : null;
  const companyReason = !canManage ? 'Saving for all documents needs the “Change company settings” permission.' : null;

  const editorFooter = (
    <Stack gap={2}>
      <Inline gap={2}>
        <Button variant="primary" size="sm" icon="save" disabled={!unsaved || !canAlterTypes || saving} onClick={() => void saveForType()}>
          {`Save for ${vtName}`}
        </Button>
        <Button size="sm" disabled={!unsaved || !canManage || saving} onClick={() => void saveForAll()}>
          Save for all documents
        </Button>
        <DropdownMenu
          label="Reset"
          icon="undo"
          size="sm"
          variant="ghost"
          onAction={(k) => void reset(k)}
          items={[
            { key: 'print', label: 'This print', description: 'Undo the changes made here', disabled: !unsaved },
            { key: 'voucherType', label: `Saved for ${vtName}`, disabled: !canAlterTypes || saving },
            { key: 'company', label: 'Saved for all documents', disabled: !canManage || saving },
          ]}
        />
      </Inline>
      {typeReason || companyReason ? <span className="bx-muted">{[typeReason, companyReason].filter(Boolean).join(' ')}</span> : null}
    </Stack>
  );

  const offerNotice = offer ? (
    <Banner tone="info" title="Earlier changes in this session">
      <Stack gap={2}>
        <span>{`You changed what prints on a ${vtName} document earlier. Apply the same changes to this print?`}</span>
        <Inline gap={2}>
          <Button size="sm" onClick={() => updateEdit(offer)}>
            Apply them
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOffer(null)}>
            Not now
          </Button>
        </Inline>
      </Stack>
    </Banner>
  ) : null;

  const preview = doc ? (
    <PreviewPane
      items={[{ doc, copies, qrs: qrsOf(qrs, doc.id) }]}
      template={template}
      pageSize={pageSize}
      rootRef={rootRef}
      paneRef={paneRef}
      preparing={!ready}
      label={`Print preview of ${doc.title} ${doc.number ?? ''}`.trim()}
      layers={layers}
      editing={editing ? { selected: pick?.id ?? null, onSelect: (pid) => setPick((p) => ({ id: pid, seq: (p?.seq ?? 0) + 1 })) } : null}
    />
  ) : null;

  return (
    <Screen
      title="Print Preview"
      subtitle={doc ? `${doc.title}${doc.number ? ` ${doc.number}` : ''}${doc.party?.name ? ` · ${doc.party.name}` : ''}` : undefined}
      icon="print"
      meta={
        doc ? (
          <Inline gap={2}>
            {doc.status.cancelled ? <Badge tone="danger">Cancelled</Badge> : null}
            {doc.status.optional ? <Badge tone="warning">Optional</Badge> : null}
            {doc.einvoice ? <Badge tone="success">e-Invoice</Badge> : null}
            {unsaved ? <Badge tone="info">Customized for this print</Badge> : null}
          </Inline>
        ) : undefined
      }
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Alt+P Print · Alt+E Save PDF · Alt+W Share · Alt+L Customize · PgUp/PgDn Previous/Next Voucher · Alt+T Template · Alt+S Paper · Ctrl+1/2/3 Copies · Esc Back"
      actions={[
        { key: 'Alt+P', label: 'Print', icon: 'print', primary: true, onClick: () => void actions.print(), disabled: !doc || actions.busy !== null, hint: 'Opens the printer dialog' },
        { key: 'Alt+E', label: 'Save as PDF', icon: 'download', onClick: () => void actions.savePdf(), disabled: !doc || actions.busy !== null },
        {
          key: 'Alt+W',
          label: 'Share (e-mail / WhatsApp)',
          icon: 'mail',
          onClick: () => setSharing(true),
          disabled: !doc || !ready || !canExport,
          hint: canExport ? 'Sends the PDF by e-mail or WhatsApp' : EXPORT_DENIED_HINT_TEXT,
        },
        { key: 'PageUp', label: 'Previous voucher', icon: 'chevron-left', onClick: () => go(prevId), disabled: prevId === null, group: 'nav' },
        { key: 'PageDown', label: 'Next voucher', icon: 'chevron-right', onClick: () => go(nextId), disabled: nextId === null, group: 'nav' },
        { key: 'Alt+V', label: 'Open voucher', icon: 'eye', onClick: () => nav.push('vouchers.view', { id }), disabled: !doc, group: 'nav' },
        {
          key: 'Alt+L',
          label: 'Customize layout',
          icon: 'sliders',
          onClick: toggleEditing,
          disabled: !doc,
          group: 'layout',
          hint: 'Show or hide any part and change any text — for this print, or save it',
          prominent: true,
        },
        { key: 'Alt+T', label: 'Change template', icon: 'layers', onClick: () => setTemplate(cycle(TEMPLATES, template)), disabled: !doc, group: 'layout' },
        { key: 'Alt+S', label: 'Change paper size', icon: 'file', onClick: () => setPageSize(cycle(SIZES, pageSize)), disabled: !doc, group: 'layout' },
        { key: 'Ctrl+1', label: 'Original copy', onClick: () => toggle(PRINT_COPIES[0]), disabled: !doc, group: 'copies' },
        { key: 'Ctrl+2', label: 'Duplicate copy', onClick: () => toggle(PRINT_COPIES[1]), disabled: !doc, group: 'copies' },
        { key: 'Ctrl+3', label: 'Triplicate copy', onClick: () => toggle(PRINT_COPIES[2]), disabled: !doc, group: 'copies' },
      ]}
    >
      {!validId ? (
        <EmptyState icon="file" title="No voucher to print" body="Open a voucher and press Alt+P to print it." />
      ) : doc ? (
        <Stack gap={3}>
          <PrintControls
            template={template}
            onTemplate={setTemplate}
            pageSize={pageSize}
            onPageSize={setPageSize}
            copies={copies}
            onCopies={setCopiesChoice}
            copyLabels={doc.copyLabels}
            printer={printer}
          />
          <WarningsBanner warnings={layoutLines.length > 0 ? [...doc.warnings, ...layoutLines] : doc.warnings} />
          {/* One place for the preview, panel open or not: moved between two parents it would be remounted on
              every Alt+L, and the focus given back to it when the panel closes would be lost. */}
          <Grid columns={editing && model ? 'minmax(0, 1fr) 360px' : 'minmax(0, 1fr)'} gap={4} align="start">
            {preview}
            {editing && model ? (
              <LayoutEditor
                model={model}
                warnings={layoutLines}
                onPart={onPart}
                onText={onText}
                pick={pick}
                onEscape={() => paneRef.current?.focus()}
                description={`Changes apply to this print. Save them for every ${vtName} document, or for all documents.`}
                notice={offerNotice}
                footer={editorFooter}
              />
            ) : null}
          </Grid>
          {sharing !== null ? (
            <ShareDialog subject={{ voucherId: doc.id }} render={actions.render} onClose={() => setSharing(null)} channel={sharing === true ? undefined : sharing} />
          ) : null}
        </Stack>
      ) : null}
    </Screen>
  );
}
