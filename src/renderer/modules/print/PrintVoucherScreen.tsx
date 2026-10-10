/**
 * 'print.voucher' {id, copies?, template?, pageSize?, autoPrint?, share?} — print preview of one voucher:
 * template (Modern / Classic / Compact), paper (A4 / A5 / A5 landscape / Letter / Legal / 80 mm and
 * 58 mm rolls), printer for direct printing, copies (Original / Duplicate / Triplicate), Print (Alt+P),
 * Save as PDF (Alt+E), Share by e-mail / WhatsApp (Alt+W; `share` opens it at once), previous / next
 * voucher of the same type (PgUp / PgDn), open the voucher (Alt+V).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { PrintCopy, PrintPageSize, ShareChannel } from '../../../shared/types/print.ts';
import { PRINT_COPIES, PRINT_PAGE_SIZES } from '../../../shared/types/print.ts';
import { EXPORT_DENIED_HINT_TEXT } from './lib/share.ts';
import { Screen, useApiQuery, useCan, useNav, type ScreenProps } from '../../app/index.ts';
import { Badge, EmptyState, Inline, Stack } from '../../ui/index.ts';
import { PreviewPane, PrintControls, WarningsBanner } from './components.tsx';
import { ShareDialog } from './ShareDialog.tsx';
import { isRoll, pageSizeFor, resolveCopies, resolveTemplate, templateForPageSize, toggleCopy } from './lib/layout.ts';
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

export function PrintVoucherScreen({ params }: ScreenProps<PrintVoucherParams>) {
  const nav = useNav();
  const [id, setId] = useState<number>(params.id);
  const validId = Number.isInteger(id) && id > 0;
  const q = useApiQuery('print.voucherData', { id }, { enabled: validId, keepPrevious: true });
  const doc = q.data;
  const [templateChoice, setTemplateChoice] = useState<InvoiceTemplate | undefined>(params.template);
  const [sizeChoice, setSizeChoice] = useState<PrintPageSize | undefined>(params.pageSize);
  const [copiesChoice, setCopiesChoice] = useState<number | PrintCopy[] | undefined>(params.copies);

  const template = doc ? resolveTemplate(doc, templateChoice) : (templateChoice ?? 'modern');
  const pageSize = pageSizeFor(template, sizeChoice, doc?.options);
  const printer = usePrinterChoice(isRoll(pageSize) ? 'roll' : 'sheet');
  const copies = useMemo(() => (doc ? resolveCopies(doc, copiesChoice) : (['original'] as PrintCopy[])), [doc, copiesChoice]);
  const docs = useMemo(() => (doc ? [doc] : undefined), [doc]);
  const { qrs, ready } = useDocumentQrs(docs);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const actions = usePrintActions(rootRef, {
    docs: docs ?? [],
    pageSize,
    documents: copies.length,
    ready: ready && !q.isPrevious,
    deviceName: printer.printer || undefined,
  });

  // Print after save: once, when the document and its QR codes are ready.
  const autoPrinted = useRef(false);
  useEffect(() => {
    if (!params.autoPrint || autoPrinted.current || !doc || !ready || q.isPrevious) return;
    autoPrinted.current = true;
    void actions.print();
  }, [params.autoPrint, doc, ready, q.isPrevious, actions]);

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

  const prevId = doc && !q.isPrevious ? doc.navigation.prevId : null;
  const nextId = doc && !q.isPrevious ? doc.navigation.nextId : null;

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
          </Inline>
        ) : undefined
      }
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Alt+P Print · Alt+E Save PDF · Alt+W Share · PgUp/PgDn Previous/Next Voucher · Alt+T Template · Alt+S Paper · Ctrl+1/2/3 Copies · Esc Back"
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
          <WarningsBanner warnings={doc.warnings} />
          <PreviewPane
            items={[{ doc, copies, qrs: qrsOf(qrs, doc.id) }]}
            template={template}
            pageSize={pageSize}
            rootRef={rootRef}
            preparing={!ready}
            label={`Print preview of ${doc.title} ${doc.number ?? ''}`.trim()}
          />
          {sharing !== null ? (
            <ShareDialog subject={{ voucherId: doc.id }} render={actions.render} onClose={() => setSharing(null)} channel={sharing === true ? undefined : sharing} />
          ) : null}
        </Stack>
      ) : null}
    </Screen>
  );
}
