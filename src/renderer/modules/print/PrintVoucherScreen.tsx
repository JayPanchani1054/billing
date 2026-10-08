/**
 * 'print.voucher' {id, copies?, template?, pageSize?, autoPrint?} — print preview of one voucher:
 * template (Modern / Classic / Compact), paper (A4 / A5 / 80 mm), copies (Original / Duplicate /
 * Triplicate), Print (Alt+P), Save as PDF (Alt+E), previous / next voucher of the same type (PgUp /
 * PgDn), open the voucher (Alt+V).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { PrintCopy, PrintPageSize } from '../../../shared/types/print.ts';
import { PRINT_COPIES } from '../../../shared/types/print.ts';
import { Screen, useApiQuery, useNav, type ScreenProps } from '../../app/index.ts';
import { Badge, EmptyState, Inline, Stack } from '../../ui/index.ts';
import { PreviewPane, PrintControls, WarningsBanner } from './components.tsx';
import { pageSizeFor, resolveCopies, resolveTemplate, templateForPageSize, toggleCopy } from './lib/layout.ts';
import { cycle } from './lib/screenState.ts';
import { qrsOf, useDocumentQrs, usePrintActions } from './usePrinting.ts';

export interface PrintVoucherParams {
  id: number;
  /** 1–3 or a list of copies; default F12 › Invoice printing › Copies. */
  copies?: number | PrintCopy[];
  template?: InvoiceTemplate;
  pageSize?: PrintPageSize;
  /** Send to the printer as soon as the preview is ready (print after saving a voucher). */
  autoPrint?: boolean;
}

const TEMPLATES: readonly InvoiceTemplate[] = ['modern', 'classic', 'compact'];
const SIZES: readonly PrintPageSize[] = ['A4', 'A5', '80mm'];

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
  const pageSize = pageSizeFor(template, sizeChoice);
  const copies = useMemo(() => (doc ? resolveCopies(doc, copiesChoice) : (['original'] as PrintCopy[])), [doc, copiesChoice]);
  const docs = useMemo(() => (doc ? [doc] : undefined), [doc]);
  const { qrs, ready } = useDocumentQrs(docs);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const actions = usePrintActions(rootRef, { docs: docs ?? [], pageSize, documents: copies.length, ready: ready && !q.isPrevious });

  // Print after save: once, when the document and its QR codes are ready.
  const autoPrinted = useRef(false);
  useEffect(() => {
    if (!params.autoPrint || autoPrinted.current || !doc || !ready || q.isPrevious) return;
    autoPrinted.current = true;
    void actions.print();
  }, [params.autoPrint, doc, ready, q.isPrevious, actions]);

  const setTemplate = (t: InvoiceTemplate): void => {
    setTemplateChoice(t);
    if (t === 'compact') setSizeChoice('80mm');
    else if (sizeChoice === '80mm') setSizeChoice('A4');
  };
  const setPageSize = (s: PrintPageSize): void => {
    setSizeChoice(s);
    setTemplateChoice(templateForPageSize(template, s, doc?.defaultTemplate ?? 'modern'));
  };
  const toggle = (c: PrintCopy): void => setCopiesChoice(toggleCopy(copies, c));
  const go = (target: number | null): void => {
    if (target !== null) setId(target);
  };

  const prevId = doc && !q.isPrevious ? doc.navigation.prevId : null;
  const nextId = doc && !q.isPrevious ? doc.navigation.nextId : null;
  const showCopies = doc ? doc.layout !== 'voucher' || copies.length > 1 : true;

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
            {doc.einvoice ? <Badge tone="success">E-invoice</Badge> : null}
          </Inline>
        ) : undefined
      }
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Alt+P Print · Alt+E Save PDF · PgUp/PgDn Previous/Next voucher · Alt+T Template · Alt+S Paper · Esc Back"
      actions={[
        { key: 'Alt+P', label: 'Print', icon: 'print', primary: true, onClick: () => void actions.print(), disabled: !doc || actions.busy !== null, hint: 'Opens the printer dialog' },
        { key: 'Alt+E', label: 'Save as PDF', icon: 'download', onClick: () => void actions.savePdf(), disabled: !doc || actions.busy !== null },
        { key: 'PageUp', label: 'Previous voucher', icon: 'chevron-left', onClick: () => go(prevId), disabled: prevId === null, group: 'nav' },
        { key: 'PageDown', label: 'Next voucher', icon: 'chevron-right', onClick: () => go(nextId), disabled: nextId === null, group: 'nav' },
        { key: 'Alt+V', label: 'Open voucher', icon: 'eye', onClick: () => nav.push('vouchers.view', { id }), disabled: !doc, group: 'nav' },
        { key: 'Alt+T', label: 'Change template', icon: 'layers', onClick: () => setTemplate(cycle(TEMPLATES, template)), disabled: !doc, group: 'layout' },
        { key: 'Alt+S', label: 'Change paper size', icon: 'file', onClick: () => setPageSize(cycle(SIZES, pageSize)), disabled: !doc, group: 'layout' },
        { key: 'Alt+1', label: 'Original copy', onClick: () => toggle(PRINT_COPIES[0]), disabled: !doc, group: 'copies', hidden: !showCopies },
        { key: 'Alt+2', label: 'Duplicate copy', onClick: () => toggle(PRINT_COPIES[1]), disabled: !doc, group: 'copies', hidden: !showCopies },
        { key: 'Alt+3', label: 'Triplicate copy', onClick: () => toggle(PRINT_COPIES[2]), disabled: !doc, group: 'copies', hidden: !showCopies },
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
            showCopies={showCopies}
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
        </Stack>
      ) : null}
    </Screen>
  );
}
