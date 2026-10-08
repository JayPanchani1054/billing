/**
 * 'gst.gstr1.section' {period, tile, section?} — one GSTR-1 table: the aggregate rows (B2CS by state
 * and rate, nil/exempt split, HSN rows, document series) and the vouchers behind it. Tables with
 * several sections (6A, 6B, 9B, 11, 12) show a tab per section (Ctrl+Tab). Enter opens the voucher.
 */
import { useMemo, useState } from 'react';
import type { GstHsnRow, Gstr1B2csRow, Gstr1DocRow, Gstr1DocSeries, Gstr1NilRow, Gstr1SectionId, Gstr1SectionResult } from '../../../shared/types/gst-returns.ts';
import { formatPercent, ReportScreen, useApiQuery, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, DataTable, EmptyState, Inline, Tabs } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp, IssuesPanel } from './components.tsx';
import { docKindLabel, issuesForSections, SECTION_TAB_LABELS, sectionExport, sectionLayout, signedInvoiceValue, tileDef } from './lib/gstr1.ts';
import type { Gstr1TileId } from './lib/gstr1.ts';

export interface Gstr1SectionParams {
  period: string;
  tile: Gstr1TileId;
  section?: Gstr1SectionId;
}

const SECTION_HELP: Partial<Record<Gstr1TileId, string>> = {
  '4A': 'Invoices to registered buyers. The buyer sees these in GSTR-2B and claims credit on them.',
  '4B': 'Invoices on which the buyer pays the tax under reverse charge. This tax is not payable by you.',
  '5': 'Inter-state invoices to unregistered buyers above the B2C large limit, listed one by one.',
  '6A': 'Export invoices — with payment of IGST (refund claim) or under LUT without payment.',
  '6B': 'Supplies to SEZ units and developers, with or without payment of IGST.',
  '6C': 'Deemed exports to registered buyers against notified schemes.',
  '7': 'Other consumer sales summarised by place of supply and rate; credit notes are netted here.',
  '8': 'Nil-rated, exempt and non-GST supplies, split by inter / intra-state and registered / unregistered buyers.',
  '9B': 'Credit and debit notes: to registered buyers (CDNR) and to unregistered buyers for B2C large or exports (CDNUR).',
  '11': 'Tax on advances is not derived from the books — enter it directly on the portal if it applies.',
  '12': 'HSN/SAC-wise summary of everything reported, split into supplies to registered (B2B) and unregistered (B2C) buyers.',
  '13': 'Number series of invoices and notes issued in the period, with cancelled and missing numbers.',
};

export function Gstr1SectionScreen({ params }: ScreenProps<Gstr1SectionParams>) {
  const nav = useNav();
  const def = tileDef(params.tile);
  const sections = def?.sections ?? [];
  const [section, setSection] = useState<Gstr1SectionId | null>(params.section && sections.includes(params.section) ? params.section : (sections[0] ?? null));
  const q = useApiQuery('gst.gstr1.section', { period: params.period, section: section ?? 'b2b' }, { enabled: section !== null, keepPrevious: true });
  const summary = useApiQuery('gst.gstr1.summary', { period: params.period }, { enabled: section !== null });
  const data = q.data && q.data.section === section ? q.data : q.isPrevious ? q.data : undefined;
  const issues = useMemo(() => (summary.data ? issuesForSections(summary.data.issues, sections) : []), [summary.data, sections]);

  if (!def || section === null) {
    return (
      <ReportScreen title="GSTR-1 Table" periodMode="none">
        <EmptyState icon="alert" title="Unknown GSTR-1 table" body="Go back (Esc) and open a table from the GSTR-1 summary." />
      </ReportScreen>
    );
  }

  const openVoucher = (r: { voucherId: number }): void => {
    nav.push('vouchers.view', { id: r.voucherId });
  };
  const cycle = (dir: 1 | -1): void => {
    const i = sections.indexOf(section);
    setSection(sections[(i + dir + sections.length) % sections.length]);
  };
  const actions: ScreenActionItem[] =
    sections.length > 1
      ? [
          { key: 'Alt+Right', label: 'Next part', icon: 'chevron-right', onClick: () => cycle(1), group: 'view' },
          { key: 'Alt+Left', label: 'Previous part', icon: 'chevron-left', onClick: () => cycle(-1), group: 'view' },
        ]
      : [];

  return (
    <ReportScreen
      title={`GSTR-1 · Table ${def.id} ${def.title}`}
      subtitle={data?.period.label ?? summary.data?.period.label}
      periodMode="none"
      actions={actions}
      exportDef={data ? () => sectionExport(data) : undefined}
      loading={q.loading && !data}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open voucher · Alt+←/→ Switch part · Alt+E Export · Alt+P Print · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>
          {SECTION_HELP[def.id] ?? def.help}
          {def.id === '11' || def.id === '13' ? '' : ' Credit notes and other documents that reduce the table show as negative amounts.'}
        </GstHelp>
        {sections.length > 1 ? (
          <Tabs
            aria-label={`Parts of table ${def.id}`}
            variant="pill"
            value={section}
            onChange={(id) => setSection(id as Gstr1SectionId)}
            items={sections.map((s) => ({ id: s, label: SECTION_TAB_LABELS[s] }))}
          />
        ) : null}
        {data ? <SectionBody data={data} onOpen={openVoucher} /> : null}
        {issues.length > 0 ? <IssuesPanel issues={issues} title={`Uncertain transactions in table ${def.id}`} defaultCollapsed /> : null}
      </div>
    </ReportScreen>
  );
}

// ───────────────────────────── Body ─────────────────────────────

function SectionBody({ data, onOpen }: { data: Gstr1SectionResult; onOpen: (r: { voucherId: number }) => void }) {
  const layout = sectionLayout(data.section);
  const docColumns = useDocColumns(data.section);
  if (layout === 'advances') {
    return (
      <EmptyState
        icon="info"
        title="Advances are entered on the portal"
        body="Receipts in the books do not carry a GST rate or place of supply, so table 11 is not prepared here. If you received advances for services, enter the tax on them directly in GSTR-1 on the portal."
      />
    );
  }
  const docsTable = (
    <DataTable<Gstr1DocRow>
      aria-label={`Documents in table ${data.table}`}
      autoFocus={layout === 'documents'}
      columns={docColumns}
      rows={data.rows}
      getRowKey={(r) => `${r.voucherId}`}
      onRowActivate={onOpen}
      empty={<EmptyState size="sm" icon="file" title="No documents in this table" body="Nothing in this period falls in this table. Change the period on the GSTR-1 screen." />}
    />
  );
  if (layout === 'documents') return docsTable;
  return (
    <>
      {layout === 'b2cs' ? <B2csTable rows={data.b2cs ?? []} /> : null}
      {layout === 'nil' ? <NilTable rows={data.nil ?? []} /> : null}
      {layout === 'hsn' ? <HsnTable rows={data.hsn ?? []} height={data.rows.length > 0 ? '38vh' : undefined} /> : null}
      {layout === 'doc' ? <DocSeriesTable rows={data.docs ?? []} /> : null}
      {data.rows.length > 0 ? (
        <>
          <h2 className="bx-gst-section-title">Documents behind these figures</h2>
          {docsTable}
        </>
      ) : null}
    </>
  );
}

function amount<T>(key: string, header: string, width = 130): Column<T> {
  return { key, header, kind: 'amount', width, total: true, sortable: true };
}

function useDocColumns(section: Gstr1SectionId): Column<Gstr1DocRow>[] {
  return useMemo<Column<Gstr1DocRow>[]>(() => {
    const isNote = section === 'cdnr' || section === 'cdnur';
    const isExport = section === 'exp_wp' || section === 'exp_wop';
    const cols: Column<Gstr1DocRow>[] = [
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      {
        key: 'number',
        header: 'Number',
        width: 170,
        sortable: true,
        value: (r) => r.number ?? '',
        render: (r) => (
          <Inline gap={1} wrap={false}>
            <span className="bx-truncate">{r.number ?? '(no number)'}</span>
            {r.noteType ? (
              <Badge size="sm" tone={r.noteType === 'C' ? 'neutral' : 'info'}>
                {docKindLabel(r)}
              </Badge>
            ) : null}
            {r.sign < 0 && !r.noteType ? (
              <Badge size="sm" tone="neutral">
                Reduces
              </Badge>
            ) : null}
          </Inline>
        ),
      },
      { key: 'partyName', header: 'Party', minWidth: 180, sortable: true, value: (r) => r.partyName ?? '' },
      { key: 'gstin', header: 'GSTIN', width: 160, value: (r) => r.gstin ?? '', hidden: section === 'b2cl' || section === 'b2cs' || section === 'exp_wp' || section === 'exp_wop' },
      { key: 'pos', header: 'Place of supply', width: 150, value: (r) => (r.pos ? `${r.pos}-${r.posName}` : ''), hidden: isExport },
      {
        key: 'original',
        header: 'Original invoice',
        width: 150,
        hidden: !isNote,
        value: (r) => [r.originalInvoiceNo, r.originalInvoiceDate].filter(Boolean).join(' · '),
      },
      {
        key: 'shippingBill',
        header: 'Shipping bill',
        width: 170,
        hidden: !isExport,
        value: (r) => (r.shippingBill ? [r.shippingBill.number, r.shippingBill.portCode].filter(Boolean).join(' · ') : ''),
      },
      { key: 'rates', header: 'Rates', width: 90, value: (r) => r.rates.map((x) => formatPercent(x.rate)).join(', ') },
      { key: 'invoiceValue', header: 'Invoice value', kind: 'amount', width: 130, sortable: true, total: true, value: signedInvoiceValue },
      amount<Gstr1DocRow>('taxable', 'Taxable value', 140),
      amount<Gstr1DocRow>('igst', 'IGST', 120),
      amount<Gstr1DocRow>('cgst', 'CGST', 120),
      amount<Gstr1DocRow>('sgst', 'SGST/UTGST', 120),
      amount<Gstr1DocRow>('cess', 'Cess', 100),
    ];
    return cols;
  }, [section]);
}

function B2csTable({ rows }: { rows: readonly Gstr1B2csRow[] }) {
  const columns = useMemo<Column<Gstr1B2csRow>[]>(
    () => [
      { key: 'pos', header: 'Place of supply', minWidth: 180, sortable: true, value: (r) => `${r.pos}-${r.posName}` },
      { key: 'supplyType', header: 'Supply', width: 110, value: (r) => (r.supplyType === 'INTER' ? 'Inter-state' : 'Intra-state') },
      { key: 'rate', header: 'Rate', width: 80, align: 'right', value: (r) => r.rate, render: (r) => formatPercent(r.rate), sortable: true },
      { key: 'documents', header: 'Documents', kind: 'number', width: 100 },
      amount<Gstr1B2csRow>('taxable', 'Taxable value', 140),
      amount<Gstr1B2csRow>('igst', 'IGST', 120),
      amount<Gstr1B2csRow>('cgst', 'CGST', 120),
      amount<Gstr1B2csRow>('sgst', 'SGST/UTGST', 120),
      amount<Gstr1B2csRow>('cess', 'Cess', 100),
    ],
    [],
  );
  return (
    <DataTable<Gstr1B2csRow>
      aria-label="B2C others by place of supply and rate"
      autoFocus
      height="38vh"
      columns={columns}
      rows={rows}
      getRowKey={(r) => `${r.pos}:${r.rate}:${r.supplyType}`}
      empty={<EmptyState size="sm" title="No B2C others in this period" />}
    />
  );
}

function NilTable({ rows }: { rows: readonly Gstr1NilRow[] }) {
  const columns = useMemo<Column<Gstr1NilRow>[]>(
    () => [
      { key: 'label', header: 'Description', minWidth: 260 },
      amount<Gstr1NilRow>('nil', 'Nil rated', 150),
      amount<Gstr1NilRow>('exempt', 'Exempted', 150),
      amount<Gstr1NilRow>('nonGst', 'Non-GST', 150),
    ],
    [],
  );
  return (
    <DataTable<Gstr1NilRow>
      aria-label="Nil rated, exempted and non-GST supplies"
      autoFocus
      height="38vh"
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.supplyType}
      empty={<EmptyState size="sm" title="No nil-rated, exempt or non-GST supplies" />}
    />
  );
}

export function HsnTable({ rows, autoFocus = true, height, onActivate }: { rows: readonly GstHsnRow[]; autoFocus?: boolean; height?: string | number; onActivate?: (r: GstHsnRow) => void }) {
  const columns = useMemo<Column<GstHsnRow>[]>(
    () => [
      { key: 'hsn', header: 'HSN/SAC', width: 110, sortable: true, render: (r) => r.hsn || <Badge tone="danger" size="sm">Missing</Badge> },
      { key: 'description', header: 'Description', minWidth: 180 },
      { key: 'uqc', header: 'UQC', width: 70 },
      { key: 'qty', header: 'Quantity', kind: 'qty', decimals: 3, width: 120, blankZero: true },
      { key: 'rate', header: 'Rate', width: 80, align: 'right', value: (r) => r.rate, render: (r) => formatPercent(r.rate), sortable: true },
      amount<GstHsnRow>('taxable', 'Taxable value', 140),
      amount<GstHsnRow>('igst', 'IGST', 120),
      amount<GstHsnRow>('cgst', 'CGST', 120),
      amount<GstHsnRow>('sgst', 'SGST/UTGST', 120),
      amount<GstHsnRow>('cess', 'Cess', 100),
      amount<GstHsnRow>('total', 'Total value', 140),
    ],
    [],
  );
  return (
    <DataTable<GstHsnRow>
      aria-label="HSN summary"
      autoFocus={autoFocus}
      height={height}
      columns={columns}
      rows={rows}
      getRowKey={(r, i) => `${r.hsn}:${r.uqc}:${r.rate}:${i}`}
      onRowActivate={onActivate}
      empty={<EmptyState size="sm" title="No HSN rows in this period" />}
    />
  );
}

function DocSeriesTable({ rows }: { rows: readonly Gstr1DocSeries[] }) {
  const columns = useMemo<Column<Gstr1DocSeries>[]>(
    () => [
      { key: 'docTypeLabel', header: 'Nature of document', minWidth: 200 },
      { key: 'voucherTypeName', header: 'Voucher type', width: 160 },
      { key: 'from', header: 'From', width: 150 },
      { key: 'to', header: 'To', width: 150 },
      { key: 'total', header: 'Total', kind: 'number', width: 90, total: true },
      { key: 'cancelled', header: 'Cancelled', kind: 'number', width: 100, total: true },
      { key: 'missing', header: 'of which missing', kind: 'number', width: 130, render: (r) => (r.missing > 0 ? <Badge tone="warning" size="sm">{r.missing}</Badge> : '') },
      { key: 'net', header: 'Net issued', kind: 'number', width: 110, total: true },
    ],
    [],
  );
  return (
    <DataTable<Gstr1DocSeries>
      aria-label="Documents issued"
      autoFocus
      columns={columns}
      rows={rows}
      getRowKey={(r, i) => `${r.voucherTypeId}:${r.from}:${i}`}
      empty={<EmptyState size="sm" title="No documents issued in this period" />}
    />
  );
}
