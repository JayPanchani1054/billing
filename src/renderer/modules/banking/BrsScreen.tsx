/**
 * 'banking.brs' — Bank Reconciliation (Tally style). Params: { ledgerId? }.
 *
 * As on the period's end date (Alt+F2). The grid lists the bank ledger's entries not yet reflected in the
 * bank (or reconciled ones / all, Ctrl+1/2/3); type the bank date in each row — '5', '5-4', '05042026',
 * 'v' (voucher date), '.' (same as above), empty to clear — Enter/↓ moves down, Shift+Enter/↑ up,
 * Ctrl+Enter opens the voucher. Alt+R gives every open row the statement date, Ctrl+A saves.
 * The balances panel reconciles books → bank and explains the difference with the imported statement.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { BrsEntry, BrsShow } from '../../../shared/types/banking.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../shared/format.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useDirty, useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReadOnlyNotice, ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { usePeriod } from '../../app/working.tsx';
import { todayLocal } from '../../../shared/dates.ts';
import { Badge, Banner, Card, EmptyState, Inline, SegmentedControl, Stack, TextInput, useToast } from '../../ui/index.ts';
import { BankSelect, NoBanks, useBanks, useDefaultBank } from './components.tsx';
import { CATEGORY_LABEL, evaluateRows, explainBrs, fillBankDates, pendingSave, projectedBankBalance, type BalanceLine } from './lib/brsGrid.ts';
import { brsExport } from './lib/exports.ts';

const SHOW_OPTIONS: ReadonlyArray<{ value: BrsShow; label: string }> = [
  { value: 'unreconciled', label: 'Unreconciled' },
  { value: 'reconciled', label: 'Reconciled' },
  { value: 'all', label: 'All' },
];

/** Rows rendered with an input each; more are summarised (the totals are always complete). */
const MAX_GRID_ROWS = 2000;

const CATEGORY_TONE: Record<BrsEntry['category'], 'warning' | 'info' | 'success' | 'neutral'> = {
  issued_not_presented: 'warning',
  deposited_not_cleared: 'info',
  cleared_before_voucher: 'neutral',
  reconciled: 'success',
};

export function BrsScreen({ params }: ScreenProps<{ ledgerId?: number }>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = useCan('banking.reconcile');
  const { to: asOf } = usePeriod();
  const today = todayLocal();
  const { banks, loading: banksLoading, error: banksError, refetch: refetchBanks } = useBanks(asOf);
  const [ledgerId, setLedgerIdRaw] = useState<number | null>(params.ledgerId ?? null);
  const setLedgerId = useCallback((id: number) => setLedgerIdRaw(id), []);
  useDefaultBank(banks, ledgerId, setLedgerId);
  const [show, setShow] = useState<BrsShow>('unreconciled');
  const [drafts, setDrafts] = useState<Map<number, string>>(() => new Map());
  const [active, setActive] = useState(0);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const q = useApiQuery('banking.brs', { ledgerId: ledgerId ?? 0, asOf, show }, { enabled: ledgerId !== null, keepPrevious: true });
  // Bank dates show in the cash/bank book and ledger reports too.
  const save = useApiMutation('banking.setBankDates', { invalidates: ['dashboard', 'reports'] });
  const brs = q.data;
  // While another bank / date / view loads, the previous list stays on screen: it must not be edited (a date
  // typed there would be saved on the wrong bank's entries).
  const stale = brs !== undefined && (brs.ledger.id !== ledgerId || brs.asOf !== asOf || brs.show !== show);
  const editable = canEdit && !stale;
  const entries = brs?.entries ?? NO_ENTRIES;
  const visible = useMemo(() => (entries.length > MAX_GRID_ROWS ? entries.slice(0, MAX_GRID_ROWS) : entries), [entries]);
  const states = useMemo(() => evaluateRows(visible, drafts, asOf, today), [visible, drafts, asOf, today]);
  const pending = useMemo(() => pendingSave(visible, states), [visible, states]);
  const projected = brs ? projectedBankBalance(brs, visible, states) : null;
  // Typed but unsaved dates (valid or not) are work in progress: Esc / switching company ask first.
  const dirty = pending.entries.length > 0 || pending.errors > 0;
  useDirty(dirty);
  const explanation = useMemo(() => (brs ? explainBrs(brs, (p) => formatMoney(p, { symbol: true })) : null), [brs]);

  const focusRow = (i: number): void => {
    const n = visible.length;
    if (n === 0) return;
    const idx = Math.max(0, Math.min(n - 1, i));
    setActive(idx);
    const el = inputs.current[idx];
    if (el) {
      el.focus();
      el.select();
      el.scrollIntoView({ block: 'nearest' });
    }
  };

  const openVoucher = (e: BrsEntry | undefined): void => {
    if (e) nav.push('vouchers.view', { id: e.voucherId });
  };

  const changeLedger = async (id: number | null): Promise<void> => {
    if (id === null || id === ledgerId) return;
    if (dirty && !(await confirm({ title: 'Discard bank dates you typed?', message: 'They have not been saved. Save first with Ctrl+A to keep them.', confirmLabel: 'Discard', tone: 'danger' }))) return;
    setDrafts(new Map());
    setActive(0);
    setLedgerIdRaw(id);
  };

  /** Switch the view (unreconciled / reconciled / all): rows change, so typed dates are saved or dropped first. */
  const changeShow = async (next: BrsShow): Promise<void> => {
    if (next === show) return;
    if (dirty && !(await confirm({ title: 'Discard bank dates you typed?', message: 'Switching the view lists other entries. Save first with Ctrl+A to keep the dates.', confirmLabel: 'Discard', tone: 'danger' }))) return;
    setDrafts(new Map());
    setActive(0);
    setShow(next);
  };

  const submit = async (): Promise<void> => {
    if (!editable) return;
    if (pending.errors > 0) {
      toast.error(`${pending.errors} bank date${pending.errors === 1 ? ' needs' : 's need'} correcting before saving`, { message: 'Rows with a problem are marked in red.' });
      return;
    }
    if (pending.entries.length === 0) {
      toast.info('Nothing to save — type a bank date first.');
      return;
    }
    try {
      const res = await save.mutate({ entries: pending.entries });
      // Keep the typed values on screen until the fresh list arrives (no flicker back to the old dates).
      await q.refetch();
      setDrafts(new Map());
      const extra = res.unmatchedLines > 0 ? ` ${res.unmatchedLines} statement line${res.unmatchedLines === 1 ? ' was' : 's were'} unmatched.` : '';
      toast.success(`Bank dates saved for ${res.updated} entr${res.updated === 1 ? 'y' : 'ies'}`, extra ? { message: extra.trim() } : undefined);
    } catch (err) {
      toast.error('Bank dates were not saved', { message: userMessage(err) });
    }
  };

  const fillAll = (): void => {
    if (!brs || !editable) return;
    const date = brs.statementDate ?? asOf;
    const out = fillBankDates(visible, drafts, date, today);
    setDrafts(out.drafts);
    if (out.filled === 0) toast.info('Every row already has a bank date.');
    else {
      toast.info(`Bank date ${formatDate(date)} filled in ${out.filled} row${out.filled === 1 ? '' : 's'}`, {
        message: `${out.skipped > 0 ? `${out.skipped} row${out.skipped === 1 ? ' is' : 's are'} dated later and were left blank. ` : ''}Clear the rows the statement does not show, then save with Ctrl+A.`,
      });
    }
  };

  const discard = async (): Promise<void> => {
    if (drafts.size === 0) return;
    if (await confirm({ title: 'Discard the bank dates you typed?', confirmLabel: 'Discard', tone: 'danger' })) setDrafts(new Map());
  };

  const onCellKey = (e: ReactKeyboardEvent<HTMLInputElement>, i: number): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      openVoucher(visible[i]);
    } else if (e.key === 'Enter' && !e.shiftKey && i === visible.length - 1 && pending.entries.length > 0) {
      // Enter on the last row accepts, like Tally.
      e.preventDefault();
      void submit();
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(i + 1);
    } else if ((e.key === 'Enter' && e.shiftKey) || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(i - 1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      focusRow(i + 15);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      focusRow(i - 15);
    }
  };

  const setDraft = (id: number, text: string): void => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(id, text);
      return next;
    });
  };

  if (!banksLoading && !banksError && banks.length === 0) {
    return (
      <ReportScreen title="Bank Reconciliation" periodMode="asOn">
        <NoBanks />
      </ReportScreen>
    );
  }

  const bank = banks.find((b) => b.id === ledgerId) ?? null;
  return (
    <ReportScreen
      title="Bank Reconciliation"
      subtitle={bank ? `${bank.name}${bank.accountNo ? ` · A/c ${bank.accountNo}` : ''}` : undefined}
      periodMode="asOn"
      loading={banksLoading || (q.loading && !brs)}
      refreshing={q.refreshing}
      error={banksError ?? q.error}
      onRetry={() => {
        void refetchBanks();
        void q.refetch();
      }}
      exportDef={brs ? () => brsExport(brs) : undefined}
      hint="Type a bank date: 5 · 5-4 · v voucher date · . same as above · blank clears · Enter Next row (on the last row: save) · Ctrl+Enter Open voucher · Ctrl+A Save"
      filters={
        <Inline gap={2} wrap>
          <BankSelect banks={banks} value={ledgerId} onChange={(id) => void changeLedger(id)} aria-label="Bank account to reconcile" />
          <SegmentedControl aria-label="Entries to show" size="sm" options={SHOW_OPTIONS} value={show} onChange={(v) => void changeShow(v)} />
        </Inline>
      }
      actions={[
        { key: 'Ctrl+A', label: 'Save bank dates', icon: 'save', primary: true, onClick: () => void submit(), disabled: pending.entries.length === 0 || save.pending || stale, hidden: !canEdit },
        { key: 'Alt+R', label: 'Set all to statement date', icon: 'calendar', onClick: fillAll, hidden: !canEdit, disabled: visible.length === 0 || stale, hint: 'Fill every row without a bank date with the statement date' },
        { key: 'Alt+X', label: 'Discard typed dates', icon: 'undo', onClick: () => void discard(), hidden: !canEdit, disabled: drafts.size === 0 },
        { key: 'Ctrl+1', label: 'Unreconciled', onClick: () => void changeShow('unreconciled'), group: 'view', disabled: show === 'unreconciled' },
        { key: 'Ctrl+2', label: 'Reconciled', onClick: () => void changeShow('reconciled'), group: 'view', disabled: show === 'reconciled' },
        { key: 'Ctrl+3', label: 'All entries', onClick: () => void changeShow('all'), group: 'view', disabled: show === 'all' },
        { key: 'Alt+O', label: 'Open voucher', icon: 'drill', onClick: () => openVoucher(visible[active]), group: 'go', disabled: visible.length === 0 },
        { key: 'Alt+I', label: 'Import statement', icon: 'upload', onClick: () => nav.push('banking.import', { ledgerId: ledgerId ?? undefined }), group: 'go', hidden: !canEdit },
        { key: 'Alt+M', label: 'Match statement', icon: 'link', onClick: () => nav.push('banking.match', { ledgerId: ledgerId ?? undefined }), group: 'go', hidden: !canEdit },
      ]}
    >
      <div className="bx-bk-split">
        <Stack gap={2}>
          {!canEdit ? <ReadOnlyNotice what="the bank reconciliation" /> : null}
          {brs?.truncated || entries.length > MAX_GRID_ROWS ? (
            <Banner tone="info" inline>
              Showing the first {visible.length.toLocaleString('en-IN')} entries. Choose an earlier date (Alt+F2) or the Unreconciled view to see fewer; the balances include every entry.
            </Banner>
          ) : null}
          {visible.length === 0 && brs ? (
            <EmptyState
              icon="check-circle"
              title={show === 'unreconciled' ? `Everything is reconciled as on ${formatDate(asOf)}` : 'No entries to show'}
              body={
                show === 'unreconciled'
                  ? 'Every payment and receipt of this bank has a bank date on or before this date. Press Ctrl+2 to see the reconciled entries.'
                  : 'No entries of this bank in this period. Change the date with Alt+F2.'
              }
            />
          ) : (
            <div className="bx-bk-grid-wrap">
              <table className="bx-bk-grid" aria-label={`Entries of ${bank?.name ?? 'the bank'} to reconcile`}>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Particulars</th>
                    <th scope="col">Vch Type</th>
                    <th scope="col">Instrument</th>
                    <th scope="col" className="bx-bk-num">
                      Debit
                    </th>
                    <th scope="col" className="bx-bk-num">
                      Credit
                    </th>
                    <th scope="col">Bank Date</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e, i) => {
                    const st = states.get(e.ledgerEntryId);
                    const text = drafts.get(e.ledgerEntryId) ?? (e.bankDate ? formatDate(e.bankDate) : '');
                    const errId = `bk-err-${e.ledgerEntryId}`;
                    return (
                      <tr
                        key={e.ledgerEntryId}
                        className={[i === active ? 'is-active' : '', st?.changed ? 'is-changed' : ''].join(' ').trim() || undefined}
                        onDoubleClick={() => openVoucher(e)}
                      >
                        <td className="bx-num">{formatDate(e.date)}</td>
                        <td className="bx-bk-particulars">
                          <span className="bx-truncate" title={e.particulars}>
                            {e.particulars}
                          </span>
                          {e.narration ? <span className="bx-bk-sub bx-truncate">{e.narration}</span> : null}
                        </td>
                        <td>
                          {e.voucherType}
                          {e.number ? <span className="bx-bk-sub">No. {e.number}</span> : null}
                        </td>
                        <td>
                          {e.instrumentType ? e.instrumentType.toUpperCase() : ''} {e.instrumentNo ?? ''}
                          {e.instrumentDate ? <span className="bx-bk-sub">dated {formatDate(e.instrumentDate)}</span> : null}
                        </td>
                        <td className="bx-bk-num">{e.debit ? formatMoney(e.debit) : ''}</td>
                        <td className="bx-bk-num">{e.credit ? formatMoney(e.credit) : ''}</td>
                        <td className="bx-bk-date">
                          <TextInput
                            ref={(el) => {
                              inputs.current[i] = el;
                            }}
                            size="sm"
                            value={text}
                            readOnly={!editable}
                            selectOnFocus
                            invalid={Boolean(st?.error)}
                            aria-label={`Bank date for ${e.voucherType} ${e.number ?? ''} dated ${formatDate(e.date)}, ${e.debit ? `debit ${formatMoney(e.debit)}` : `credit ${formatMoney(e.credit)}`}`}
                            aria-describedby={st?.error ? errId : undefined}
                            placeholder={canEdit ? 'dd-mm-yyyy' : ''}
                            onFocus={() => setActive(i)}
                            onChange={(ev) => setDraft(e.ledgerEntryId, ev.target.value)}
                            onKeyDown={(ev) => onCellKey(ev, i)}
                            onBlur={() => {
                              const s = states.get(e.ledgerEntryId);
                              if (s && !s.error && s.effective && drafts.has(e.ledgerEntryId)) setDraft(e.ledgerEntryId, formatDate(s.effective));
                            }}
                          />
                          {st?.error ? (
                            <span id={errId} className="bx-bk-cell-error" role="alert">
                              {st.error}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <Inline gap={1} wrap={false}>
                            <Badge size="sm" tone={CATEGORY_TONE[e.category]}>
                              {CATEGORY_LABEL[e.category]}
                            </Badge>
                            {e.statementLineId !== null ? (
                              <Badge size="sm" tone="neutral" icon="link">
                                Statement
                              </Badge>
                            ) : null}
                          </Inline>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Stack>
        {brs && explanation ? (
          <Stack gap={2}>
            <Card title="Books and bank" subtitle={`As on ${formatDate(brs.asOf)}`} padding="sm">
              <ul className="bx-bk-balances" aria-label="Reconciliation of balances">
                {explanation.lines.map((l) => (
                  <BalanceRow key={l.key} line={l} />
                ))}
                {pending.entries.length > 0 && projected !== null ? (
                  <BalanceRow
                    line={{ key: 'projected', label: `Balance as per bank after saving ${pending.entries.length} change${pending.entries.length === 1 ? '' : 's'}`, amount: projected, kind: 'drcr', strong: true }}
                  />
                ) : null}
              </ul>
            </Card>
            <Banner
              tone={explanation.status === 'agrees' ? 'success' : explanation.status === 'unexplained' ? 'warning' : 'info'}
              title={
                explanation.status === 'agrees'
                  ? 'Reconciled'
                  : explanation.status === 'explained'
                    ? 'Difference explained'
                    : explanation.status === 'unexplained'
                      ? 'Difference to check'
                      : 'Check with your statement'
              }
            >
              {explanation.message}
            </Banner>
          </Stack>
        ) : null}
      </div>
    </ReportScreen>
  );
}

const NO_ENTRIES: readonly BrsEntry[] = [];

function BalanceRow({ line }: { line: BalanceLine }) {
  const amount = line.kind === 'drcr' ? formatDrCr(line.amount, { keepZero: true }) : formatMoney(line.amount);
  return (
    <li className={`bx-bk-balances__row${line.strong ? ' bx-bk-balances__row--strong' : ''}`}>
      <span className="bx-bk-balances__op" aria-hidden={line.op ? undefined : true}>
        {line.op === '+' ? <span aria-label="add">+</span> : line.op === '−' ? <span aria-label="less">−</span> : ''}
      </span>
      <span>
        {line.label}
        {line.note ? <span className="bx-bk-balances__note">{line.note}</span> : null}
      </span>
      <span className="bx-bk-balances__amount">{amount}</span>
    </li>
  );
}
