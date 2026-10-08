/**
 * GST registers and analysis for the reporting period (Alt+F2):
 *   'gst.hsn'        {direction?}  HSN/SAC summary of outward or inward supplies
 *   'gst.register'   {kind?}       GST sales / purchase register (one row per document, signed)
 *   'gst.itc'        —             input tax credit by supplier and by eligibility
 *   'gst.exceptions' {from?, to?}  every uncertain transaction with what is wrong and how to fix it
 * Enter on a document row opens the voucher.
 */
import { useMemo, useState } from 'react';
import type { GstIssue, GstItcSupplierRow, GstRateSplit, GstRegisterRow, ItcEligibility } from '../../../shared/types/gst-returns.ts';
import { formatMoney, formatPercent, ReportScreen, useApiQuery, useNav } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, EmptyState, Grid, Inline, KpiCard, Panel, SegmentedControl, Select, Stack, Tabs } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp, IssueItem, SeverityBadge, useGstRange } from './components.tsx';
import { HsnTable } from './Gstr1SectionScreen.tsx';
import { alterVoucherLink, codesPresent, countIssues, issueKey, issueSummaryText, issueVoucherLink, ISSUE_CODE_LABELS, masterLink } from './lib/issues.ts';
import { periodKeyForRange } from './lib/periods.ts';
import { exceptionsExport, hsnExport, itcExport, registerExport, sumTax } from './lib/reports.ts';

function amount<T>(key: string, header: string, width = 130, value?: (r: T) => number): Column<T> {
  return { key, header, kind: 'amount', width, total: true, sortable: true, value };
}

// ───────────────────────────── HSN summary ─────────────────────────────

export interface HsnParams {
  direction?: 'outward' | 'inward';
}

export function HsnSummaryScreen({ params }: ScreenProps<HsnParams>) {
  const { from, to, override } = useGstRange(undefined);
  const [direction, setDirection] = useState<'outward' | 'inward'>(params?.direction === 'inward' ? 'inward' : 'outward');
  const q = useApiQuery('gst.hsnSummary', { from, to, direction }, { keepPrevious: true });
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Outward (sales)', onClick: () => setDirection('outward'), disabled: direction === 'outward', group: 'view' },
    { key: 'Ctrl+2', label: 'Inward (purchases)', onClick: () => setDirection('inward'), disabled: direction === 'inward', group: 'view' },
  ];
  return (
    <ReportScreen
      title="HSN/SAC Summary"
      subtitle={direction === 'outward' ? 'Outward supplies' : 'Inward supplies'}
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
      exportDef={q.data ? () => ({ ...hsnExport(q.data?.rows ?? [], q.data?.totals), subtitle: direction === 'outward' ? 'Outward supplies' : 'Inward supplies' }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Ctrl+1 Outward · Ctrl+2 Inward · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>Totals by HSN/SAC code, unit and rate — the same figures as GSTR-1 table 12 (outward) and GSTR-9 tables 17 / 18. Credit notes and purchase returns reduce them.</GstHelp>
        <HsnTable rows={q.data?.rows ?? []} />
      </div>
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
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Sales register', onClick: () => setKind('sales'), disabled: kind === 'sales', group: 'view' },
    { key: 'Ctrl+2', label: 'Purchase register', onClick: () => setKind('purchase'), disabled: kind === 'purchase', group: 'view' },
  ];
  const rows = q.data?.rows ?? [];
  return (
    <ReportScreen
      title="GST Register"
      subtitle={purchase ? 'Purchases' : 'Sales'}
      period={override}
      filters={
        <Tabs
          aria-label="Register"
          variant="pill"
          value={kind}
          onChange={(id) => setKind(id === 'purchase' ? 'purchase' : 'sales')}
          items={[
            { id: 'sales', label: 'Sales' },
            { id: 'purchase', label: 'Purchases' },
          ]}
        />
      }
      actions={actions}
      exportDef={q.data ? () => ({ ...registerExport(q.data!), title: purchase ? 'GST Purchase Register' : 'GST Sales Register' }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open voucher · Ctrl+1 Sales · Ctrl+2 Purchases · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>
          {purchase
            ? 'Every purchase with its GST, one line per document. Purchase returns are shown as negative amounts.'
            : 'Every sale with its GST, one line per document. Credit notes are shown as negative amounts.'}
        </GstHelp>
        <DataTable<GstRegisterRow>
          aria-label={purchase ? 'GST purchase register' : 'GST sales register'}
          autoFocus
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
        {q.data && q.data.rateTotals.length > 0 ? (
          <Panel title="Totals by rate" headingLevel={2} collapsible defaultCollapsed>
            <DataTable<GstRateSplit> aria-label="Totals by rate" columns={rateColumns} rows={q.data.rateTotals} getRowKey={(r) => `${r.rate}:${r.cessRate}`} height={220} />
          </Panel>
        ) : null}
      </div>
    </ReportScreen>
  );
}

// ───────────────────────────── ITC ─────────────────────────────

const ELIGIBILITY_HELP: Readonly<Record<ItcEligibility, string>> = {
  inputs: 'Goods bought for business',
  capital_goods: 'Machinery and equipment',
  input_services: 'Services used for business',
  ineligible: 'Blocked under s.17(5) — not claimable',
};

export function ItcScreen({ params }: ScreenProps<{ from?: string; to?: string }>) {
  const nav = useNav();
  const { from, to, override } = useGstRange(params);
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
      { ...amount<GstItcSupplierRow>('blocked', 'Blocked', 120, (r) => sumTax(r.ineligible)), blankZero: true },
      { ...amount<GstItcSupplierRow>('rcm', 'Reverse charge', 130, (r) => sumTax(r.reverseCharge)), blankZero: true },
      { ...amount<GstItcSupplierRow>('imports', 'On imports', 120, (r) => sumTax(r.imports)), blankZero: true },
    ],
    [],
  );
  const t = q.data?.totals;
  return (
    <ReportScreen
      title="Input Tax Credit"
      subtitle="By supplier"
      period={override}
      exportDef={q.data ? () => itcExport(q.data!) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Open supplier ledger · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>
          GST you paid on purchases and can set off against the tax on your sales, net of purchase returns. Eligible ITC here equals GSTR-3B 4(C) before your own
          entries. Compare it with GSTR-2B in GST reconciliation.
        </GstHelp>
        {t ? (
          <Grid minItemWidth={180} gap={3}>
            <KpiCard label="Eligible ITC" value={sumTax(t.eligible)} amount caption={`IGST ${fmt(t.eligible.igst)} · CGST ${fmt(t.eligible.cgst)} · SGST ${fmt(t.eligible.sgst)}`} />
            <KpiCard label="Blocked (s.17(5))" value={sumTax(t.ineligible)} amount caption="Not claimable" />
            <KpiCard label="Under reverse charge" value={sumTax(t.reverseCharge)} amount caption="Paid in cash first, then claimable" />
            <KpiCard label="On imports" value={sumTax(t.imports)} amount caption="IGST on bills of entry" />
          </Grid>
        ) : null}
        <DataTable<GstItcSupplierRow>
          aria-label="Input tax credit by supplier"
          autoFocus
          columns={columns}
          rows={q.data?.rows ?? []}
          getRowKey={(r, i) => `${r.partyLedgerId ?? r.gstin ?? r.partyName}:${i}`}
          onRowActivate={(r) => (r.partyLedgerId ? nav.push('reports.ledger', { ledgerId: r.partyLedgerId, from, to }) : undefined)}
          empty={<EmptyState icon="file" title="No purchases with GST in this period" body="Change the period with Alt+F2, or record a purchase with F9." />}
        />
        {q.data && q.data.byEligibility.length > 0 ? (
          <Panel title="By type of credit" headingLevel={2} collapsible>
            <table className="bx-gst-form">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col" className="is-num">
                    Taxable value
                  </th>
                  <th scope="col" className="is-num">
                    IGST
                  </th>
                  <th scope="col" className="is-num">
                    CGST
                  </th>
                  <th scope="col" className="is-num">
                    SGST/UTGST
                  </th>
                  <th scope="col" className="is-num">
                    Cess
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.byEligibility.map((e) => (
                  <tr key={e.eligibility}>
                    <th scope="row">
                      {e.label}
                      <span className="bx-gst-form__help">{ELIGIBILITY_HELP[e.eligibility]}</span>
                    </th>
                    <td className="is-num">{fmt(e.taxable)}</td>
                    <td className="is-num">{fmt(e.tax.igst)}</td>
                    <td className="is-num">{fmt(e.tax.cgst)}</td>
                    <td className="is-num">{fmt(e.tax.sgst)}</td>
                    <td className="is-num">{fmt(e.tax.cess)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ) : null}
      </div>
    </ReportScreen>
  );
}

const fmt = (p: number): string => formatMoney(p);

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
    { key: 'Alt+L', label: 'Alter voucher', icon: 'edit', onClick: () => alter && nav.push(alter.screen, alter.params), disabled: !alter, hint: alter?.hint, group: 'fix' },
  ];
  return (
    <ReportScreen
      title="GST Exceptions"
      subtitle={q.data ? issueSummaryText(counts) : undefined}
      period={override}
      filters={
        <Inline gap={2}>
          <SegmentedControl<SeverityFilter>
            aria-label="Severity"
            size="sm"
            value={severity}
            onChange={setSeverity}
            options={[
              { value: 'all', label: `All (${all.length})` },
              { value: 'error', label: `Errors (${counts.errors})` },
              { value: 'warning', label: `Warnings (${counts.warnings})` },
            ]}
          />
          <Select
            size="sm"
            aria-label="Problem type"
            value={code}
            onChange={(v) => setCode(v)}
            options={[{ value: '', label: 'Every problem type' }, ...codes.map((c) => ({ value: c.code, label: `${ISSUE_CODE_LABELS[c.code]} (${c.count})` }))]}
          />
        </Inline>
      }
      actions={actions}
      exportDef={q.data ? () => exceptionsExport({ ...q.data!, issues: rows }) : undefined}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="↑↓ Select · Enter View voucher · Alt+L Alter voucher · Alt+M Fix master · Ctrl+1/2/3 Filter · Alt+F2 Period · Alt+E Export · Esc Back"
    >
      <div className="bx-gst-fill">
        <GstHelp>
          Documents the GST portal would reject or that would make a return wrong. Errors must be fixed before filing; warnings are worth a look. Correct the
          voucher or the master named in the fix, then come back — the list refreshes on its own.
        </GstHelp>
        {q.data && all.length === 0 ? (
          <Banner tone="success" title="No problems found">
            Every GST document in this period passes the checks.
          </Banner>
        ) : (
          <>
            <DataTable<GstIssue & { key: string }>
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
              <Panel title="Selected problem" headingLevel={2}>
                <Stack gap={2}>
                  <ul className="bx-gst-issues">
                    <IssueItem issue={selected} />
                  </ul>
                  {selected.voucherId === null ? (
                    <Inline gap={2}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const key = periodKeyForRange(from, to);
                          if (key) nav.push('gst.gstr1.section', { period: key, tile: '13' });
                          else nav.push('gst.gstr1');
                        }}
                      >
                        Open GSTR-1 table 13 (documents issued)
                      </Button>
                    </Inline>
                  ) : null}
                </Stack>
              </Panel>
            ) : null}
          </>
        )}
      </div>
    </ReportScreen>
  );
}
