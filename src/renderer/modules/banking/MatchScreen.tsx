/**
 * 'banking.match' — Match the imported bank statement with vouchers. Params: { ledgerId?, batchId?, autorun? }.
 *
 * Tabs (Alt+1…4): Matched · Suggestions · Unmatched · Ignored, over the period (Alt+F2) and optionally one
 * imported statement. Alt+M runs auto-match (only confident, unambiguous pairs are applied; the rest become
 * suggestions). Enter on a line opens the match picker (candidates with the reasons for their score).
 * Unmatched lines: Alt+V creates a voucher for the line (Receipt / Payment / Contra with a ledger picker),
 * Alt+B creates vouchers for many lines at once (all or nothing), Alt+I ignores / restores a line.
 * Matched lines: Enter opens the voucher, Alt+U unmatches.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FromLineKind, MatchCandidate, StatementLineView } from '../../../shared/types/banking.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { withConfirmation } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReadOnlyNotice, ReportScreen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { usePeriod } from '../../app/working.tsx';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Inline,
  Modal,
  NumberInput,
  Picker,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  TextInput,
  useHotkeys,
  useToast,
} from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { BankSelect, LineStatusBadge, NoBanks, useBanks, useDefaultBank, useLedgerOptions } from './components.tsx';
import {
  KIND_LABEL,
  allowedKinds,
  buildCreateItems,
  countTabs,
  defaultKind,
  ledgerFitsKind,
  reasonsText,
  suggestLedger,
  tabOf,
  type CreateDraft,
  type LedgerOption,
  type MatchTab,
} from './lib/matchReview.ts';

export interface MatchParams {
  ledgerId?: number;
  batchId?: number;
  /** Run auto-match once when the screen opens (after an import). */
  autorun?: boolean;
}

const BOOK_ROUTES = ['vouchers', 'reports', 'outstanding', 'dashboard', 'gst'];
const TAB_ORDER: readonly MatchTab[] = ['matched', 'suggestions', 'unmatched', 'ignored'];
const NO_LINES: readonly StatementLineView[] = [];

export function MatchScreen({ params }: ScreenProps<MatchParams>) {
  const nav = useNav();
  const toast = useToast();
  const canEdit = useCan('banking.reconcile');
  const canCreate = useCan('vouchers.create');
  const { from, to } = usePeriod();
  const { banks, loading: banksLoading, error: banksError, refetch: refetchBanks } = useBanks(to);
  const [ledgerId, setLedgerId] = useState<number | null>(params.ledgerId ?? null);
  useDefaultBank(banks, ledgerId, setLedgerId);
  const [batchId, setBatchId] = useState<number | null>(params.batchId ?? null);
  const [windowDays, setWindowDays] = useState<number | null>(7);
  const [tab, setTab] = useState<MatchTab>('unmatched');
  const [cursor, setCursor] = useState<Record<MatchTab, string | null>>({ matched: null, suggestions: null, unmatched: null, ignored: null });
  const [suggested, setSuggested] = useState<Map<number, MatchCandidate[]>>(() => new Map());
  const [picking, setPicking] = useState<StatementLineView | null>(null);
  const [creating, setCreating] = useState<StatementLineView | null>(null);
  const [bulk, setBulk] = useState(false);

  // When the statement was imported for dates outside the period, widen the lines' range to the batch.
  const batches = useApiQuery('banking.statement.batches', { ledgerId: ledgerId ?? undefined }, { enabled: ledgerId !== null });
  const batch = batches.data?.find((b) => b.id === batchId) ?? null;
  const rangeFrom = batch?.from && batch.from < from ? batch.from : from;
  const rangeTo = batch?.to && batch.to > to ? batch.to : to;
  const lines = useApiQuery(
    'banking.statement.lines',
    { ledgerId: ledgerId ?? 0, from: rangeFrom, to: rangeTo, batchId: batchId ?? undefined, limit: 10_000 },
    { enabled: ledgerId !== null, keepPrevious: true },
  );
  const rows = lines.data?.rows ?? NO_LINES;
  const suggestedIds = useMemo(() => new Set(suggested.keys()), [suggested]);
  const counts = useMemo(() => countTabs(rows, suggestedIds), [rows, suggestedIds]);
  const byTab = useMemo(() => {
    const out: Record<MatchTab, StatementLineView[]> = { matched: [], suggestions: [], unmatched: [], ignored: [] };
    for (const r of rows) out[tabOf(r, suggestedIds)].push(r);
    return out;
  }, [rows, suggestedIds]);

  const auto = useApiMutation('banking.autoMatch', { invalidates: ['dashboard'] });
  const unmatch = useApiMutation('banking.unmatch');
  const ignore = useApiMutation('banking.ignoreLine');

  const runAutoMatch = async (): Promise<void> => {
    if (ledgerId === null || !canEdit) return;
    try {
      const res = await auto.mutate({ ledgerId, batchId: batchId ?? undefined, dateWindowDays: windowDays ?? undefined });
      setSuggested(new Map(res.suggestions.map((s) => [s.line.id, s.candidates])));
      const parts = [`${res.applied.length} line${res.applied.length === 1 ? '' : 's'} matched automatically`];
      if (res.suggestions.length > 0) parts.push(`${res.suggestions.length} need your choice`);
      if (res.withoutCandidates > 0) parts.push(`${res.withoutCandidates} have no voucher yet`);
      toast.success(parts.join(' · '));
      setTab(res.suggestions.length > 0 ? 'suggestions' : res.withoutCandidates > 0 ? 'unmatched' : 'matched');
    } catch (err) {
      toast.error('Auto-match did not run', { message: userMessage(err) });
    }
  };

  const autoran = useRef(false);
  useEffect(() => {
    if (!params.autorun || autoran.current || ledgerId === null || !canEdit) return;
    autoran.current = true;
    void runAutoMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when the bank is known
  }, [params.autorun, ledgerId, canEdit]);

  const current = (t: MatchTab = tab): StatementLineView | null => {
    const list = byTab[t];
    const key = cursor[t];
    return list.find((l) => String(l.id) === key) ?? list[0] ?? null;
  };

  const doUnmatch = async (line: StatementLineView | null): Promise<void> => {
    if (!line || !canEdit) return;
    try {
      await unmatch.mutate({ lineId: line.id });
      if (line.status === 'created') {
        toast.success('Unmatched — the voucher created from this line is kept, without a bank date', {
          message: 'Match the line with it again (Enter), or delete the voucher if it was wrong. Creating another voucher would count the amount twice.',
        });
      } else toast.success('Unmatched — the voucher no longer has a bank date');
    } catch (err) {
      toast.error('Could not unmatch', { message: userMessage(err) });
    }
  };

  const doIgnore = async (line: StatementLineView | null, value: boolean): Promise<void> => {
    if (!line || !canEdit) return;
    try {
      await ignore.mutate({ lineId: line.id, ignore: value });
      setSuggested((prev) => {
        const next = new Map(prev);
        next.delete(line.id);
        return next;
      });
      toast.info(value ? 'Line ignored — it stays out of matching (shown as "not in books" in the BRS)' : 'Line restored to Unmatched');
    } catch (err) {
      toast.error('Could not change the line', { message: userMessage(err) });
    }
  };

  const activate = (line: StatementLineView): void => {
    if (line.status === 'matched' || line.status === 'created') {
      if (line.matched) nav.push('vouchers.view', { id: line.matched.voucherId });
    } else if (line.status === 'unmatched' && canEdit) setPicking(line);
  };

  const onMatched = (lineId: number): void => {
    setSuggested((prev) => {
      const next = new Map(prev);
      next.delete(lineId);
      return next;
    });
  };

  const lineColumns = useMemo<Column<StatementLineView>[]>(() => {
    const base: Column<StatementLineView>[] = [
      { key: 'txnDate', header: 'Date', kind: 'date', width: 104, sortable: true },
      { key: 'description', header: 'Narration (bank)', minWidth: 220, title: (r) => r.description, sortable: true },
      { key: 'reference', header: 'Ref. no.', width: 130 },
      { key: 'withdrawal', header: 'Withdrawal', kind: 'amount', width: 120, blankZero: true, total: true, sortable: true },
      { key: 'deposit', header: 'Deposit', kind: 'amount', width: 120, blankZero: true, total: true, sortable: true },
    ];
    if (tab === 'matched') {
      base.push(
        {
          key: 'voucher',
          header: 'Voucher',
          width: 190,
          value: (r) => (r.matched ? `${r.matched.voucherType} ${r.matched.number ?? ''}` : ''),
          render: (r) =>
            r.matched ? (
              <span>
                {r.matched.voucherType} {r.matched.number ?? ''} <span className="bx-muted">{formatDate(r.matched.date)}</span>
              </span>
            ) : (
              ''
            ),
        },
        { key: 'particulars', header: 'Particulars', minWidth: 160, value: (r) => r.matched?.particulars ?? '' },
        {
          key: 'how',
          header: 'How',
          width: 130,
          render: (r) => (
            <Badge size="sm" tone={r.matchMethod === 'auto' ? 'success' : r.matchMethod === 'created' ? 'info' : 'neutral'}>
              {r.matchMethod === 'auto' ? `Auto${r.matchScore !== null ? ` · ${Math.round(r.matchScore)}` : ''}` : r.matchMethod === 'created' ? 'Voucher created' : 'Manual'}
            </Badge>
          ),
        },
      );
    } else if (tab === 'suggestions') {
      base.push(
        {
          key: 'best',
          header: 'Best match',
          minWidth: 220,
          value: (r) => {
            const c = suggested.get(r.id)?.[0];
            return c ? `${c.voucherType} ${c.number ?? ''} ${c.particulars}` : '';
          },
          render: (r) => {
            const list = suggested.get(r.id) ?? [];
            const c = list[0];
            if (!c) return '';
            return (
              <Inline gap={1} wrap={false}>
                <span className="bx-truncate">
                  {c.voucherType} {c.number ?? ''} · {c.particulars} · {formatDate(c.date)}
                </span>
                <Badge size="sm" tone={c.score >= 70 ? 'success' : 'warning'}>
                  {c.score}
                </Badge>
                {list.length > 1 ? <span className="bx-muted">+{list.length - 1} more</span> : null}
              </Inline>
            );
          },
        },
        { key: 'status', header: 'Status', width: 120, render: () => <Badge size="sm" tone="warning">Choose</Badge> },
      );
    } else {
      base.push(
        { key: 'balance', header: 'Balance', width: 130, align: 'right', render: (r) => (r.balance === null ? '' : `${formatMoney(Math.abs(r.balance))} ${r.balance >= 0 ? 'Cr' : 'Dr'}`) },
        { key: 'status', header: 'Status', width: 140, render: (r) => <LineStatusBadge status={r.status} /> },
      );
    }
    return base;
  }, [tab, suggested]);

  if (!banksLoading && !banksError && banks.length === 0) {
    return (
      <ReportScreen title="Match Bank Statement" periodMode="range">
        <NoBanks />
      </ReportScreen>
    );
  }

  const bank = banks.find((b) => b.id === ledgerId);
  const sel = current();
  const noStatement = !lines.loading && rows.length === 0 && (batches.data?.length ?? 0) === 0;
  const tabEmpty: Record<MatchTab, { title: string; body: string }> = {
    matched: { title: 'Nothing matched yet', body: 'Press Alt+M to match the statement with your vouchers automatically.' },
    suggestions: { title: 'No suggestions waiting', body: 'Run auto-match (Alt+M). Lines with more than one possible voucher, or a weak match, are listed here for you to choose.' },
    unmatched: { title: 'Every statement line is matched', body: 'Nothing left to do for this period. Open the reconciliation (Alt+R) to check the balances.' },
    ignored: { title: 'No ignored lines', body: 'Lines you ignore (Alt+I) stay out of matching.' },
  };

  return (
    <ReportScreen
      title="Match Bank Statement"
      subtitle={bank ? `${bank.name}${batch ? ` · ${batch.fileName ?? 'statement'} (${formatDate(batch.from)} – ${formatDate(batch.to)})` : ''}` : undefined}
      periodMode="range"
      period={{ from: rangeFrom, to: rangeTo }}
      loading={banksLoading || (lines.loading && !lines.data)}
      refreshing={lines.refreshing || auto.pending}
      error={banksError ?? lines.error}
      onRetry={() => {
        void refetchBanks();
        void lines.refetch();
      }}
      hint="Alt+M Auto-match · Enter match / open voucher · Alt+V create voucher · Alt+B create many · Alt+I ignore · Alt+U unmatch · Alt+1…4 tabs"
      exportDef={() => ({
        subtitle: `${bank?.name ?? ''} — ${TAB_TITLE[tab]}`,
        columns: [
          { header: 'Date', kind: 'date' },
          { header: 'Narration', width: 40 },
          { header: 'Ref. no.', width: 16 },
          { header: 'Withdrawal', kind: 'amount' },
          { header: 'Deposit', kind: 'amount' },
          { header: 'Status', width: 14 },
          { header: 'Voucher', width: 20 },
        ],
        rows: byTab[tab].map((r) => [
          r.txnDate,
          r.description,
          r.reference,
          r.withdrawal || null,
          r.deposit || null,
          r.status,
          r.matched ? `${r.matched.voucherType} ${r.matched.number ?? ''}` : '',
        ]),
      })}
      filters={
        <Inline gap={2} wrap>
          <BankSelect
            banks={banks}
            value={ledgerId}
            onChange={(id) => {
              if (id === null) return;
              setLedgerId(id);
              setBatchId(null);
              setSuggested(new Map());
            }}
          />
          <Select
            size="sm"
            aria-label="Imported statement"
            value={batchId === null ? 'all' : String(batchId)}
            options={[
              { value: 'all', label: 'All imported statements' },
              ...(batches.data ?? []).map((b) => ({ value: String(b.id), label: `${b.fileName ?? 'Statement'} · ${formatDate(b.from)} – ${formatDate(b.to)} · ${b.lineCount} lines` })),
            ]}
            onChange={(v) => {
              setBatchId(v === 'all' ? null : Number(v));
              setSuggested(new Map());
            }}
          />
          <Inline gap={1} align="center" wrap={false}>
            <span className="bx-muted">Days after voucher</span>
            <NumberInput size="sm" aria-label="Days a statement line may fall after the voucher date" value={windowDays} min={0} max={60} step={1} onChange={setWindowDays} style={{ width: 64 }} />
          </Inline>
        </Inline>
      }
      actions={[
        { key: 'Alt+M', label: 'Auto-match', icon: 'zap', primary: true, onClick: () => void runAutoMatch(), disabled: auto.pending || ledgerId === null, hidden: !canEdit },
        { key: 'Alt+V', label: 'Create voucher', icon: 'plus', onClick: () => sel && setCreating(sel), hidden: !canEdit || !canCreate, disabled: !sel || sel.status !== 'unmatched' || (tab !== 'unmatched' && tab !== 'suggestions') },
        { key: 'Alt+B', label: 'Create vouchers for many', icon: 'layers', onClick: () => setBulk(true), hidden: !canEdit || !canCreate, disabled: byTab.unmatched.length + byTab.suggestions.length === 0 },
        { key: 'Alt+L', label: 'Look for a match', icon: 'search', onClick: () => sel && setPicking(sel), hidden: !canEdit, disabled: !sel || sel.status !== 'unmatched' },
        { key: 'Alt+I', label: tab === 'ignored' ? 'Restore line' : 'Ignore line', icon: tab === 'ignored' ? 'undo' : 'eye-off', onClick: () => void doIgnore(sel, tab !== 'ignored'), hidden: !canEdit, disabled: !sel || tab === 'matched' },
        { key: 'Alt+U', label: 'Unmatch', icon: 'x-circle', onClick: () => void doUnmatch(sel), hidden: !canEdit, disabled: !sel || tab !== 'matched' },
        { key: 'Alt+1', label: 'Matched', onClick: () => setTab('matched'), group: 'view', disabled: tab === 'matched' },
        { key: 'Alt+2', label: 'Suggestions', onClick: () => setTab('suggestions'), group: 'view', disabled: tab === 'suggestions' },
        { key: 'Alt+3', label: 'Unmatched', onClick: () => setTab('unmatched'), group: 'view', disabled: tab === 'unmatched' },
        { key: 'Alt+4', label: 'Ignored', onClick: () => setTab('ignored'), group: 'view', disabled: tab === 'ignored' },
        { key: 'Alt+R', label: 'Reconciliation', icon: 'bank', onClick: () => nav.push('banking.brs', { ledgerId: ledgerId ?? undefined }), group: 'go' },
        { key: 'Alt+O', label: 'Import statement', icon: 'upload', onClick: () => nav.push('banking.import', { ledgerId: ledgerId ?? undefined }), group: 'go', hidden: !canEdit },
      ]}
    >
      <Stack gap={2}>
        {!canEdit ? <ReadOnlyNotice what="the statement lines" /> : null}
        {noStatement ? (
          <EmptyState
            icon="upload"
            title="No bank statement imported for this bank"
            body="Import the statement downloaded from net banking (Alt+O), then match it with your vouchers here."
            action={
              canEdit ? (
                <Button variant="primary" icon="upload" onClick={() => nav.push('banking.import', { ledgerId: ledgerId ?? undefined })}>
                  Import statement
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Tabs
            aria-label="Statement lines by status"
            value={tab}
            onChange={(id) => setTab(TAB_ORDER.includes(id as MatchTab) ? (id as MatchTab) : 'unmatched')}
            items={TAB_ORDER.map((t) => ({
              id: t,
              label: TAB_TITLE[t],
              badge: <Badge size="sm" tone={t === 'suggestions' && counts[t] > 0 ? 'warning' : 'neutral'}>{counts[t]}</Badge>,
              content: (
                <div className="bx-bk-table--tall">
                  <DataTable
                    aria-label={`${TAB_TITLE[t]} statement lines`}
                    autoFocus
                    columns={lineColumns}
                    rows={byTab[t]}
                    getRowKey={(r) => String(r.id)}
                    selectedKey={cursor[t]}
                    onSelect={(key) => setCursor((c) => ({ ...c, [t]: key }))}
                    onRowActivate={activate}
                    density="compact"
                    empty={<EmptyState size="sm" icon="check-circle" title={tabEmpty[t].title} body={tabEmpty[t].body} />}
                  />
                </div>
              ),
            }))}
          />
        )}
      </Stack>

      {picking && ledgerId !== null ? (
        <MatchPicker
          line={picking}
          initial={suggested.get(picking.id) ?? null}
          onClose={() => setPicking(null)}
          onMatched={() => {
            onMatched(picking.id);
            setPicking(null);
          }}
          onCreate={
            canCreate
              ? () => {
                  const l = picking;
                  setPicking(null);
                  setCreating(l);
                }
              : undefined
          }
        />
      ) : null}
      {creating && ledgerId !== null ? (
        <CreateVoucherDialog
          line={creating}
          bankLedgerId={ledgerId}
          onClose={() => setCreating(null)}
          onCreated={() => {
            onMatched(creating.id);
            setCreating(null);
          }}
        />
      ) : null}
      {bulk && ledgerId !== null ? (
        <BulkCreateDialog
          lines={[...byTab.unmatched, ...byTab.suggestions].sort((a, b) => (a.txnDate < b.txnDate ? -1 : a.txnDate > b.txnDate ? 1 : a.id - b.id))}
          withCandidates={suggestedIds}
          bankLedgerId={ledgerId}
          onClose={() => setBulk(false)}
          onCreated={(ids) => {
            setSuggested((prev) => {
              const next = new Map(prev);
              for (const id of ids) next.delete(id);
              return next;
            });
            setBulk(false);
          }}
        />
      ) : null}
    </ReportScreen>
  );
}

const TAB_TITLE: Record<MatchTab, string> = { matched: 'Matched', suggestions: 'Suggestions', unmatched: 'Unmatched', ignored: 'Ignored' };

function lineSummary(l: StatementLineView): string {
  return `${formatDate(l.txnDate)} · ${l.amount >= 0 ? 'Deposit' : 'Withdrawal'} ${formatMoney(Math.abs(l.amount), { symbol: true })}${l.description ? ` · ${l.description}` : ''}`;
}

// ───────────────────────────── Match picker ─────────────────────────────

function MatchPicker({
  line,
  initial,
  onClose,
  onMatched,
  onCreate,
}: {
  line: StatementLineView;
  initial: MatchCandidate[] | null;
  onClose: () => void;
  onMatched: () => void;
  onCreate?: () => void;
}) {
  const toast = useToast();
  const q = useApiQuery('banking.suggestions', { lineId: line.id, dateWindowDays: 30 });
  const match = useApiMutation('banking.match', { invalidates: BOOK_ROUTES });
  const candidates = q.data ?? initial ?? [];
  const [cursor, setCursor] = useState<string | null>(null);

  const choose = async (c: MatchCandidate): Promise<void> => {
    try {
      await match.mutate({ lineId: line.id, ledgerEntryId: c.ledgerEntryId });
      toast.success(`Matched with ${c.voucherType} ${c.number ?? ''}`.trim(), { message: `Bank date set to ${formatDate(line.txnDate)}.` });
      onMatched();
    } catch (err) {
      toast.error('Could not match', { message: userMessage(err) });
    }
  };

  const columns = useMemo<Column<MatchCandidate>[]>(
    () => [
      { key: 'date', header: 'Vch date', kind: 'date', width: 104 },
      { key: 'voucher', header: 'Voucher', width: 150, value: (c) => `${c.voucherType} ${c.number ?? ''}` },
      { key: 'particulars', header: 'Particulars', minWidth: 160 },
      { key: 'instrument', header: 'Instrument', width: 130, value: (c) => [c.instrumentType?.toUpperCase() ?? '', c.instrumentNo ?? ''].join(' ').trim() },
      { key: 'score', header: 'Score', width: 80, align: 'right', render: (c) => <Badge size="sm" tone={c.score >= 70 ? 'success' : 'warning'}>{c.score}</Badge> },
      { key: 'why', header: 'Why', minWidth: 240, value: (c) => reasonsText(c.reasons), title: (c) => reasonsText(c.reasons) },
    ],
    [],
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Match statement line with a voucher"
      description={lineSummary(line)}
      footerStart={<span className="bx-muted">↑/↓ choose · Enter match · Esc close</span>}
      footer={
        <>
          {onCreate ? (
            <Button icon="plus" onClick={onCreate}>
              Create voucher instead
            </Button>
          ) : null}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <Stack gap={2}>
        {q.error ? <Banner tone="danger">{userMessage(q.error)}</Banner> : null}
        <div className="bx-bk-table">
          <DataTable
            aria-label="Vouchers with the same amount"
            autoFocus
            columns={columns}
            rows={candidates}
            getRowKey={(c) => String(c.ledgerEntryId)}
            selectedKey={cursor}
            onSelect={setCursor}
            onRowActivate={(c) => void choose(c)}
            loading={q.loading && !initial}
            empty={
              <EmptyState
                size="sm"
                title="No voucher with this amount"
                body={`No open ${line.amount >= 0 ? 'receipt or deposit' : 'payment or withdrawal'} of ${formatMoney(Math.abs(line.amount), { symbol: true })} within 30 days. Create a voucher for this line instead.`}
              />
            }
          />
        </div>
      </Stack>
    </Modal>
  );
}

// ───────────────────────────── Create one voucher ─────────────────────────────

function CreateVoucherDialog({ line, bankLedgerId, onClose, onCreated }: { line: StatementLineView; bankLedgerId: number; onClose: () => void; onCreated: () => void }) {
  return (
    <Modal open onClose={onClose} size="md" title="Create voucher from statement line" description={lineSummary(line)}>
      <CreateVoucherForm line={line} bankLedgerId={bankLedgerId} onClose={onClose} onCreated={onCreated} />
    </Modal>
  );
}

function CreateVoucherForm({ line, bankLedgerId, onClose, onCreated }: { line: StatementLineView; bankLedgerId: number; onClose: () => void; onCreated: () => void }) {
  const nav = useNav();
  const toast = useToast();
  const canCreateLedger = useCan('masters.create');
  const { ledgers, loading } = useLedgerOptions();
  const [kind, setKind] = useState<FromLineKind>(() => defaultKind(line));
  const fitting = useMemo(() => ledgers.filter((l) => ledgerFitsKind(l, kind, bankLedgerId)), [ledgers, kind, bankLedgerId]);
  const [ledger, setLedger] = useState<LedgerOption | null>(null);
  const [touched, setTouched] = useState(false);
  const [narration, setNarration] = useState(line.description);
  const create = useApiMutation('banking.createVoucher', { invalidates: BOOK_ROUTES });

  // Propose a ledger from the narration until the user picks one.
  useEffect(() => {
    if (touched) return;
    setLedger(suggestLedger(line, ledgers, kind, bankLedgerId));
  }, [ledgers, kind, line, bankLedgerId, touched]);

  const submit = async (): Promise<void> => {
    if (!ledger) {
      toast.warning(kind === 'contra' ? 'Choose the cash or bank account on the other side.' : 'Choose the ledger for this amount (party, expense or income).');
      return;
    }
    try {
      const res = await withConfirmation((ack) =>
        create.mutate({ lineId: line.id, kind, contraLedgerId: ledger.id, narration: narration.trim() || undefined, acknowledgeWarnings: ack || undefined }),
      );
      if (!res) return;
      toast.success(`${KIND_LABEL[kind]}${res.number ? ` ${res.number}` : ''} created and reconciled`, {
        action: { label: 'Open', onClick: () => nav.push('vouchers.view', { id: res.voucherId }) },
      });
      onCreated();
    } catch (err) {
      toast.error('The voucher was not created', { message: userMessage(err) });
    }
  };

  useHotkeys({ 'Ctrl+A': () => void submit() }, [kind, ledger, narration]);

  return (
    <Stack gap={3}>
      <Field label="Voucher type">
        <SegmentedControl
          aria-label="Voucher type"
          options={allowedKinds(line.amount).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setTouched(false);
          }}
        />
      </Field>
      <Field
        label={kind === 'contra' ? (line.amount >= 0 ? 'Deposited from (cash / bank)' : 'Withdrawn to (cash / bank)') : line.amount >= 0 ? 'Received from (party / income)' : 'Paid to (party / expense)'}
        required
        hint={ledger && !touched ? 'Suggested from the narration — change it if needed.' : undefined}
      >
        <Picker<LedgerOption>
          items={fitting}
          getKey={(l) => String(l.id)}
          getLabel={(l) => l.name}
          getAlias={(l) => l.alias}
          groupBy={(l) => l.groupName}
          value={ledger}
          autoFocus
          placeholder={loading ? 'Loading ledgers…' : 'Type to search ledgers'}
          onChange={(l) => {
            setLedger(l);
            setTouched(true);
          }}
          onCreate={
            canCreateLedger
              ? (typed) => {
                  void nav.pushForResult<{ id: number; name: string }>('accounts.ledger.form', { initialName: typed, forResult: true }).then((created) => {
                    if (created) {
                      setLedger({ id: created.id, name: created.name, groupName: '', classes: [] });
                      setTouched(true);
                    }
                  });
                }
              : undefined
          }
        />
      </Field>
      <Field label="Narration" optional>
        <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={4000} />
      </Field>
      <Inline gap={2} justify="end">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" shortcut="Ctrl+A" loading={create.pending} onClick={() => void submit()}>
          Create {KIND_LABEL[kind]}
        </Button>
      </Inline>
    </Stack>
  );
}

// ───────────────────────────── Create many vouchers ─────────────────────────────

interface BulkProps {
  lines: readonly StatementLineView[];
  /** Lines the last auto-match found possible vouchers for: never ticked automatically. */
  withCandidates: ReadonlySet<number>;
  bankLedgerId: number;
  onClose: () => void;
  onCreated: (lineIds: number[]) => void;
}

function BulkCreateDialog(props: BulkProps) {
  return (
    <Modal open onClose={props.onClose} size="full" title="Create vouchers for statement lines" description="Every voucher is dated on the statement date and reconciled at once. If any line fails, nothing is saved.">
      <BulkCreateForm {...props} />
    </Modal>
  );
}

function BulkCreateForm({ lines, withCandidates, bankLedgerId, onClose, onCreated }: BulkProps) {
  const toast = useToast();
  const { ledgers, loading } = useLedgerOptions();
  const [drafts, setDrafts] = useState<Map<number, CreateDraft>>(() => new Map());
  const [included, setIncluded] = useState<Set<number>>(() => new Set());
  const [proposed, setProposed] = useState(false);
  const createMany = useApiMutation('banking.createVouchers', { invalidates: BOOK_ROUTES });

  // Propose kind + ledger per line once the ledgers are loaded; lines with a proposal are ticked — except lines
  // that may already have a voucher in the books (creating one more would count the amount twice).
  useEffect(() => {
    if (proposed || loading) return;
    const d = new Map<number, CreateDraft>();
    const inc = new Set<number>();
    for (const l of lines) {
      const kind = defaultKind(l);
      const led = suggestLedger(l, ledgers, kind, bankLedgerId);
      d.set(l.id, { kind, contraLedgerId: led?.id ?? null, narration: '' });
      if (led && !withCandidates.has(l.id)) inc.add(l.id);
    }
    setDrafts(d);
    setIncluded(inc);
    setProposed(true);
  }, [lines, ledgers, loading, bankLedgerId, proposed]);

  const update = (id: number, patch: Partial<CreateDraft>): void => {
    setDrafts((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? { kind: 'payment' as FromLineKind, contraLedgerId: null, narration: '' };
      const merged = { ...cur, ...patch };
      if (patch.kind && patch.kind !== cur.kind) {
        const led = ledgers.find((l) => l.id === merged.contraLedgerId);
        if (led && !ledgerFitsKind(led, patch.kind, bankLedgerId)) merged.contraLedgerId = null;
      }
      next.set(id, merged);
      return next;
    });
  };

  const chosen = lines.filter((l) => included.has(l.id)).map((l) => l.id);
  const { items, missing } = buildCreateItems(chosen, drafts);

  const submit = async (): Promise<void> => {
    if (chosen.length === 0) {
      toast.warning('Tick the lines to create vouchers for.');
      return;
    }
    if (missing.length > 0) {
      toast.warning(`Choose a ledger for ${missing.length} ticked line${missing.length === 1 ? '' : 's'} first.`);
      return;
    }
    try {
      const res = await withConfirmation((ack) => createMany.mutate({ items, acknowledgeWarnings: ack || undefined }));
      if (!res) return;
      toast.success(`${res.length} voucher${res.length === 1 ? '' : 's'} created and reconciled`);
      onCreated(res.map((r) => r.lineId));
    } catch (err) {
      toast.error('No vouchers were created', { message: userMessage(err) });
    }
  };

  useHotkeys({ 'Ctrl+A': () => void submit() }, [items, missing, chosen]);

  const optionsFor = (kind: FromLineKind) => [
    { value: '', label: '— choose ledger —' },
    ...ledgers.filter((l) => ledgerFitsKind(l, kind, bankLedgerId)).map((l) => ({ value: String(l.id), label: `${l.name} (${l.groupName})` })),
  ];
  const allTicked = lines.length > 0 && included.size === lines.length;

  return (
    <Stack gap={3}>
      <Inline gap={3} align="center">
        <Checkbox
          checked={allTicked}
          indeterminate={included.size > 0 && !allTicked}
          label={`Select all (${lines.length})`}
          onChange={(v) => setIncluded(v ? new Set(lines.map((l) => l.id)) : new Set())}
        />
        <span className="bx-muted">
          {chosen.length} ticked · {missing.length > 0 ? `${missing.length} still need a ledger` : 'ready'}
        </span>
      </Inline>
      <div className="bx-bk-grid-wrap">
        <table className="bx-bk-grid" aria-label="Statement lines to create vouchers for">
          <thead>
            <tr>
              <th scope="col">Create</th>
              <th scope="col">Date</th>
              <th scope="col">Narration (bank)</th>
              <th scope="col" className="bx-bk-num">
                Withdrawal
              </th>
              <th scope="col" className="bx-bk-num">
                Deposit
              </th>
              <th scope="col">Voucher</th>
              <th scope="col">Ledger</th>
              <th scope="col">Narration (optional)</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const d = drafts.get(l.id) ?? { kind: defaultKind(l), contraLedgerId: null, narration: '' };
              return (
                <tr key={l.id} className={included.has(l.id) ? 'is-changed' : undefined}>
                  <td>
                    <Checkbox
                      aria-label={`Create a voucher for ${lineSummary(l)}`}
                      checked={included.has(l.id)}
                      onChange={(v) =>
                        setIncluded((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(l.id);
                          else next.delete(l.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="bx-num">{formatDate(l.txnDate)}</td>
                  <td className="bx-bk-particulars">
                    <span className="bx-truncate" title={l.description}>
                      {l.description}
                    </span>
                    {withCandidates.has(l.id) ? (
                      <Badge size="sm" tone="warning" icon="alert">
                        A voucher may already exist — match it instead
                      </Badge>
                    ) : null}
                  </td>
                  <td className="bx-bk-num">{l.withdrawal ? formatMoney(l.withdrawal) : ''}</td>
                  <td className="bx-bk-num">{l.deposit ? formatMoney(l.deposit) : ''}</td>
                  <td>
                    <Select
                      size="sm"
                      aria-label="Voucher type"
                      value={d.kind}
                      options={allowedKinds(l.amount).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                      onChange={(v) => update(l.id, { kind: v as FromLineKind })}
                    />
                  </td>
                  <td>
                    <Select
                      size="sm"
                      aria-label="Ledger"
                      value={d.contraLedgerId === null ? '' : String(d.contraLedgerId)}
                      options={optionsFor(d.kind)}
                      invalid={included.has(l.id) && d.contraLedgerId === null}
                      onChange={(v) => {
                        update(l.id, { contraLedgerId: v === '' ? null : Number(v) });
                        if (v !== '') setIncluded((prev) => new Set(prev).add(l.id));
                      }}
                    />
                  </td>
                  <td>
                    <TextInput size="sm" aria-label="Narration" value={d.narration} placeholder="Statement narration" onChange={(e) => update(l.id, { narration: e.target.value })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Inline gap={2} justify="end">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" shortcut="Ctrl+A" loading={createMany.pending} disabled={chosen.length === 0} onClick={() => void submit()}>
          Create {chosen.length} voucher{chosen.length === 1 ? '' : 's'}
        </Button>
      </Inline>
    </Stack>
  );
}
