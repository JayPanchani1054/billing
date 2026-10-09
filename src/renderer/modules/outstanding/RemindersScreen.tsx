/**
 * 'outstanding.reminders' { ledgerId?, groupId? } — payment reminder letters for customers with
 * overdue bills, as on the period's end date (Alt+F2). Left: the customers (amount due after
 * unadjusted receipts, tone gentle / second / firm); Space includes or skips a customer for batch
 * printing. Right: the letter preview (plain React text — never HTML). Print / PDF one letter or
 * every included letter (one page each), copy the letter text for WhatsApp or e-mail, export the
 * follow-up list (Alt+E).
 */
import { useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { ReminderLetter, ReminderParty } from '../../../shared/types/outstanding.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { EXPORT_PERMISSION, exportTable, savePdf, showInFolder } from '../../app/export.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenActionItem } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { EXPORT_DENIED_HINT, ExportDialog, ReportScreen } from '../../app/Screen.tsx';
import { usePeriod } from '../../app/working.tsx';
import { useAppState } from '../../app/state.tsx';
import { Badge, Button, DataTable, EmptyState, Field, Grid, Icon, Inline, KpiCard, NumberInput, Tag, useDebouncedValue, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GroupSelect, OverdueBadge, VGap, printedOn, useDocumentOutput, useGroupOptions } from './components.tsx';
import { buildLettersHtml, pdfName } from './lib/printHtml.ts';
import { TONE_TEXT, clampMinDays, letterNumericColumns, remindersExport, remindersQuery, selectedParties, toggleAll, toggleExcluded } from './lib/reminders.ts';

export interface RemindersParams {
  ledgerId?: number;
  groupId?: number;
}

export function RemindersScreen({ params }: ScreenProps<RemindersParams>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const app = useAppState();
  const out = useDocumentOutput();
  const { to: asOf } = usePeriod();
  const p = params ?? {};
  const [ledgerId, setLedgerId] = useState<number | undefined>(typeof p.ledgerId === 'number' ? p.ledgerId : undefined);
  const [groupId, setGroupId] = useState<number | undefined>(typeof p.groupId === 'number' ? p.groupId : undefined);
  const [minDays, setMinDays] = useState<number | null>(1);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [cursorId, setCursorId] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const minRef = useRef<HTMLInputElement | null>(null);
  const groups = useGroupOptions('receivable');

  const min = useDebouncedValue(clampMinDays(minDays), 300);
  const q = useApiQuery('outstanding.reminders', remindersQuery({ asOf, minDays: min, groupId, ledgerId }), { keepPrevious: true });
  // Name for the single-customer tag even when that customer has nothing to remind about.
  const single = useApiQuery('outstanding.ledgerBills', { ledgerId: ledgerId ?? 0, asOf }, { enabled: ledgerId !== undefined, staleTime: 60_000 });
  const d = q.data;
  const parties = d?.parties ?? [];
  const current = parties.find((x) => x.ledgerId === cursorId) ?? parties[0] ?? null;
  const chosen = useMemo(() => selectedParties(parties, excluded), [parties, excluded]);
  const chosenDue = chosen.reduce((s, x) => s + x.amountDue, 0);
  const onlyName =
    ledgerId !== undefined ? (parties.find((x) => x.ledgerId === ledgerId)?.ledgerName ?? (single.data?.ledger.id === ledgerId ? single.data.ledger.name : 'One customer')) : null;
  const companyName = app.company?.mailingName || app.company?.name || '';

  const columns = useMemo<Column<ReminderParty>[]>(
    () => [
      {
        key: 'include',
        header: 'Print',
        headerLabel: 'Included in batch printing',
        width: 64,
        value: (r) => (excluded.has(r.ledgerId) ? 'Skipped' : 'Included'),
        render: (r) =>
          excluded.has(r.ledgerId) ? (
            <span className="bx-muted">Skip</span>
          ) : (
            <Icon name="check" size="sm" label="Included in batch" />
          ),
      },
      { key: 'ledgerName', header: 'Customer', minWidth: 160, sortable: true },
      { key: 'oldestOverdueDays', header: 'Oldest', width: 100, align: 'right', sortable: true, render: (r) => <OverdueBadge days={r.oldestOverdueDays} /> },
      { key: 'amountDue', header: 'Amount due', kind: 'amount', width: 130, sortable: true, total: true },
      {
        key: 'tone',
        header: 'Letter',
        width: 90,
        value: (r) => TONE_TEXT[r.tone].label,
        render: (r) => (
          <Badge size="sm" tone={TONE_TEXT[r.tone].tone}>
            {TONE_TEXT[r.tone].label}
          </Badge>
        ),
      },
    ],
    [excluded],
  );

  const printOne = (): void => {
    if (current) void out.print(buildLettersHtml([current.letter], { printedOn: printedOn() }));
  };
  const pdfOne = (): void => {
    if (current) void out.pdf(buildLettersHtml([current.letter], { printedOn: printedOn() }), pdfName('Reminder', current.ledgerName));
  };
  const copyOne = (): void => {
    if (current) void out.copy(current.letter.text, `Reminder for ${current.ledgerName}`);
  };
  const batch = async (kind: 'print' | 'pdf'): Promise<void> => {
    if (chosen.length === 0) {
      toast.info('No letters selected', { message: 'Press Space on a customer to include it, or Alt+A to include everyone.' });
      return;
    }
    if (kind === 'print' && chosen.length > 10) {
      const ok = await confirm({
        title: `Print ${chosen.length} reminder letters?`,
        message: `Each letter prints on its own page — ${chosen.length} pages in all. Amount asked for: ${formatMoney(chosenDue, { symbol: true })}.`,
        confirmLabel: 'Print all',
      });
      if (!ok) return;
    }
    const html = buildLettersHtml(
      chosen.map((x) => x.letter),
      { printedOn: printedOn() },
    );
    if (kind === 'print') await out.print(html);
    else await out.pdf(html, chosen.length === 1 ? pdfName('Reminder', chosen[0].ledgerName) : pdfName('Reminders', formatDate(asOf, 'DD-MM-YYYY')));
  };
  const exportList = async (format: 'xlsx' | 'csv' | 'pdf'): Promise<void> => {
    setExportOpen(false);
    if (!d) return;
    const def = { title: 'Payment Reminders', company: companyName, period: `As on ${formatDate(d.asOf)}`, ...remindersExport(d) };
    try {
      const r = format === 'pdf' ? await savePdf(def) : await exportTable(def, format);
      if (r) {
        const name = r.path.split(/[\\/]/).pop() ?? r.path;
        toast.success(`Saved ${name}`, { action: { label: 'Show in folder', onClick: () => showInFolder(r.path) } });
      }
    } catch (err) {
      toast.error('Could not export', { message: userMessage(err) });
    }
  };

  const actions: ScreenActionItem[] = [
    { key: 'Alt+P', label: 'Print letter', icon: 'print', onClick: printOne, disabled: !current, group: 'letter', primary: true, hint: current ? `Print the letter to ${current.ledgerName}` : undefined },
    { key: 'Alt+S', label: 'Save letter as PDF', icon: 'download', onClick: pdfOne, disabled: !current, group: 'letter' },
    { key: 'Alt+T', label: 'Copy letter text', icon: 'copy', onClick: copyOne, disabled: !current, group: 'letter', hint: 'Plain text for WhatsApp or e-mail' },
    { key: 'Alt+B', label: `Print ${chosen.length} ${chosen.length === 1 ? 'letter' : 'letters'}`, icon: 'print', onClick: () => void batch('print'), disabled: chosen.length === 0, group: 'batch' },
    { key: 'Alt+M', label: 'Save all as one PDF', icon: 'download', onClick: () => void batch('pdf'), disabled: chosen.length === 0, group: 'batch' },
    { key: 'Alt+A', label: excluded.size > 0 ? 'Include everyone' : 'Skip everyone', icon: 'check', onClick: () => setExcluded(toggleAll(parties, excluded)), disabled: parties.length === 0, group: 'batch' },
    { key: 'Alt+F', label: 'Overdue by', icon: 'filter', onClick: () => minRef.current?.focus(), group: 'filter' },
    { key: 'Alt+W', label: 'All customers', icon: 'users', onClick: () => setLedgerId(undefined), hidden: ledgerId === undefined, group: 'filter', hint: 'Show every customer with overdue bills, not just this one' },
    { key: 'Alt+O', label: 'Party outstanding', icon: 'list', onClick: () => current && nav.push('outstanding.party', { ledgerId: current.ledgerId }), disabled: !current, group: 'party' },
    { key: 'Alt+E', label: 'Export list', icon: 'export', onClick: () => setExportOpen(true), disabled: !d || parties.length === 0 || !app.can(EXPORT_PERMISSION), group: 'output', hint: app.can(EXPORT_PERMISSION) ? undefined : EXPORT_DENIED_HINT },
  ];

  const filtered = ledgerId !== undefined || groupId !== undefined || min > 1;

  return (
    <>
      <ReportScreen
        title="Payment Reminders"
        subtitle={d ? `${d.totals.partyCount} ${d.totals.partyCount === 1 ? 'customer' : 'customers'} to remind` : undefined}
        periodMode="asOn"
        loading={q.loading && !d}
        refreshing={q.refreshing || (q.loading && d !== undefined)}
        error={q.error}
        onRetry={() => void q.refetch()}
        actions={actions}
        hint={`Enter Party · Space Include/skip · Alt+P Print · Alt+S PDF · Alt+T Copy text · Alt+B Print all${ledgerId !== undefined ? ' · Alt+W All customers' : ''} · Alt+F2 As on · Esc Back`}
        filters={
          <Inline gap={2}>
            <Field label="Overdue by at least" layout="inline" labelWidth="auto">
              <NumberInput ref={minRef} size="sm" value={minDays} onChange={(v) => setMinDays(v === null ? null : Math.max(1, Math.round(v)))} min={1} max={36_500} suffix="days" style={{ width: 100 }} aria-keyshortcuts="Alt+F" />
            </Field>
            {onlyName !== null ? (
              <Tag tone="brand" icon="user" onRemove={() => setLedgerId(undefined)} removeLabel="Show every customer">
                {onlyName}
              </Tag>
            ) : (
              <GroupSelect options={groups} value={groupId} onChange={setGroupId} allLabel="All debtors" />
            )}
          </Inline>
        }
      >
        {d && parties.length > 0 ? (
          <>
            <Grid minItemWidth={170} gap={3}>
              <KpiCard label="Amount to ask for" value={d.totals.amountDue} amount icon="rupee" caption="Overdue bills less unadjusted receipts" />
              <KpiCard label="Customers" value={String(d.totals.partyCount)} icon="users" caption={`Overdue by ${min}+ ${min === 1 ? 'day' : 'days'}`} />
              <KpiCard label="Selected for printing" value={String(chosen.length)} icon="print" caption={formatMoney(chosenDue, { symbol: true })} />
              <KpiCard
                label="Firm reminders"
                value={String(parties.filter((x) => x.tone === 'firm').length)}
                icon="alert"
                caption={TONE_TEXT.firm.description}
              />
            </Grid>
            <VGap />
            <div className="bx-os-split">
              <div>
                <DataTable<ReminderParty>
                  aria-label="Customers to remind"
                  autoFocus
                  columns={columns}
                  rows={parties}
                  getRowKey={(r) => String(r.ledgerId)}
                  selectedKey={current ? String(current.ledgerId) : undefined}
                  onSelect={(_, r) => setCursorId(r ? r.ledgerId : null)}
                  onRowActivate={(r) => nav.push('outstanding.party', { ledgerId: r.ledgerId })}
                  onRowKeyDown={(e, r) => {
                    if (r && e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                      e.preventDefault();
                      setExcluded((x) => toggleExcluded(x, r.ledgerId));
                    }
                  }}
                  typeToJump={(r) => r.ledgerName}
                />
              </div>
              <div>
                {current ? (
                  <>
                    <Inline gap={2} justify="between">
                      <span className="bx-muted">
                        {current.overdueBills.length} overdue {current.overdueBills.length === 1 ? 'bill' : 'bills'}
                        {current.unadjustedCredits !== 0 ? ` · ${formatMoney(-current.unadjustedCredits, { symbol: true })} received but not yet adjusted` : ''}
                        {current.mobile ? ` · ${current.mobile}` : ''}
                        {current.email ? ` · ${current.email}` : ''}
                      </span>
                      <Inline gap={1}>
                        <Button size="sm" icon="copy" shortcut="Alt+T" onClick={copyOne}>
                          Copy text
                        </Button>
                        <Button size="sm" icon="download" shortcut="Alt+S" onClick={pdfOne}>
                          PDF
                        </Button>
                        <Button size="sm" variant="primary" icon="print" shortcut="Alt+P" onClick={printOne}>
                          Print
                        </Button>
                      </Inline>
                    </Inline>
                    <VGap />
                    <LetterPreview letter={current.letter} label={`Reminder letter to ${current.ledgerName}`} />
                  </>
                ) : null}
              </div>
            </div>
          </>
        ) : d ? (
          <EmptyState
            icon="check-circle"
            title={`No reminders needed as on ${formatDate(asOf)}`}
            body={
              filtered
                ? 'No customer matches these filters — lower “Overdue by” or show every customer.'
                : 'No customer has overdue bills, or the money they have already paid on account covers what is overdue.'
            }
          />
        ) : null}
      </ReportScreen>
      {exportOpen ? <ExportDialog title="Payment Reminders" onClose={() => setExportOpen(false)} onPick={(f) => void exportList(f)} /> : null}
    </>
  );
}

/** The letter as on paper — rendered as text nodes (no HTML strings). */
export function LetterPreview({ letter, label }: { letter: ReminderLetter; label: string }) {
  const numeric = letterNumericColumns(letter.table);
  const [firstFrom, ...restFrom] = letter.from;
  const [toLabel, ...toLines] = letter.to;
  return (
    <article className="bx-os-letter" aria-label={label} tabIndex={0}>
      <header className="bx-os-letter__head">
        <div className="bx-os-letter__company">{firstFrom}</div>
        {restFrom.map((l, i) => (
          <div key={i} className="bx-os-letter__line">
            {l}
          </div>
        ))}
      </header>
      <div className="bx-os-letter__date">Date: {letter.date}</div>
      <div className="bx-os-letter__to">
        <div>{toLabel}</div>
        {toLines.map((l, i) => (
          <div key={i}>{i === 0 ? <strong>{l}</strong> : l}</div>
        ))}
      </div>
      <div className="bx-os-letter__subject">Subject: {letter.subject}</div>
      <p>{letter.salutation}</p>
      {letter.opening.map((x, i) => (
        <p key={i}>{x}</p>
      ))}
      <table>
        <thead>
          <tr>
            {letter.table.columns.map((c, i) => (
              <th key={i} scope="col" className={numeric[i] ? 'is-num' : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {letter.table.rows.map((r, ri) => (
            <tr key={ri}>
              {letter.table.columns.map((_, i) => (
                <td key={i} className={numeric[i] ? 'is-num' : undefined}>
                  {r[i] ?? ''}
                </td>
              ))}
            </tr>
          ))}
          <tr className="is-total">
            {letter.table.columns.map((_, i) => (
              <td key={i} className={numeric[i] ? 'is-num' : undefined}>
                {letter.table.total[i] ?? ''}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {letter.closing.map((x, i) => (
        <p key={i}>{x}</p>
      ))}
      <div className="bx-os-letter__signoff">
        {letter.signOff.map((x, i) => (x === '' ? <div key={i} className="bx-os-letter__gap" /> : <div key={i}>{x}</div>))}
      </div>
    </article>
  );
}
