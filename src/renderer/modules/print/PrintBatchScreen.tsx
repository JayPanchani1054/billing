/**
 * 'print.batch' {ids?} — print several vouchers in one go.
 *  - With `ids`: combined preview of those vouchers (each with its copies), Print all (Alt+P),
 *    Save as one PDF (Alt+E). (2.0) Each document prints with its saved print layouts (company ‹ voucher
 *    type); hidden statutory particulars are listed with the other warnings.
 *  - Without: pick vouchers of the period (Alt+F2) by kind; Space / Enter ticks a row, Alt+A ticks
 *    all, Ctrl+A previews the ticked vouchers.
 *
 * 2.1 (SPEC-21 §1.11, D3): Template · Paper · Copies on one line, the printer under More ("Printer: …",
 * no key); "Before you print" is one line with one entry per warning text ("Sales 33, Sales 34: …"); the
 * picker's period is the context run's token (click or Alt+F2), not a second button.
 */
import { useMemo, useRef, useState } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { PrintCopy, PrintPageSize } from '../../../shared/types/print.ts';
import { PRINT_BATCH_MAX, PRINT_COPIES, PRINT_PAGE_SIZES } from '../../../shared/types/print.ts';
import type { VoucherListRow } from '../../../shared/types/vouchers.ts';
import { layoutWarnings } from '../../../shared/printLayout.ts';
import { Screen, useApiQuery, useNav, usePeriod, type ScreenProps } from '../../app/index.ts';
import { Badge, Checkbox, DataTable, EmptyState, Inline, NO_KEY, Select, Stack, type Column } from '../../ui/index.ts';
import { PreviewPane, PrintControls, PrinterDialog, WarningsBanner } from './components.tsx';
import { mergeDocWarnings, printerItemLabel } from './lib/calm.ts';
import { isRoll, pageSizeFor, resolveCopies, templateForPageSize, toggleCopy } from './lib/layout.ts';
import { layoutDoc, pageNumbersShown, resolveDocLayout } from './lib/layoutParts.ts';
import { BATCH_KINDS, batchKind, cycle, orderedSelection, toggleAll, toggleId } from './lib/screenState.ts';
import { qrsOf, useDocumentQrs, usePrintActions, usePrinterChoice } from './usePrinting.ts';

export interface PrintBatchParams {
  ids?: number[];
  template?: InvoiceTemplate;
}

export function PrintBatchScreen({ params }: ScreenProps<PrintBatchParams>) {
  const ids = Array.isArray(params.ids) ? params.ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, PRINT_BATCH_MAX) : [];
  return ids.length > 0 ? <BatchPreview ids={ids} initialTemplate={params.template} /> : <BatchPicker />;
}

const TEMPLATES: readonly InvoiceTemplate[] = ['modern', 'classic', 'compact'];
const SIZES: readonly PrintPageSize[] = PRINT_PAGE_SIZES;

function BatchPreview({ ids, initialTemplate }: { ids: number[]; initialTemplate?: InvoiceTemplate }) {
  const q = useApiQuery('print.batchData', { ids });
  const docs = q.data?.documents;
  const [templateChoice, setTemplateChoice] = useState<InvoiceTemplate | undefined>(initialTemplate);
  const [sizeChoice, setSizeChoice] = useState<PrintPageSize | undefined>();
  const [copiesChoice, setCopiesChoice] = useState<PrintCopy[] | undefined>();
  const first = docs?.[0];
  const template = templateChoice ?? first?.defaultTemplate ?? 'modern';
  const pageSize = pageSizeFor(template, sizeChoice, first?.options);
  const printer = usePrinterChoice(isRoll(pageSize) ? 'roll' : 'sheet');
  const { qrs, ready } = useDocumentQrs(docs);
  const items = useMemo(() => (docs ?? []).map((doc) => ({ doc, copies: resolveCopies(doc, copiesChoice), qrs: qrsOf(qrs, doc.id) })), [docs, copiesChoice, qrs]);
  const pages = items.reduce((a, it) => a + it.copies.length, 0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pageNumbers = useMemo(() => pageNumbersShown((docs ?? []).map((d) => layoutDoc(d))), [docs]);
  const actions = usePrintActions(rootRef, { docs: docs ?? [], pageSize, documents: pages, ready, deviceName: printer.printer || undefined, pageNumbers });
  const shownCopies = copiesChoice ?? (first ? resolveCopies(first) : ['original' as PrintCopy]);

  const setTemplate = (t: InvoiceTemplate): void => {
    setTemplateChoice(t);
    if (t === 'compact' ? sizeChoice !== undefined && !isRoll(sizeChoice) : sizeChoice !== undefined && isRoll(sizeChoice)) setSizeChoice(undefined);
  };
  const setPageSize = (s: PrintPageSize): void => {
    setSizeChoice(s);
    setTemplateChoice(templateForPageSize(template, s, first?.defaultTemplate ?? 'modern'));
  };
  const toggle = (c: PrintCopy): void => setCopiesChoice(toggleCopy(shownCopies, c));
  const [choosingPrinter, setChoosingPrinter] = useState(false);

  const warnings = useMemo(() => {
    const out: string[] = [];
    const missing = q.data?.notFound.length ?? 0;
    if (missing > 0) out.push(`${missing} voucher${missing === 1 ? ' was' : 's were'} deleted since the list was made and will not print.`);
    // One entry per warning text, naming the documents it applies to (one line, not one per document).
    out.push(...mergeDocWarnings((docs ?? []).map((d) => ({ label: `${d.title} ${d.number ?? ''}`, warnings: [...d.warnings, ...layoutWarnings(d, resolveDocLayout(d))] }))));
    return out;
  }, [docs, q.data]);

  return (
    <Screen
      title="Print Vouchers"
      subtitle={docs ? `${docs.length} document${docs.length === 1 ? '' : 's'} · ${pages} page set${pages === 1 ? '' : 's'}` : undefined}
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Alt+P Print All · Alt+E Save as One PDF · Alt+T Template · Alt+S Paper · Ctrl+1/2/3 Copies · Esc Back"
      actions={[
        { key: 'Alt+P', label: 'Print all', icon: 'print', primary: true, onClick: () => void actions.print(), disabled: !docs?.length || actions.busy !== null },
        { key: 'Alt+E', label: 'Save as PDF', icon: 'download', onClick: () => void actions.savePdf(), disabled: !docs?.length || actions.busy !== null },
        { key: 'Alt+T', label: 'Change template', icon: 'layers', onClick: () => setTemplate(cycle(TEMPLATES, template)), group: 'layout' },
        { key: 'Alt+S', label: 'Change paper size', icon: 'file', onClick: () => setPageSize(cycle(SIZES, pageSize)), group: 'layout' },
        { key: 'Ctrl+1', label: 'Original copy', onClick: () => toggle(PRINT_COPIES[0]), group: 'copies' },
        { key: 'Ctrl+2', label: 'Duplicate copy', onClick: () => toggle(PRINT_COPIES[1]), group: 'copies' },
        { key: 'Ctrl+3', label: 'Triplicate copy', onClick: () => toggle(PRINT_COPIES[2]), group: 'copies' },
        { key: NO_KEY, label: printerItemLabel(printer.printer, printer.printers, isRoll(pageSize)), onClick: () => setChoosingPrinter(true), disabled: !docs?.length, group: 'copies', hint: 'Print directly to a printer, without the printer dialog' },
      ]}
    >
      {docs && docs.length === 0 ? (
        <EmptyState icon="file" title="Nothing to print" body="The selected vouchers no longer exist. Press Esc to go back." />
      ) : docs && first ? (
        <Stack gap={3}>
          <PrintControls
            template={template}
            onTemplate={setTemplate}
            pageSize={pageSize}
            onPageSize={setPageSize}
            copies={shownCopies}
            onCopies={setCopiesChoice}
            copyLabels={{ original: 'Original', duplicate: 'Duplicate', triplicate: 'Triplicate' }}
          />
          <WarningsBanner warnings={warnings} />
          {choosingPrinter ? <PrinterDialog printer={printer} roll={isRoll(pageSize)} onClose={() => setChoosingPrinter(false)} /> : null}
          <PreviewPane items={items} template={template} pageSize={pageSize} rootRef={rootRef} preparing={!ready} label="Print preview of the selected vouchers" />
        </Stack>
      ) : null}
    </Screen>
  );
}

function BatchPicker() {
  const nav = useNav();
  const { from, to, label, openDialog } = usePeriod();
  const [kind, setKind] = useState<string>('sales');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const k = batchKind(kind);
  const q = useApiQuery(
    'vouchers.list',
    { from, to, baseTypes: k.baseTypes.length > 0 ? k.baseTypes : undefined, includeCancelled: true, sort: 'date_asc', limit: 1000 },
    { keepPrevious: true },
  );
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const chosen = orderedSelection(selected, ids);

  const columns = useMemo<Column<VoucherListRow>[]>(
    () => [
      {
        key: 'pick',
        header: 'Print',
        headerLabel: 'Selected for printing',
        width: 64,
        render: (r) => <Checkbox checked={selected.has(r.id)} aria-label={`Print ${r.voucherTypeName} ${r.number ?? ''}`} tabIndex={-1} onChange={() => setSelected((s) => toggleId(s, r.id))} />,
      },
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'voucherTypeName', header: 'Type', width: 140 },
      { key: 'number', header: 'No.', width: 110, value: (r) => r.number ?? '' },
      {
        key: 'partyName',
        header: 'Party',
        render: (r) => (
          <Inline gap={2}>
            <span>{r.partyName ?? ''}</span>
            {r.isCancelled ? <Badge tone="danger" size="sm">Cancelled</Badge> : null}
            {r.isOptional ? <Badge tone="warning" size="sm">Optional</Badge> : null}
          </Inline>
        ),
      },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140 },
    ],
    [selected],
  );

  const preview = (): void => {
    if (chosen.length === 0) return;
    nav.push('print.batch', { ids: chosen });
  };

  return (
    <Screen
      title="Print Vouchers"
      subtitle={
        <>
          <button type="button" className="bx-report__token" onClick={openDialog} title="Change period · Alt+F2" aria-keyshortcuts="Alt+F2">
            {label}
          </button>
          {` · ${chosen.length} selected`}
        </>
      }
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Space or Enter Tick · Alt+A Tick all · Ctrl+A Preview & print · Alt+F2 Period"
      actions={[
        { key: 'Ctrl+A', label: 'Preview & print', icon: 'print', primary: true, onClick: preview, disabled: chosen.length === 0, hint: 'Tick vouchers first' },
        { key: 'Alt+A', label: chosen.length === ids.length && ids.length > 0 ? 'Untick all' : 'Tick all', icon: 'check', onClick: () => setSelected((s) => toggleAll(s, ids)), disabled: ids.length === 0 },
      ]}
    >
      <Stack gap={3}>
        <Inline gap={3} align="end">
          <Select
            aria-label="Vouchers to list"
            value={kind}
            onChange={(v: string) => {
              setKind(v);
              setSelected(new Set());
            }}
            options={BATCH_KINDS.map((o) => ({ value: o.value, label: o.label }))}
          />
          {ids.length >= 1000 ? <span>Showing the first 1,000 vouchers — narrow the period to see the rest.</span> : null}
        </Inline>
        <DataTable
          aria-label="Vouchers to print"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          loading={q.loading}
          selectedKey={cursor}
          onSelect={(key) => setCursor(key)}
          onRowActivate={(r) => setSelected((s) => toggleId(s, r.id))}
          onRowKeyDown={(e, r) => {
            if (r && e.key === ' ' && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              setSelected((s) => toggleId(s, r.id));
            }
          }}
          empty={<EmptyState icon="file" title="No vouchers in this period" body="Change the period (Alt+F2) or the kind of vouchers above." />}
        />
      </Stack>
    </Screen>
  );
}
