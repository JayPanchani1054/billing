/**
 * 'print.batch' {ids?} — print several vouchers in one go.
 *  - With `ids`: combined preview of those vouchers (each with its copies), Print all (Alt+P),
 *    Save as one PDF (Alt+E).
 *  - Without: pick vouchers of the period (Alt+F2) by kind; Space / Enter ticks a row, Alt+A ticks
 *    all, Ctrl+A previews the ticked vouchers.
 */
import { useMemo, useRef, useState } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { PrintCopy, PrintPageSize } from '../../../shared/types/print.ts';
import { PRINT_BATCH_MAX, PRINT_COPIES } from '../../../shared/types/print.ts';
import type { VoucherListRow } from '../../../shared/types/vouchers.ts';
import { Screen, useApiQuery, useNav, usePeriod, type ScreenProps } from '../../app/index.ts';
import { Badge, Button, Checkbox, DataTable, EmptyState, Inline, Select, Stack, type Column } from '../../ui/index.ts';
import { PreviewPane, PrintControls, WarningsBanner } from './components.tsx';
import { pageSizeFor, resolveCopies, templateForPageSize, toggleCopy } from './lib/layout.ts';
import { BATCH_KINDS, batchKind, cycle, orderedSelection, toggleAll, toggleId } from './lib/screenState.ts';
import { qrsOf, useDocumentQrs, usePrintActions } from './usePrinting.ts';

export interface PrintBatchParams {
  ids?: number[];
  template?: InvoiceTemplate;
}

export function PrintBatchScreen({ params }: ScreenProps<PrintBatchParams>) {
  const ids = Array.isArray(params.ids) ? params.ids.filter((x) => Number.isInteger(x) && x > 0).slice(0, PRINT_BATCH_MAX) : [];
  return ids.length > 0 ? <BatchPreview ids={ids} initialTemplate={params.template} /> : <BatchPicker />;
}

const TEMPLATES: readonly InvoiceTemplate[] = ['modern', 'classic', 'compact'];
const SIZES: readonly PrintPageSize[] = ['A4', 'A5', '80mm'];

function BatchPreview({ ids, initialTemplate }: { ids: number[]; initialTemplate?: InvoiceTemplate }) {
  const q = useApiQuery('print.batchData', { ids });
  const docs = q.data?.documents;
  const [templateChoice, setTemplateChoice] = useState<InvoiceTemplate | undefined>(initialTemplate);
  const [sizeChoice, setSizeChoice] = useState<PrintPageSize | undefined>();
  const [copiesChoice, setCopiesChoice] = useState<PrintCopy[] | undefined>();
  const first = docs?.[0];
  const template = templateChoice ?? first?.defaultTemplate ?? 'modern';
  const pageSize = pageSizeFor(template, sizeChoice);
  const { qrs, ready } = useDocumentQrs(docs);
  const items = useMemo(() => (docs ?? []).map((doc) => ({ doc, copies: resolveCopies(doc, copiesChoice), qrs: qrsOf(qrs, doc.id) })), [docs, copiesChoice, qrs]);
  const pages = items.reduce((a, it) => a + it.copies.length, 0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const actions = usePrintActions(rootRef, { docs: docs ?? [], pageSize, documents: pages, ready });
  const shownCopies = copiesChoice ?? (first ? resolveCopies(first) : ['original' as PrintCopy]);

  const setTemplate = (t: InvoiceTemplate): void => {
    setTemplateChoice(t);
    if (t === 'compact') setSizeChoice('80mm');
    else if (sizeChoice === '80mm') setSizeChoice('A4');
  };
  const setPageSize = (s: PrintPageSize): void => {
    setSizeChoice(s);
    setTemplateChoice(templateForPageSize(template, s, first?.defaultTemplate ?? 'modern'));
  };
  const toggle = (c: PrintCopy): void => setCopiesChoice(toggleCopy(shownCopies, c));

  const warnings = useMemo(() => {
    const out: string[] = [];
    const missing = q.data?.notFound.length ?? 0;
    if (missing > 0) out.push(`${missing} voucher${missing === 1 ? ' was' : 's were'} deleted since the list was made and will not print.`);
    for (const d of docs ?? []) for (const w of d.warnings) out.push(`${d.title} ${d.number ?? ''}: ${w}`);
    return out;
  }, [docs, q.data]);

  return (
    <Screen
      title="Print Vouchers"
      subtitle={docs ? `${docs.length} document${docs.length === 1 ? '' : 's'} · ${pages} page set${pages === 1 ? '' : 's'}` : undefined}
      icon="print"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Alt+P Print all · Alt+E Save as one PDF · Alt+T Template · Alt+S Paper · Esc Back"
      actions={[
        { key: 'Alt+P', label: 'Print all', icon: 'print', primary: true, onClick: () => void actions.print(), disabled: !docs?.length || actions.busy !== null },
        { key: 'Alt+E', label: 'Save as PDF', icon: 'download', onClick: () => void actions.savePdf(), disabled: !docs?.length || actions.busy !== null },
        { key: 'Alt+T', label: 'Change template', icon: 'layers', onClick: () => setTemplate(cycle(TEMPLATES, template)), group: 'layout' },
        { key: 'Alt+S', label: 'Change paper size', icon: 'file', onClick: () => setPageSize(cycle(SIZES, pageSize)), group: 'layout' },
        { key: 'Alt+1', label: 'Original copy', onClick: () => toggle(PRINT_COPIES[0]), group: 'copies' },
        { key: 'Alt+2', label: 'Duplicate copy', onClick: () => toggle(PRINT_COPIES[1]), group: 'copies' },
        { key: 'Alt+3', label: 'Triplicate copy', onClick: () => toggle(PRINT_COPIES[2]), group: 'copies' },
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
      subtitle={`${label} · ${chosen.length} selected`}
      icon="print"
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Space or Enter tick · Alt+A tick all · Ctrl+A Preview & print · Alt+F2 Period"
      actions={[
        { key: 'Ctrl+A', label: 'Preview & print', icon: 'print', primary: true, onClick: preview, disabled: chosen.length === 0, hint: 'Tick vouchers first' },
        { key: 'Alt+A', label: chosen.length === ids.length && ids.length > 0 ? 'Untick all' : 'Tick all', icon: 'check', onClick: () => setSelected((s) => toggleAll(s, ids)), disabled: ids.length === 0 },
      ]}
      toolbar={
        <Button icon="calendar" onClick={openDialog}>
          {label}
        </Button>
      }
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
