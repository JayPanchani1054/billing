/**
 * 'gst.gstr1' {period?} — GSTR-1 summary for a return period: one tile per table (4A … 13) with
 * counts, taxable value and tax; Enter on a tile opens its documents ('gst.gstr1.section'); the
 * uncertain-transactions panel links to the voucher / master to fix; Alt+J saves the portal JSON;
 * Alt+E exports the summary to Excel / CSV / PDF.
 */
import { useMemo, useRef, useState } from 'react';
import type { Gstr1Summary } from '../../../shared/types/gst-returns.ts';
import { api, formatMoney, ReportScreen, useApiQuery, useCan, useConfirm, useNav, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Grid, KpiCard, useRovingFocus, useToast } from '../../ui/index.ts';
import { FileResultDialog, GstHelp, IssuesPanel, PeriodSelect, saveJsonFile, useReturnPeriod } from './components.tsx';
import type { FileResult } from './components.tsx';
import { buildTiles, countText, summaryExport, taxOf } from './lib/gstr1.ts';
import type { Gstr1Tile } from './lib/gstr1.ts';

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
    if (rp.key) nav.push('gst.gstr1.section', { period: rp.key, tile: t.id });
  };

  const errors = summary?.issues.filter((i) => i.severity === 'error').length ?? 0;
  const actions: ScreenActionItem[] = [
    { key: 'Alt+F2', label: 'Return period', icon: 'calendar', onClick: () => selectRef.current?.focus(), group: 'period' },
    {
      key: 'Alt+J',
      label: 'Export JSON',
      icon: 'download',
      primary: true,
      onClick: () => void exportJson(),
      disabled: !summary || busy || !canFile,
      hint: canFile ? 'Save the file to upload on the GST portal' : 'You need the "File GST returns" permission',
      group: 'file',
    },
    { key: 'Alt+X', label: 'GST exceptions', icon: 'alert', onClick: () => summary && nav.push('gst.exceptions', { from: summary.period.from, to: summary.period.to }), disabled: !summary, group: 'go' },
    { key: 'Alt+B', label: 'GSTR-3B', icon: 'gst', onClick: () => rp.key && nav.push('gst.gstr3b', { period: rp.key }), disabled: !rp.key, group: 'go' },
  ];

  return (
    <>
      <ReportScreen
        title="GSTR-1"
        subtitle={rp.label ? `Outward supplies · ${rp.label}` : 'Outward supplies'}
        periodMode="none"
        filters={<PeriodSelect periods={rp.periods} value={rp.key} onChange={rp.setKey} selectRef={selectRef} />}
        actions={actions}
        exportDef={summary ? () => ({ ...summaryExport(summary), title: 'GSTR-1 Summary', period: summary.period.label }) : undefined}
        loading={rp.loading || (q.loading && !summary)}
        refreshing={q.refreshing || busy}
        error={rp.error ?? q.error}
        onRetry={() => (rp.error ? rp.refetch() : void q.refetch())}
        hint="Arrows Move · Enter Open table · Alt+J JSON · Alt+E Export · Alt+F2 Period · Esc Back"
      >
        {rp.periods && rp.periods.periods.length === 0 ? (
          <Banner tone="info" title="No return periods yet">
            Return periods start from the date your books begin. Record a sale or purchase to see it here.
          </Banner>
        ) : summary ? (
          <Gstr1Body summary={summary} tiles={tiles} onOpen={openTile} errors={errors} onShowAll={() => nav.push('gst.exceptions', { from: summary.period.from, to: summary.period.to })} />
        ) : null}
      </ReportScreen>
      <FileResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

function Gstr1Body({ summary, tiles, onOpen, errors, onShowAll }: { summary: Gstr1Summary; tiles: Gstr1Tile[]; onOpen: (t: Gstr1Tile) => void; errors: number; onShowAll: () => void }) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(gridRef, { orientation: 'both' });
  const ex = summary.excluded;
  const excluded = [
    ex.optional > 0 ? `${ex.optional} optional` : '',
    ex.cancelled > 0 ? `${ex.cancelled} cancelled` : '',
    ex.notGst > 0 ? `${ex.notGst} without GST` : '',
  ].filter(Boolean);
  return (
    <div className="bx-gst-scroll">
      <GstHelp>
        Your sales for the period arranged table by table as on the GST portal. Open a table with Enter to check its invoices, fix the uncertain transactions, then
        save the JSON (Alt+J) and upload it on the portal.
      </GstHelp>
      {summary.notes.length > 0 ? (
        <Banner tone="info" title="Notes">
          <ul className="bx-gst-list">
            {summary.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {errors > 0 ? (
        <Banner tone="danger" title={`${errors} ${errors === 1 ? 'problem needs' : 'problems need'} fixing before you file`}>
          The portal would reject these documents or the return would be wrong. See Uncertain transactions below.
        </Banner>
      ) : null}
      <Grid minItemWidth={180} gap={3}>
        <KpiCard label="Taxable value" value={summary.totals.taxable} amount caption="All tables except 4B" />
        <KpiCard
          label="Total tax"
          value={taxOf(summary.totals)}
          amount
          caption={`IGST ${formatMoney(summary.totals.igst)} · CGST ${formatMoney(summary.totals.cgst)} · SGST ${formatMoney(summary.totals.sgst)} · Cess ${formatMoney(summary.totals.cess)}`}
        />
        <KpiCard label="Not in GSTR-1" value={String(ex.optional + ex.cancelled + ex.notGst)} caption={excluded.length > 0 ? excluded.join(' · ') : 'Every document is reported'} />
      </Grid>
      <div ref={gridRef} className="bx-gst-tiles" role="group" aria-label="GSTR-1 tables" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        {tiles.map((t, i) => (
          <Tile key={t.id} tile={t} onOpen={onOpen} autoFocus={i === 0} />
        ))}
      </div>
      <IssuesPanel issues={summary.issues} onShowAll={onShowAll} />
    </div>
  );
}

function Tile({ tile, onOpen, autoFocus }: { tile: Gstr1Tile; onOpen: (t: Gstr1Tile) => void; autoFocus: boolean }) {
  const label = `Table ${tile.table}, ${tile.title}: ${countText(tile.count, tile.countLabel)}, taxable ${formatMoney(tile.taxable)}, tax ${formatMoney(tile.tax)}${
    tile.errors ? `, ${tile.errors} errors` : ''
  }${tile.warnings ? `, ${tile.warnings} warnings` : ''}`;
  return (
    <button
      type="button"
      className={`bx-gst-tile${tile.empty ? ' is-empty' : ''}${tile.errors > 0 ? ' has-errors' : ''}`}
      data-roving-item=""
      data-autofocus={autoFocus ? '' : undefined}
      aria-label={label}
      onClick={() => onOpen(tile)}
    >
      <span className="bx-gst-tile__head">
        <span className="bx-gst-tile__table">{tile.table}</span>
        <span className="bx-gst-tile__title">{tile.title}</span>
      </span>
      <span className="bx-gst-tile__help">{tile.help}</span>
      {/* A button may only contain phrasing content, so the figures are spans laid out as a grid. */}
      <span className="bx-gst-tile__figures" aria-hidden="true">
        <span className="bx-gst-tile__label">{tile.countLabel === 'documents' ? 'Documents' : tile.countLabel === 'rows' ? 'Rows' : 'Series'}</span>
        <span className="bx-gst-tile__value">{tile.count}</span>
        <span className="bx-gst-tile__label">Taxable</span>
        <span className="bx-gst-tile__value">{formatMoney(tile.taxable)}</span>
        <span className="bx-gst-tile__label">Tax</span>
        <span className="bx-gst-tile__value">{formatMoney(tile.tax)}</span>
      </span>
      <span className="bx-gst-tile__foot">
        {tile.errors > 0 ? (
          <Badge tone="danger" size="sm" icon="x-circle">
            {tile.errors} {tile.errors === 1 ? 'error' : 'errors'}
          </Badge>
        ) : null}
        {tile.warnings > 0 ? (
          <Badge tone="warning" size="sm" icon="alert">
            {tile.warnings} {tile.warnings === 1 ? 'warning' : 'warnings'}
          </Badge>
        ) : null}
        {tile.notes.length > 0 ? (
          <Badge tone="info" size="sm" icon="info" title={tile.notes.join(' ')}>
            Note
          </Badge>
        ) : null}
      </span>
    </button>
  );
}
