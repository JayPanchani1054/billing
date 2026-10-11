/**
 * 'gst.gstr1' {period?} — GSTR-1 for a return period, as the portal's tables (2.1, SPEC-21 §1.9): one
 * row per table that has something to report (4A … 11), the Total row, then the check tables 12 and 13;
 * More › "Show empty tables" lists every table. Enter on a row opens its documents ('gst.gstr1.section').
 * The stat answers "can I file?" ("Nothing blocking" / "N block the JSON · Review ›"); the return period
 * is the title row's token (Alt+F2); notes are in More › "About this return". Alt+J saves the portal
 * JSON; Alt+E exports the summary.
 * 2.1.2 (the owner's change to D26): "Taxable value by table" as 4 px bars in the Taxable value cells of
 * the supply tables (≤ 20 rows, a table-only spec; a table that reduces it in slot 2) — never a strip, never in the JSON,
 * the export or a print (lib/returnCharts.ts `gstr1Chart`).
 */
import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Gstr1Summary } from '../../../shared/types/gst-returns.ts';
import { api, formatDate, formatMoney, ReportScreen, useApiQuery, useCan, useConfirm, useNav, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { checkItem } from '../../app/lib/moreItems.ts';
import { Badge, Banner, Button, EmptyState, StatLine, useRovingFocus, useToast } from '../../ui/index.ts';
import { inlineBars } from '../../ui/lib/chartSpec.ts';
import { barWidths } from '../../ui/lib/inlineBars.ts';
import type { InlineBar } from '../../ui/lib/inlineBars.ts';
import { reportGraph } from '../../ui/lazyChart.tsx';
import { FileResultDialog, IssuesPanel, PeriodSelect, ReturnAbout, saveJsonFile, useReturnPeriod } from './components.tsx';
import type { FileResult } from './components.tsx';
import { buildTiles, countText, gstr1Rows, summaryExport, tileName } from './lib/gstr1.ts';
import type { Gstr1Tile } from './lib/gstr1.ts';
import { gstr1Chart, gstr1Excluded, gstr1Stat, gstr1Total } from './lib/returnCharts.ts';
import { MarkFiledDialog } from './plusComponents.tsx';

export interface Gstr1Params {
  period?: string;
}

export function Gstr1Screen({ params }: ScreenProps<Gstr1Params>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canFile = useCan('gst.file');
  const rp = useReturnPeriod(params?.period);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const q = useApiQuery('gst.gstr1.summary', { period: rp.key ?? '' }, { enabled: rp.key !== null, keepPrevious: true });
  const summary = q.data;
  const tiles = useMemo(() => (summary ? buildTiles(summary) : []), [summary]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FileResult | null>(null);
  const [marking, setMarking] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const composition = rp.periods?.registration === 'composition';
  // The tables as listed, and the graph drawn in their Taxable value cells (≤ 20 supply rows: `inlineOnly`).
  const rows = useMemo(() => gstr1Rows(tiles, showEmpty), [tiles, showEmpty]);
  const spec = useMemo(() => gstr1Chart(rows.supply), [rows]);
  const inline = inlineBars(spec, rows.supply.length);
  const bars = useMemo(() => (inline ? barWidths(rows.supply.map((t) => t.taxable)) : null), [inline, rows]);
  const amendCount = summary ? (summary.amendments?.invoices.length ?? 0) + (summary.amendments?.notes.length ?? 0) + (summary.amendments?.b2cs.length ?? 0) + (summary.amendments?.late.length ?? 0) : 0;

  const exportJson = async (): Promise<void> => {
    if (!rp.key || busy) return;
    const errorCount = summary && summary.period.key === rp.key ? summary.issues.filter((i) => i.severity === 'error').length : 0;
    if (errorCount > 0) {
      const ok = await confirm({
        title: `Export GSTR-1 with ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}?`,
        message:
          'The portal may reject the file, or the return may be wrong, until these documents are fixed (see Uncertain transactions). Export anyway, for example to check the other tables on the portal?',
        confirmLabel: 'Export anyway',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const file = await api('gst.gstr1.json', { period: rp.key });
      const path = await saveJsonFile(file, 'Save GSTR-1 JSON');
      if (path) {
        setResult({
          title: 'GSTR-1 file saved',
          path,
          summary: `GSTR-1 for ${rp.label}${summary?.gstin ? ` · GSTIN ${summary.gstin}` : ''}`,
          warnings: file.warnings,
          nextStep: 'Upload it on the GST portal: Returns › GSTR-1 › Prepare offline › Upload. Check the summary on the portal against this screen before you file.',
        });
      }
    } catch (err) {
      toast.error('Could not create the GSTR-1 file', { message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const openTile = (t: Gstr1Tile): void => {
    // Table 11 (advances) has its own screen with the vouchers and the pending advances.
    if (t.id === '11' && summary) nav.push('gst.advances', { from: summary.period.from, to: summary.period.to });
    else if (rp.key) nav.push('gst.gstr1.section', { period: rp.key, tile: t.id });
  };

  const openExceptions = (): void => {
    if (summary) nav.push('gst.exceptions', { from: summary.period.from, to: summary.period.to });
  };
  const stat = summary ? gstr1Stat(summary.issues) : null;
  const actions: ScreenActionItem[] = [
    { key: 'Alt+F2', label: 'Return period', icon: 'calendar', onClick: () => selectRef.current?.focus(), group: 'period' },
    {
      key: 'Alt+J',
      label: 'Export JSON',
      icon: 'download',
      primary: true,
      onClick: () => void exportJson(),
      disabled: !summary || busy || !canFile,
      hint: canFile ? 'Save the file to upload on the GST portal' : 'You need the "Prepare GST filings" permission',
      group: 'file',
    },
    { key: 'Alt+X', label: 'GST exceptions', icon: 'alert', onClick: () => summary && nav.push('gst.exceptions', { from: summary.period.from, to: summary.period.to }), disabled: !summary, group: 'go' },
    { key: 'Alt+B', label: 'GSTR-3B', icon: 'gst', onClick: () => rp.key && nav.push('gst.gstr3b', { period: rp.key }), disabled: !rp.key, group: 'go' },
    {
      key: 'Alt+F',
      label: summary?.filing ? 'Filed' : 'Mark filed',
      icon: 'check',
      onClick: () => setMarking(true),
      disabled: !summary || !canFile || Boolean(summary.filing) || composition,
      hint: summary?.filing ? `Filed on ${summary.filing.filedOn}` : 'After filing on the portal: later changes are reported as amendments',
      group: 'file',
    },
    { key: 'Alt+M', label: `Amendments${amendCount ? ` (${amendCount})` : ''}`, icon: 'list', onClick: () => rp.key && nav.push('gst.amendments', { period: rp.key }), disabled: !rp.key, group: 'go' },
    checkItem('Show empty tables', showEmpty, setShowEmpty),
  ];

  return (
    <>
      <ReportScreen
        title="GSTR-1"
        periodMode="none"
        context={<PeriodSelect periods={rp.periods} value={rp.key} onChange={rp.setKey} selectRef={selectRef} token />}
        meta={
          summary?.filing ? (
            <span title={summary.filing.arn ? `ARN ${summary.filing.arn}` : undefined}>Filed {formatDate(summary.filing.filedOn, 'D-MMM-YY')}</span>
          ) : undefined
        }
        stat={
          stat ? (
            <StatLine
              items={[
                { label: '', value: stat.text, tone: stat.tone ?? undefined },
                ...(stat.link ? [{ label: stat.link, value: '', link: true, onClick: openExceptions, title: 'GST exceptions for this period · Alt+X' }] : []),
              ]}
            />
          ) : undefined
        }
        about={summary ? <Gstr1About summary={summary} /> : undefined}
        aboutLabel="About this return"
        actions={actions}
        graph={reportGraph(inline ? spec : null, { inline })}
        exportDef={summary ? () => ({ ...summaryExport(summary), title: 'GSTR-1 Summary', period: summary.period.label }) : undefined}
        loading={rp.loading || (q.loading && !summary)}
        refreshing={q.refreshing || busy}
        error={rp.error ?? q.error}
        onRetry={() => (rp.error ? rp.refetch() : void q.refetch())}
        hint="Arrows Move · Enter Open table · Alt+J JSON · Alt+F Mark filed · Alt+M Amendments · Alt+E Export · Alt+F2 Period · Esc Back"
      >
        {composition ? (
          <Banner tone="info" title="Composition taxpayers file CMP-08 and GSTR-4">
            This company is registered under composition: it does not file GSTR-1. Open GST › CMP-08 for the quarterly statement.
          </Banner>
        ) : null}
        {amendCount > 0 ? (
          <Banner tone="warning" inline>
            {amendCount} amended or late document(s) of earlier filed periods are reported in this return — Alt+M lists them.
          </Banner>
        ) : null}
        {rp.periods && rp.periods.periods.length === 0 ? (
          <Banner tone="info" title="No return periods yet">
            Return periods start from the date your books begin. Record a sale or purchase to see it here.
          </Banner>
        ) : summary ? (
          <Gstr1Body summary={summary} rows={rows} bars={bars} onShowEmpty={() => setShowEmpty(true)} onOpen={openTile} onShowAll={openExceptions} />
        ) : null}
      </ReportScreen>
      <FileResultDialog result={result} onClose={() => setResult(null)} />
      {marking && summary && rp.key ? (
        <MarkFiledDialog
          form="gstr1"
          period={rp.key}
          periodLabel={summary.period.label}
          onClose={(done) => {
            setMarking(false);
            if (done) void q.refetch();
          }}
        />
      ) : null}
    </>
  );
}

/** More › "About this return": what the screen is for, what is not in the return, and the core's notes. */
function Gstr1About({ summary }: { summary: Gstr1Summary }) {
  const excluded = gstr1Excluded(summary);
  return (
    <ReturnAbout
      lead="Your sales for the period arranged table by table as on the GST portal. Open a table with Enter to check its documents, fix what blocks the JSON (GST exceptions, Alt+X), then save the JSON (Alt+J) and upload it on the portal."
      notes={summary.notes}
    >
      <p>
        {excluded ? `Not in GSTR-1 for ${summary.period.label}: ${excluded}.` : 'Every document of the period is reported.'} Tables 12 (HSN summary) and 13 (documents issued) restate
        the others, so the Total row does not add them. Credit notes reduce the tables they belong to.
      </p>
      {summary.filing ? (
        <p>
          Filed on {formatDate(summary.filing.filedOn)}
          {summary.filing.arn ? ` (ARN ${summary.filing.arn})` : ''}. Changes to its documents are reported as amendments in the next GSTR-1 (Alt+M).
        </p>
      ) : null}
    </ReturnAbout>
  );
}

function Gstr1Body({
  summary,
  rows,
  bars,
  onShowEmpty,
  onOpen,
  onShowAll,
}: {
  summary: Gstr1Summary;
  rows: ReturnType<typeof gstr1Rows>;
  /** Inline bars of the supply rows' Taxable value (null = none), aligned with `rows.supply`. */
  bars: readonly (InlineBar | null)[] | null;
  onShowEmpty: () => void;
  onOpen: (t: Gstr1Tile) => void;
  onShowAll: () => void;
}) {
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);
  // ↑/↓ (and ←/→, as between the 2.0 tiles) move between the tables; Home/End to the ends.
  const roving = useRovingFocus(bodyRef, { orientation: 'both' });
  const total = gstr1Total(summary, rows.supply);
  const first = rows.supply[0] ?? rows.checks[0];
  if (!first) {
    return (
      <EmptyState
        title={`Nothing to report for ${summary.period.label}`}
        body="No sales, notes or advances fall in this return period."
        action={
          <Button variant="link" onClick={onShowEmpty}>
            Show empty tables
          </Button>
        }
      />
    );
  }
  const row = (t: Gstr1Tile, i?: number): ReactNode => <TableRow key={t.id} tile={t} onOpen={onOpen} autoFocus={t === first} bar={i === undefined ? null : (bars?.[i] ?? null)} />;
  return (
    <div className="bx-gst-scroll">
      <table className="bx-gst-form" aria-label={`GSTR-1 tables, ${summary.period.label}`}>
        <thead>
          <tr>
            <th scope="col" className="bx-gst-form__row">
              Table
            </th>
            <th scope="col">Name</th>
            <th scope="col" className="is-num">
              Count
            </th>
            <th scope="col" className="is-num">
              Taxable value
            </th>
            <th scope="col" className="is-num">
              Tax
            </th>
          </tr>
        </thead>
        <tbody ref={bodyRef} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
          {rows.supply.map((t, i) => row(t, i))}
          <tr className="is-total" title={total.note ? `${total.split}. ${total.note}` : total.split}>
            <td className="bx-gst-form__row" />
            <th scope="row">
              {total.label}
              {total.note ? <span className="bx-sr-only"> ({total.note})</span> : null}
            </th>
            <td className="is-num" />
            <td className="is-num">{formatMoney(total.taxable)}</td>
            <td className="is-num">{formatMoney(total.tax)}</td>
          </tr>
          {rows.checks.map((t) => row(t))}
        </tbody>
      </table>
      {summary.issues.length > 0 ? <IssuesPanel issues={summary.issues} onShowAll={onShowAll} defaultCollapsed /> : null}
    </div>
  );
}

/** A Taxable value cell carrying an inline bar (the kit's `.bx-td__bar`, placed by the form's cell padding). */
const BAR_CELL = { position: 'relative', '--cell-px': 'var(--space-2)' } as CSSProperties;

/**
 * One table of the return: the first cell is a plain button named exactly as the 2.0 tile (Enter opens
 * the table, ↑/↓ move between tables); a click anywhere on the row opens it too.
 */
function TableRow({ tile, onOpen, autoFocus, bar }: { tile: Gstr1Tile; onOpen: (t: Gstr1Tile) => void; autoFocus: boolean; bar: InlineBar | null }) {
  const open = (): void => onOpen(tile);
  return (
    <tr className="bx-gst-link-row" onClick={open} title={[tile.help, ...tile.notes].join(' ')}>
      <td className="bx-gst-form__row">
        <Button
          variant="link"
          size="sm"
          data-roving-item=""
          data-autofocus={autoFocus ? '' : undefined}
          aria-label={tileName(tile)}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          {tile.table}
        </Button>
      </td>
      <th scope="row">
        {tile.title}
        {tile.errors > 0 ? (
          <>
            {' '}
            <Badge tone="danger" size="sm">
              {tile.errors} {tile.errors === 1 ? 'error' : 'errors'}
            </Badge>
          </>
        ) : tile.warnings > 0 ? (
          <>
            {' '}
            <Badge tone="warning" size="sm">
              {tile.warnings} {tile.warnings === 1 ? 'warning' : 'warnings'}
            </Badge>
          </>
        ) : null}
      </th>
      <td className="is-num">{countText(tile.count, tile.countLabel)}</td>
      <td className={bar ? 'is-num bx-td--right' : 'is-num'} style={bar ? BAR_CELL : undefined}>
        {formatMoney(tile.taxable)}
        {bar ? <span className={bar.negative ? 'bx-td__bar bx-td__bar--neg' : 'bx-td__bar'} style={{ '--bar-w': bar.width } as CSSProperties} aria-hidden="true" /> : null}
      </td>
      <td className="is-num">{formatMoney(tile.tax)}</td>
    </tr>
  );
}
