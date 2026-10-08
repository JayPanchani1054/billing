/**
 * 'gst.gstr9' {fy?} — GSTR-9 annual return summary for a GST financial year, prepared from the books
 * (tables 4, 5, 6, 9, month-wise figures and the HSN tables 17 / 18). Enter on a month opens its
 * GSTR-3B. Always labelled "Prepared from books — verify before filing".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Gstr9MonthRow, Gstr9Row, Gstr9Summary } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import { formatMoney, ReportScreen, useApiQuery, useNav, useWorkingDate } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Banner, DataTable, EmptyState, Panel, Select } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp } from './components.tsx';
import { HsnTable } from './Gstr1SectionScreen.tsx';
import { creditMayPay, HEAD_LABELS } from './lib/gstr3b.ts';
import { fyList, initialFy } from './lib/periods.ts';
import { gstr9Export, sumTax } from './lib/reports.ts';

const money = (p: number): string => formatMoney(p);

export function Gstr9Screen({ params }: ScreenProps<{ fy?: string }>) {
  const nav = useNav();
  const { date: workingDate } = useWorkingDate();
  const periods = useApiQuery('gst.periods', {}, { staleTime: 60_000 });
  const years = useMemo(() => fyList(periods.data), [periods.data]);
  const [fy, setFy] = useState<string | null>(null);
  useEffect(() => {
    if (fy === null && periods.data) setFy(initialFy(periods.data, workingDate, params?.fy));
  }, [fy, periods.data, workingDate, params?.fy]);
  const q = useApiQuery('gst.gstr9.summary', { fy: fy ?? '' }, { enabled: fy !== null, keepPrevious: true });
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const s = q.data;

  const actions: ScreenActionItem[] = [{ key: 'Alt+F2', label: 'Financial year', icon: 'calendar', onClick: () => selectRef.current?.focus(), group: 'period' }];
  return (
    <ReportScreen
      title="GSTR-9"
      subtitle={fy ? `Annual return · FY ${fy}` : 'Annual return'}
      periodMode="none"
      filters={
        <label className="bx-gst-period">
          <span className="bx-gst-period__label">Financial year</span>
          <Select
            ref={selectRef}
            size="sm"
            aria-label="Financial year"
            aria-keyshortcuts="Alt+F2"
            value={fy ?? ''}
            placeholder={periods.data ? 'Choose a year' : 'Loading…'}
            disabled={years.length === 0}
            options={years.map((y) => ({ value: y, label: `FY ${y}` }))}
            onChange={(v) => setFy(v)}
          />
        </label>
      }
      actions={actions}
      exportDef={s ? () => ({ ...gstr9Export(s), title: 'GSTR-9 Summary', period: `FY ${s.fy}` }) : undefined}
      loading={periods.loading || (q.loading && !s)}
      refreshing={q.refreshing}
      error={periods.error ?? q.error}
      onRetry={() => void (periods.error ? periods.refetch() : q.refetch())}
      hint="Enter Open month's GSTR-3B · Alt+F2 Year · Alt+E Export · Alt+P Print · Esc Back"
    >
      {years.length === 0 && periods.data ? (
        <EmptyState icon="calendar" title="No financial year to show" body="Record sales or purchases to prepare the annual summary." />
      ) : s ? (
        <Gstr9Body summary={s} onMonth={(m) => nav.push('gst.gstr3b', { period: m.period })} />
      ) : null}
    </ReportScreen>
  );
}

function Gstr9Body({ summary: s, onMonth }: { summary: Gstr9Summary; onMonth: (m: Gstr9MonthRow) => void }) {
  const monthColumns = useMemo<Column<Gstr9MonthRow>[]>(
    () => [
      { key: 'label', header: 'Month', minWidth: 120 },
      { key: 'outwardTaxable', header: 'Outward taxable', kind: 'amount', width: 150, total: true },
      { key: 'outTax', header: 'Tax on outward', kind: 'amount', width: 140, total: true, value: (m) => sumTax(m.outwardTax) },
      { key: 'itc', header: 'Net ITC', kind: 'amount', width: 140, total: true, value: (m) => sumTax(m.itc) },
      { key: 'cash', header: 'Paid in cash', kind: 'amount', width: 140, total: true, value: (m) => sumTax(m.cash) },
    ],
    [],
  );
  return (
    <div className="bx-gst-scroll">
      <Banner tone="warning" title={s.caption}>
        These figures are worked out from your books and your saved GSTR-3B entries. Compare them with GSTR-1, GSTR-3B and GSTR-2B on the portal and with your
        audited accounts before you file.
      </Banner>
      <GstHelp>The yearly summary of what you supplied, the credit you took and the tax you paid — the basis for filling GSTR-9 on the portal.</GstHelp>
      {s.notes.length > 0 ? (
        <Banner tone="info" title="Notes">
          <ul className="bx-gst-list">
            {s.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <Panel title="Month by month" headingLevel={2} description="Enter on a month opens its GSTR-3B.">
        <DataTable<Gstr9MonthRow>
          aria-label="Month-wise figures"
          autoFocus
          columns={monthColumns}
          rows={s.months}
          getRowKey={(m) => m.period}
          onRowActivate={onMonth}
          height={Math.min(440, 40 + 32 * (s.months.length + 2))}
          empty={<EmptyState size="sm" title="No months in this year" />}
        />
      </Panel>
      <Panel title="Pt. II · 4 Outward supplies on which tax is payable (and inward supplies under reverse charge)" headingLevel={2}>
        <G9Table rows={s.table4} />
      </Panel>
      <Panel title="Pt. II · 5 Outward supplies on which tax is not payable" headingLevel={2}>
        <G9Table rows={s.table5} />
      </Panel>
      <Panel title="Pt. III · 6 ITC availed during the year" headingLevel={2}>
        <G9Table rows={s.table6} taxable={false} />
      </Panel>
      <Panel title="Pt. IV · 9 Tax paid" headingLevel={2}>
        <table className="bx-gst-form">
          <thead>
            <tr>
              <th scope="col">Tax</th>
              <th scope="col" className="is-num">
                Tax payable
              </th>
              <th scope="col" className="is-num">
                Paid in cash
              </th>
              {TAX_HEADS.map((h) => (
                <th key={h} scope="col" className="is-num">
                  Paid by {HEAD_LABELS[h]} credit
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.table9.map((p) => (
              <tr key={p.head}>
                <th scope="row">{p.label}</th>
                <td className="is-num">{money(p.payable)}</td>
                <td className="is-num bx-gst-cash">{money(p.paidCash)}</td>
                {TAX_HEADS.map((h) =>
                  creditMayPay(h, p.head) ? (
                    <td key={h} className="is-num">
                      {money(p.paidItc[h])}
                    </td>
                  ) : (
                    <td key={h} className="is-num is-blank" aria-label="Not applicable" />
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="17 HSN summary of outward supplies" headingLevel={2} collapsible defaultCollapsed>
        <HsnTable rows={s.hsnOutward} autoFocus={false} height="360px" />
      </Panel>
      <Panel title="18 HSN summary of inward supplies" headingLevel={2} collapsible defaultCollapsed>
        <HsnTable rows={s.hsnInward} autoFocus={false} height="360px" />
      </Panel>
    </div>
  );
}

function G9Table({ rows, taxable = true }: { rows: readonly Gstr9Row[]; taxable?: boolean }) {
  return (
    <table className="bx-gst-form">
      <thead>
        <tr>
          <th scope="col" className="bx-gst-form__row">
            Table
          </th>
          <th scope="col">Nature of supplies</th>
          {taxable ? (
            <th scope="col" className="is-num">
              Taxable value
            </th>
          ) : null}
          {TAX_HEADS.map((h) => (
            <th key={h} scope="col" className="is-num">
              {HEAD_LABELS[h]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={/^(4H|4N|5G|5M|5N|6I|6J)$/.test(r.key) ? 'is-total' : undefined}>
            <td className="bx-gst-form__row">{r.key}</td>
            <th scope="row">{r.label}</th>
            {taxable ? <td className="is-num">{money(r.taxable)}</td> : null}
            {TAX_HEADS.map((h) => (
              <td key={h} className="is-num">
                {money(r[h])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
