/**
 * GST registers and analysis for the reporting period (Alt+F2):
 *   'gst.hsn'        {direction?}  HSN/SAC summary of outward or inward supplies
 *   'gst.register'   {kind?}       GST sales / purchase register (one row per document, signed)
 *   'gst.itc'        —             input tax credit by supplier (by type of credit: More ▾)
 *   'gst.exceptions' {from?, to?}  every uncertain transaction with what is wrong and how to fix it
 * Enter on a document row opens the voucher.
 *
 * 2.1 (SPEC-21 §5, WP-J2): each report has its one graph (lib/registerCharts.ts) above the table —
 * taxable value by rate, by HSN/SAC (inline bars for a short table), eligible ITC by supplier,
 * problems by type — and its answer in words on the toolbar row; the help sentences moved to
 * More ▾ › About this report, the "Totals by rate" and "By type of credit" tables to More ▾ drawers.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { GstHsnRow, GstIssue, GstItcResult, GstItcSupplierRow, GstRateSplit, GstRegisterRow, ItcEligibility } from '../../../shared/types/gst-returns.ts';
import { formatPercent, ReportScreen, useApiQuery, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, Drawer, EmptyState, Inline, NO_KEY, SegmentedControl, Select, StatLine, Tabs } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { inlineBars } from '../../ui/lib/chartSpec.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { SeverityBadge, useGstRange } from './components.tsx';
import { alterVoucherLink, codesPresent, countIssues, fixLinks, issueKey, issueVoucherLink, ISSUE_CODE_LABELS, masterLink } from './lib/issues.ts';
import { periodKeyForRange } from './lib/periods.ts';
import { exceptionsChart, exceptionsStat, hsnChart, itcChart, itcStat, rateChart } from './lib/registerCharts.ts';
import { exceptionsExport, hsnExport, itcExport, registerExport, sumTax } from './lib/reports.ts';

function amount<T>(key: string, header: string, width = 130, value?: (r: T) => number): Column<T> {
  return { key, header, kind: 'amount', width, total: true, sortable: true, value };
}

/** A keyless More ▾ item that opens a drawer (a secondary table of the report). */
function drawerItem(label: string, open: () => void, disabled: boolean): ScreenActionItem {
  return { key: NO_KEY, label, onClick: open, group: 'view', disabled };
}

// ───────────────────────────── HSN summary ─────────────────────────────

export interface HsnParams {
  direction?: 'outward' | 'inward';
}

function hsnColumns(inline: boolean): Column<GstHsnRow>[] {
  return [
    { key: 'hsn', header: 'HSN/SAC', width: 110, sortable: true, render: (r) => r.hsn || <Badge tone="danger" size="sm">Missing</Badge> },
    { key: 'description', header: 'Description', minWidth: 180 },
    { key: 'uqc', header: 'UQC', width: 70 },
    { key: 'qty', header: 'Quantity', kind: 'qty', decimals: 3, width: 120, blankZero: true },
    { key: 'rate', header: 'Rate', width: 80, align: 'right', value: (r) => r.rate, render: (r) => formatPercent(r.rate), sortable: true },
    { ...amount<GstHsnRow>('taxable', 'Taxable value', 140), ...(inline ? { bar: { value: (r: GstHsnRow) => r.taxable, slot: 1 as const } } : {}) },
    amount<GstHsnRow>('igst', 'IGST', 120),
    amount<GstHsnRow>('cgst', 'CGST', 120),
    amount<GstHsnRow>('sgst', 'SGST/UTGST', 120),
    amount<GstHsnRow>('cess', 'Cess', 100),
    amount<GstHsnRow>('total', 'Total value', 140),
  ];
}

export function HsnSummaryScreen({ params }: ScreenProps<HsnParams>) {
  const { from, to, override } = useGstRange(undefined);
  const [direction, setDirection] = useState<'outward' | 'inward'>(params?.direction === 'inward' ? 'inward' : 'outward');
  const q = useApiQuery('gst.hsnSummary', { from, to, direction }, { keepPrevious: true });
  const rows = q.data?.rows ?? [];
  const spec = useMemo(() => (q.data ? hsnChart(q.data) : null), [q.data]);
  const inline = inlineBars(spec, rows.length);
  const columns = useMemo(() => hsnColumns(inline), [inline]);
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Outward (sales)', onClick: () => setDirection('outward'), disabled: direction === 'outward', group: 'view' },
    { key: 'Ctrl+2', label: 'Inward (purchases)', onClick: () => setDirection('inward'), disabled: direction === 'inward', group: 'view' },
  ];
  return (
    <ReportScreen
      title="HSN/SAC Summary"
      period={override}
      filters={
        <SegmentedControl
          aria-label="Direction"
          size="sm"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'outward', label: 'Outward' },
            { value: 'inward', label: 'Inward' },
          ]}
        />
      }
      actions={actions}
      graph={reportGraph(spec, { inline })}
      about={<p>Totals by HSN/SAC code, unit and rate — the same figures as GSTR-1 table 12 (outward) and GSTR-9 tables 17 / 18. Credit notes and purchase returns reduce them.</p>}
      exportDef={q.data ? () => ({ ...hsnExport(q.data?.rows ?? [], q.data?.totals), subtitle: direction === 'outward' ? 'Outward supplies' : 'Inward supplies' }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Ctrl+1 Outward · Ctrl+2 Inward · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <DataTable
        aria-label="HSN summary"
        autoFocus
        hideEmptyColumns
        columns={columns}
        rows={rows}
        getRowKey={(r, i) => `${r.hsn}:${r.uqc}:${r.rate}:${i}`}
        empty={<EmptyState size="sm" title="No HSN rows in this period" body="Change the period with Alt+F2." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Register ─────────────────────────────

export interface RegisterParams {
  kind?: 'sales' | 'purchase';
  from?: string;
  to?: string;
}

export function GstRegisterScreen({ params }: ScreenProps<RegisterParams>) {
  const nav = useNav();
  const { from, to, override } = useGstRange(params);
  const [kind, setKind] = useState<'sales' | 'purchase'>(params?.kind === 'purchase' ? 'purchase' : 'sales');
  const [ratesOpen, setRatesOpen] = useState(false);
  const q = useApiQuery('gst.register', { from, to, kind }, { keepPrevious: true });
  const purchase = kind === 'purchase';
  const columns = useMemo<Column<GstRegisterRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      {
        key: 'number',
        header: 'Voucher no.',
        width: 160,
        sortable: true,
        value: (r) => r.number ?? '',
        render: (r) => (
          <Inline gap={1} wrap={false}>
            <span className="bx-truncate">{r.number ?? '(no number)'}</span>
            {r.sign < 0 ? (
              <Badge size="sm" tone="neutral">
                {purchase ? 'Return' : 'Credit note'}
              </Badge>
            ) : null}
          </Inline>
        ),
      },
      { key: 'supplierInvoiceNo', header: 'Supplier inv. no.', width: 140, hidden: !purchase, value: (r) => r.supplierInvoiceNo ?? '' },
      { key: 'supplierInvoiceDate', header: 'Supplier inv. date', kind: 'date', width: 120, hidden: !purchase, value: (r) => r.supplierInvoiceDate ?? '' },
      { key: 'partyName', header: purchase ? 'Supplier' : 'Party', minWidth: 180, sortable: true, value: (r) => r.partyName ?? '' },
      { key: 'gstin', header: 'GSTIN', width: 160, value: (r) => r.gstin ?? '' },
      { key: 'state', header: purchase ? 'Supplier state' : 'Place of supply', width: 140, value: (r) => (r.stateName ? `${r.stateCode}-${r.stateName}` : r.stateCode) },
      {
        key: 'natureLabel',
        header: 'Type',
        width: 140,
        sortable: true,
        render: (r) => (
          <Inline gap={1} wrap={false}>
            <span className="bx-truncate">{r.natureLabel}</span>
            {r.reverseCharge ? (
              <Badge size="sm" tone="info">
                RCM
              </Badge>
            ) : null}
          </Inline>
        ),
      },
      { key: 'rates', header: 'Rates', width: 90, value: (r) => r.rates.map((x) => formatPercent(x.rate)).join(', ') },
      amount<GstRegisterRow>('taxable', 'Taxable value', 140),
      amount<GstRegisterRow>('igst', 'IGST', 120),
      amount<GstRegisterRow>('cgst', 'CGST', 120),
      amount<GstRegisterRow>('sgst', 'SGST/UTGST', 120),
      amount<GstRegisterRow>('cess', 'Cess', 100),
      { ...amount<GstRegisterRow>('nonTaxable', 'Exempt / nil / non-GST', 140), blankZero: true },
      amount<GstRegisterRow>('invoiceValue', 'Invoice value', 140),
    ],
    [purchase],
  );
  const rateColumns = useMemo<Column<GstRateSplit>[]>(
    () => [
      { key: 'rate', header: 'Rate', width: 90, align: 'right', render: (r) => formatPercent(r.rate) },
      amount<GstRateSplit>('taxable', 'Taxable value', 150),
      amount<GstRateSplit>('igst', 'IGST', 130),
      amount<GstRateSplit>('cgst', 'CGST', 130),
      amount<GstRateSplit>('sgst', 'SGST/UTGST', 130),
      amount<GstRateSplit>('cess', 'Cess', 110),
    ],
    [],
  );
  const spec = useMemo(() => (q.data ? rateChart(q.data) : null), [q.data]);
  const rateTotals = q.data?.rateTotals ?? [];
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Sales register', onClick: () => setKind('sales'), disabled: kind === 'sales', group: 'view' },
    { key: 'Ctrl+2', label: 'Purchase register', onClick: () => setKind('purchase'), disabled: kind === 'purchase', group: 'view' },
    drawerItem('Totals by rate', () => setRatesOpen(true), rateTotals.length === 0),
  ];
  const rows = q.data?.rows ?? [];
  return (
    <>
      <ReportScreen
        title="GST Register"
        period={override}
        filters={
          <Tabs
            aria-label="Register"
            value={kind}
            onChange={(id) => setKind(id === 'purchase' ? 'purchase' : 'sales')}
            items={[
              { id: 'sales', label: 'Sales' },
              { id: 'purchase', label: 'Purchases' },
            ]}
          />
        }
        actions={actions}
        graph={reportGraph(spec)}
        about={
          <p>
            {purchase
              ? 'Every purchase with its GST, one line per document. Purchase returns are shown as negative amounts.'
              : 'Every sale with its GST, one line per document. Credit notes are shown as negative amounts.'}{' '}
            The graph adds up the taxable value by GST rate; the same totals, tax head by head, are under More › Totals by rate.
          </p>
        }
        exportDef={q.data ? () => ({ ...registerExport(q.data!), title: purchase ? 'GST Purchase Register' : 'GST Sales Register' }) : undefined}
        loading={q.loading}
        refreshing={q.refreshing}
        error={q.error}
        onRetry={() => void q.refetch()}
        hint="Enter Open voucher · Ctrl+1 Sales · Ctrl+2 Purchases · Alt+F2 Period · Alt+E Export · Esc Back"
      >
        <DataTable
          aria-label={purchase ? 'GST purchase register' : 'GST sales register'}
          autoFocus
          hideEmptyColumns
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.voucherId)}
          onRowActivate={(r) => nav.push('vouchers.view', { id: r.voucherId })}
          empty={
            <EmptyState
              icon="file"
              title={purchase ? 'No purchases with GST in this period' : 'No sales with GST in this period'}
              body={`Change the period with Alt+F2, or record one with ${purchase ? 'F9' : 'F8'}.`}
            />
          }
        />
      </ReportScreen>
      <Drawer open={ratesOpen} onClose={() => setRatesOpen(false)} title="Totals by rate" description={purchase ? 'Purchases' : 'Sales'} size="lg">
        <DataTable
          aria-label="Totals by rate"
          autoFocus
          hideEmptyColumns
          columns={rateColumns}
          rows={rateTotals}
          getRowKey={(r) => `${r.rate}:${r.cessRate}`}
          empty={<EmptyState size="sm" title="No GST documents in this period" />}
        />
      </Drawer>
    </>
  );
}

// ───────────────────────────── ITC ─────────────────────────────

/** A row of More ▾ › By type of credit. */
type ItcTypeRow = GstItcResult['byEligibility'][number];

const ELIGIBILITY_HELP: Readonly<Record<ItcEligibility, string>> = {
  inputs: 'Goods bought for business',
  capital_goods: 'Machinery and equipment',
  input_services: 'Services used for business',
  ineligible: 'Blocked under s.17(5) — not claimable',
};

export function ItcScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const nav = useNav();
  const { from, to, override } = useGstRange(params);
  const [typesOpen, setTypesOpen] = useState(false);
  const q = useApiQuery('gst.itc', { from, to }, { keepPrevious: true });
  const columns = useMemo<Column<GstItcSupplierRow>[]>(
    () => [
      { key: 'partyName', header: 'Supplier', minWidth: 200, sortable: true },
      { key: 'gstin', header: 'GSTIN', width: 160, value: (r) => r.gstin ?? '' },
      { key: 'documents', header: 'Docs', kind: 'number', width: 70, total: true },
      amount<GstItcSupplierRow>('taxable', 'Taxable value', 140),
      amount<GstItcSupplierRow>('eIgst', 'Eligible IGST', 130, (r) => r.eligible.igst),
      amount<GstItcSupplierRow>('eCgst', 'Eligible CGST', 130, (r) => r.eligible.cgst),
      amount<GstItcSupplierRow>('eSgst', 'Eligible SGST', 130, (r) => r.eligible.sgst),
      amount<GstItcSupplierRow>('eCess', 'Eligible cess', 110, (r) => r.eligible.cess),
      // No total: the toolbar row says the blocked credit ("Blocked ₹y", D24 — never twice).
      { ...amount<GstItcSupplierRow>('blocked', 'Blocked', 120, (r) => sumTax(r.ineligible)), total: false, blankZero: true },
      { ...amount<GstItcSupplierRow>('rcm', 'Reverse charge', 130, (r) => sumTax(r.reverseCharge)), blankZero: true },
      { ...amount<GstItcSupplierRow>('imports', 'On imports', 120, (r) => sumTax(r.imports)), blankZero: true },
    ],
    [],
  );
  const openLedger = (r: GstItcSupplierRow): void => {
    if (r.partyLedgerId) nav.push('reports.ledger', { ledgerId: r.partyLedgerId, from, to });
  };
  const spec = useMemo(() => (q.data ? itcChart(q.data, openLedger) : null), [q.data, from, to]);
  const stat = q.data ? itcStat(q.data) : [];
  const byType = q.data?.byEligibility ?? [];
  const typeColumns = useMemo<Column<ItcTypeRow>[]>(
    () => [
      { key: 'label', header: 'Type', minWidth: 180, title: (r) => ELIGIBILITY_HELP[r.eligibility] },
      amount<ItcTypeRow>('taxable', 'Taxable value', 150),
      amount<ItcTypeRow>('igst', 'IGST', 130, (r) => r.tax.igst),
      amount<ItcTypeRow>('cgst', 'CGST', 130, (r) => r.tax.cgst),
      amount<ItcTypeRow>('sgst', 'SGST/UTGST', 130, (r) => r.tax.sgst),
      amount<ItcTypeRow>('cess', 'Cess', 110, (r) => r.tax.cess),
    ],
    [],
  );
  const actions: ScreenActionItem[] = [drawerItem('By type of credit', () => setTypesOpen(true), byType.length === 0)];
  return (
    <>
      <ReportScreen
        title="Input Tax Credit"
        period={override}
        actions={actions}
        graph={reportGraph(spec)}
        stat={stat.length ? <StatLine items={stat} /> : undefined}
        about={
          <p>
            GST you paid on purchases and can set off against the tax on your sales, net of purchase returns. Eligible ITC here equals GSTR-3B 4(C) before your own
            entries. Compare it with GSTR-2B in GST reconciliation. The credit by type (inputs, capital goods, input services, blocked) is under More › By type of credit.
          </p>
        }
        exportDef={q.data ? () => itcExport(q.data!) : undefined}
        loading={q.loading}
        refreshing={q.refreshing}
        error={q.error}
        onRetry={() => void q.refetch()}
        hint="Enter Open supplier ledger · Alt+F2 Period · Alt+E Export · Esc Back"
      >
        <DataTable
          aria-label="Input tax credit by supplier"
          autoFocus
          hideEmptyColumns
          columns={columns}
          rows={q.data?.rows ?? []}
          getRowKey={(r, i) => `${r.partyLedgerId ?? r.gstin ?? r.partyName}:${i}`}
          onRowActivate={openLedger}
          empty={<EmptyState icon="file" title="No purchases with GST in this period" body="Change the period with Alt+F2, or record a purchase with F9." />}
        />
      </ReportScreen>
      <Drawer open={typesOpen} onClose={() => setTypesOpen(false)} title="By type of credit" size="lg">
        <DataTable
          aria-label="Input tax credit by type"
          autoFocus
          hideEmptyColumns
          virtualize={false}
          columns={typeColumns}
          rows={byType}
          getRowKey={(r) => r.eligibility}
          empty={<EmptyState size="sm" title="No purchases with GST in this period" />}
        />
      </Drawer>
    </>
  );
}

// ───────────────────────────── Exceptions ─────────────────────────────

type SeverityFilter = 'all' | 'error' | 'warning';

export function GstExceptionsScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const nav = useNav();
  const { from, to, override } = useGstRange(params);
  const q = useApiQuery('gst.exceptions', { from, to }, { keepPrevious: true });
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [code, setCode] = useState<string>('');
  const [cursor, setCursor] = useState<string | null>(null);
  const all = q.data?.issues ?? [];
  const keyed = useMemo(() => all.map((i, idx) => ({ ...i, key: issueKey(i, idx) })), [all]);
  const rows = useMemo(() => keyed.filter((i) => (severity === 'all' || i.severity === severity) && (code === '' || i.code === code)), [keyed, severity, code]);
  const codes = useMemo(() => codesPresent(all), [all]);
  const counts = countIssues(all);
  const selected = rows.find((r) => r.key === cursor) ?? rows[0] ?? null;
  const master = selected ? masterLink(selected) : null;
  const alter = selected ? alterVoucherLink(selected) : null;
  // A bar of the graph shows that type in the table (every severity, so the rows are there).
  const spec = useMemo(
    () =>
      q.data
        ? exceptionsChart(q.data.issues, (c) => {
            setSeverity('all');
            setCode(c ?? '');
          })
        : null,
    [q.data],
  );

  const columns = useMemo<Column<GstIssue & { key: string }>[]>(
    () => [
      { key: 'severity', header: 'Severity', width: 100, sortable: true, render: (r) => <SeverityBadge severity={r.severity} /> },
      { key: 'code', header: 'Problem', width: 220, sortable: true, value: (r) => ISSUE_CODE_LABELS[r.code] ?? r.code },
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true, value: (r) => r.date ?? '' },
      { key: 'voucher', header: 'Voucher', width: 180, value: (r) => [r.voucherTypeName, r.voucherNumber].filter(Boolean).join(' ') },
      { key: 'partyName', header: 'Party', width: 180, value: (r) => r.partyName ?? '' },
      { key: 'message', header: 'What is wrong', minWidth: 280 },
    ],
    [],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'All', onClick: () => setSeverity('all'), disabled: severity === 'all', group: 'view' },
    { key: 'Ctrl+2', label: 'Errors only', onClick: () => setSeverity('error'), disabled: severity === 'error', group: 'view' },
    { key: 'Ctrl+3', label: 'Warnings only', onClick: () => setSeverity('warning'), disabled: severity === 'warning', group: 'view' },
    {
      key: 'Alt+M',
      label: master ? master.label : 'Open master',
      icon: 'external',
      onClick: () => master && nav.push(master.screen, master.params),
      disabled: !master,
      hint: master ? master.hint : 'This problem is not in a master',
      group: 'fix',
    },
    { key: 'Alt+A', label: 'Alter voucher', icon: 'edit', onClick: () => alter && nav.push(alter.screen, alter.params), disabled: !alter, hint: alter?.hint, group: 'fix' },
  ];
  const stat = exceptionsStat(counts);
  return (
    <ReportScreen
      title="GST Exceptions"
      period={override}
      filters={
        <>
          <SegmentedControl<SeverityFilter>
            aria-label="Severity"
            size="sm"
            value={severity}
            onChange={setSeverity}
            options={[
              { value: 'all', label: 'All' },
              { value: 'error', label: 'Errors' },
              { value: 'warning', label: 'Warnings' },
            ]}
          />
          <Select
            size="sm"
            aria-label="Problem type"
            value={code}
            onChange={(v) => setCode(v)}
            options={[{ value: '', label: 'Every problem type' }, ...codes.map((c) => ({ value: c.code, label: `${ISSUE_CODE_LABELS[c.code]} (${c.count})` }))]}
          />
        </>
      }
      actions={actions}
      graph={reportGraph(spec)}
      stat={q.data && stat.length ? <StatLine items={stat} /> : undefined}
      about={
        <p>
          Documents the GST portal would reject or that would make a return wrong. Errors must be fixed before filing; warnings are worth a look. Correct the voucher or
          the master named in the fix, then come back — the list refreshes on its own.
        </p>
      }
      exportDef={q.data ? () => exceptionsExport({ ...q.data!, issues: rows }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="↑↓ Select · Enter View voucher · Alt+A Alter voucher · Alt+M Fix master · Ctrl+1/2/3 Filter · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      {q.data && all.length === 0 ? (
        <Banner tone="success" title="No problems found">
          Every GST document in this period passes the checks.
        </Banner>
      ) : (
        <div className="bx-gst-fill">
          <DataTable
            aria-label="GST exceptions"
            autoFocus
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.key}
            selectedKey={selected?.key ?? null}
            onSelect={(k) => setCursor(k)}
            onRowActivate={(r) => {
              const link = issueVoucherLink(r);
              if (link) nav.push(link.screen, link.params);
            }}
            height="45vh"
            empty={<EmptyState size="sm" title="Nothing matches the filter" body="Choose All (Ctrl+1) or another problem type." />}
          />
          {selected ? (
            <IssueFix
              issue={selected}
              extra={
                selected.voucherId === null ? (
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => {
                      const key = periodKeyForRange(from, to);
                      if (key) nav.push('gst.gstr1.section', { period: key, tile: '13' });
                      else nav.push('gst.gstr1');
                    }}
                  >
                    Open GSTR-1 table 13 (documents issued)
                  </Button>
                ) : null
              }
            />
          ) : null}
        </div>
      )}
    </ReportScreen>
  );
}

/**
 * Under the table: how to fix the highlighted problem, and the links that open what to correct (the
 * problem and what is wrong are the row itself).
 */
function IssueFix({ issue, extra }: { issue: GstIssue; extra?: ReactNode }) {
  const nav = useNav();
  const links = fixLinks(issue);
  return (
    <Inline gap={2} align="center" wrap aria-label="How to fix the selected problem" role="group">
      <span>
        <span className="bx-muted">How to fix: </span>
        {issue.fix}
      </span>
      {links.map((l) => (
        <Button key={l.label} size="sm" variant="link" title={l.hint} aria-label={`${l.label}: ${l.hint}`} onClick={() => nav.push(l.screen, l.params)}>
          {l.label}
        </Button>
      ))}
      {extra}
    </Inline>
  );
}
