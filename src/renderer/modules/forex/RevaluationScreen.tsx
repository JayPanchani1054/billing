/**
 * 'forex.revaluation' {asOf?} — Period-end revaluation of foreign-currency balances (unrealised
 * exchange gain / loss, AS 11 / Ind AS 21: monetary items at the closing rate). Per ledger (and per
 * pending bill of a bill-wise ledger): the amount in the currency, the rupees it is carried at in the
 * books, the closing rate, its value at that rate and the adjustment. The closing rate comes from
 * Currencies › Rates of Exchange (the rate column chosen in Multi-currency Settings) and can be typed
 * here for this run (e.g. the RBI reference / FEDAI rate of the balance-sheet date).
 *
 * Ctrl+A posts the "Forex adjustment" journal: each ledger Dr / Cr by its adjustment against the
 * unrealised gain / loss ledger (vouchers.create; back-dated / locked-period rules of voucher save
 * apply). A second revaluation as of the same date asks first. Many accountants reverse it on the first
 * day of the next period — enter that journal with Alt+2 (duplicate) on the posted voucher, swapping sides.
 *
 * Keys: Alt+F2 period (as on) · Alt+T rate type · Alt+R type closing rates · Enter on a line opens the
 * ledger in both currencies · Ctrl+A post · Alt+E export · Alt+P print · Esc back.
 */
import { useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { FOREX_RATE_TYPES, formatExchangeRate, type ForexRateType } from '../../../shared/forex.ts';
import type { ForexRevaluationLine } from '../../../shared/types/forex.ts';
import { ReportScreen, useApiMutation, useApiQuery, useCan, useFeatures, useNav, usePeriod, userMessage, withConfirmation } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Banner, Button, DataTable, DateInput, EmptyState, Field, Hotkeys, Modal, NumberInput, Select, Stack, TextArea, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import { ForexOff } from './components.tsx';
import {
  currencyMap,
  fxDrCr,
  RATE_TYPE_LABEL,
  rateOverrides,
  rateText,
  revaluationBlocker,
  revaluationExport,
  revaluationJournalPreview,
  revaluationNarration,
  revaluationRateRows,
} from './lib/model.ts';

interface Row extends ForexRevaluationLine {
  key: string;
}

export function RevaluationScreen({ params }: ScreenProps<{ asOf?: string }>) {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canPost = useCan('vouchers.create');
  const period = usePeriod();
  const asOf = typeof params?.asOf === 'string' && params.asOf <= period.to ? params.asOf : period.to;
  const [rateType, setRateType] = useState<ForexRateType | null>(null);
  const [typed, setTyped] = useState<ReadonlyMap<number, number>>(new Map());
  const [posting, setPosting] = useState(false);
  /** Closing rates being typed (committed to `typed` on Enter / leaving the box). */
  const [drafts, setDrafts] = useState<Readonly<Record<number, number | null>>>({});
  const rates = useMemo(() => rateOverrides(typed), [typed]);
  const ctxQ = useApiQuery('forex.context', {}, { enabled: features.multiCurrency, staleTime: 60_000 });
  const cur = useMemo(() => currencyMap(ctxQ.data?.currencies ?? []), [ctxQ.data]);
  const input = { asOf, ...(rateType ? { rateType } : {}), ...(rates.length ? { rates } : {}) };
  const q = useApiQuery('forex.revaluation.report', input, { enabled: features.multiCurrency, keepPrevious: true });
  const d = q.data;
  const rateRows = useMemo(() => revaluationRateRows(d, typed), [d, typed]);
  const firstRateRef = useRef<HTMLInputElement | null>(null);
  const rows = useMemo<Row[]>(() => (d?.lines ?? []).map((l) => ({ ...l, key: `${l.ledgerId}:${l.billName ?? ''}` })), [d]);
  const blocker = revaluationBlocker(d, rates.length);
  const [cursor, setCursor] = useState<string | null>(null);
  const post = useApiMutation('forex.revaluation.post', { invalidates: ['reports', 'vouchers', 'outstanding', 'dashboard'] });

  const columns = useMemo<Column<Row>[]>(
    () => [
      { key: 'ledgerName', header: 'Ledger', minWidth: 200 },
      { key: 'billName', header: 'Bill', width: 130, value: (r) => r.billName ?? '', render: (r) => r.billName ?? <span className="bx-muted">Balance</span> },
      { key: 'forexAmount', header: 'Foreign amount', width: 160, align: 'right', value: (r) => r.forexAmount, render: (r) => <span className="bx-num">{fxDrCr(r.forexAmount, cur.get(r.currencyId))}</span> },
      { key: 'bookedAmount', header: 'In books (₹)', kind: 'drcr', width: 150 },
      { key: 'closingRate', header: 'Closing rate', width: 110, align: 'right', value: (r) => r.closingRate, render: (r) => <span className="bx-num">{rateText(r.closingRate)}</span> },
      { key: 'revaluedAmount', header: 'At closing rate (₹)', kind: 'drcr', width: 160 },
      { key: 'adjustment', header: 'Adjustment (₹)', kind: 'drcr', width: 150 },
    ],
    [cur],
  );
  const footer: FooterRow[] = d
    ? [{ key: 'net', tone: 'total', cells: { ledgerName: d.net >= 0 ? 'Net unrealised gain' : 'Net unrealised loss', adjustment: formatMoney(Math.abs(d.net)) } }]
    : [];

  if (!features.multiCurrency) return <ForexOff title="Forex Revaluation" />;
  const setRate = (currencyId: number, rate: number | null) => {
    const next = new Map(typed);
    if (rate === null || !(rate > 0)) next.delete(currencyId);
    else next.set(currencyId, rate);
    setTyped(next);
  };
  return (
    <ReportScreen
      title="Forex Revaluation"
      subtitle={d ? `Closing ${RATE_TYPE_LABEL[d.rateType].toLowerCase()} rates as on ${formatDate(d.asOf)} · unrealised exchange gain / loss` : 'Unrealised exchange gain / loss'}
      periodMode="asOn"
      loading={q.loading && !d}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      filters={
        d ? (
          <Field label="Rate" layout="inline" labelWidth={44}>
            <Select<ForexRateType> aria-label="Closing rate type" size="sm" value={d.rateType} options={FOREX_RATE_TYPES.map((t) => ({ value: t, label: RATE_TYPE_LABEL[t] }))} onChange={setRateType} />
          </Field>
        ) : undefined
      }
      exportDef={() => (d ? { ...revaluationExport(d), subtitle: `As on ${formatDate(d.asOf)}` } : { columns: [], rows: [] })}
      actions={[
        { key: 'Ctrl+A', label: 'Post adjustment journal', icon: 'save', primary: true, disabled: !canPost || blocker !== null, hint: !canPost ? 'Needs the “Create vouchers” permission' : (blocker ?? undefined), onClick: () => setPosting(true) },
        { key: 'Alt+R', label: 'Type closing rates', icon: 'rupee', disabled: rateRows.length === 0, onClick: () => firstRateRef.current?.focus(), group: 'details' },
        {
          key: 'Alt+T',
          label: 'Next rate type',
          icon: 'refresh',
          disabled: !d,
          onClick: () => d && setRateType(FOREX_RATE_TYPES[(FOREX_RATE_TYPES.indexOf(d.rateType) + 1) % FOREX_RATE_TYPES.length] as ForexRateType),
          group: 'view',
        },
        { key: 'Alt+L', label: 'Ledger in both currencies', icon: 'ledger', disabled: !cursor, onClick: () => { const r = rows.find((x) => x.key === cursor); if (r) nav.push('forex.ledger', { ledgerId: r.ledgerId, to: asOf }); }, group: 'view' },
      ]}
      hint="Ctrl+A Post journal · Alt+R Type closing rates · Alt+T Rate type · Enter Ledger · Alt+F2 As on · Alt+E Export · Esc Back"
    >
      <Stack gap={3}>
        {d && d.missingRates.length > 0 ? (
          <Banner tone="warning">
            No closing rate for {d.rates.filter((r) => d.missingRates.includes(r.currencyId)).map((r) => r.formalName).join(', ')} on or before {formatDate(d.asOf)}. Those balances are left out — type
            the rate below (Alt+R) or enter it in Currencies › Rates of Exchange.
          </Banner>
        ) : null}
        {d && d.posted.some((p) => p.asOf === d.asOf) ? (
          <Banner tone="info">
            A revaluation as of {formatDate(d.asOf)} is already posted ({d.posted.filter((p) => p.asOf === d.asOf).map((p) => p.number ?? `#${p.voucherId}`).join(', ')}). The figures below already include it; posting
            again restates only what is still different.
          </Banner>
        ) : null}
        {rateRows.length > 0 ? (
          <section aria-label="Closing rates">
            <div className="bx-fx-rates">
              {rateRows.map((r, i) => (
                <Field
                  key={r.currencyId}
                  label={`${r.formalName} (₹ per ${r.symbol})`}
                  hint={
                    r.typed !== null
                      ? `Typed for this run (blank: the master rate${r.masterRate !== null ? ` ₹${formatExchangeRate(r.masterRate)}` : ''})`
                      : r.masterRate !== null
                        ? `Master${r.masterDate ? ` of ${formatDate(r.masterDate)}` : ''}: ₹${formatExchangeRate(r.masterRate)}`
                        : 'No master rate — type it'
                  }
                >
                  <NumberInput
                    ref={i === 0 ? firstRateRef : undefined}
                    aria-label={`Closing rate of ${r.formalName}`}
                    decimals={6}
                    grouping={false}
                    min={0}
                    value={drafts[r.currencyId] !== undefined ? (drafts[r.currencyId] ?? null) : r.typed}
                    placeholder={r.masterRate !== null ? formatExchangeRate(r.masterRate) : 'Rate'}
                    onChange={(v) => setDrafts({ ...drafts, [r.currencyId]: v })}
                    onCommit={(v) => setRate(r.currencyId, v)}
                  />
                </Field>
              ))}
            </div>
          </section>
        ) : null}
        <DataTable<Row>
          aria-label="Revaluation of foreign-currency balances"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          selectedKey={cursor}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => nav.push('forex.ledger', { ledgerId: r.ledgerId, to: asOf })}
          footerRows={footer}
          empty={<EmptyState icon="check" title="Nothing to revalue" body="Every foreign-currency balance is carried at the closing rate (or there is none). Change the date with Alt+F2." />}
        />
        {d && d.posted.length > 0 ? (
          <p className="bx-rep-note">
            Earlier revaluation journals: {d.posted.map((p) => `${p.number ?? `#${p.voucherId}`} (as on ${formatDate(p.asOf)})`).join(', ')}.
          </p>
        ) : null}
      </Stack>
      {posting && d ? (
        <PostDialog
          asOf={d.asOf}
          defaultNarration={revaluationNarration(d, (iso) => formatDate(iso))}
          preview={revaluationJournalPreview(d, ctxQ.data?.settings.unrealisedLedger?.name)}
          onClose={() => setPosting(false)}
          onPost={async (date, narration) => {
            const out = await withConfirmation((ack) => post.mutate({ ...input, date, narration, ...(ack ? { allowRepeat: true } : {}) }), { title: 'Post another revaluation?', confirmLabel: 'Post anyway' });
            if (!out) return;
            setPosting(false);
            toast.success(out.number ? `Forex adjustment journal ${out.number} posted` : 'Forex adjustment journal posted', { action: { label: 'View', onClick: () => nav.push('vouchers.view', { id: out.voucherId }) } });
          }}
        />
      ) : null}
    </ReportScreen>
  );
}

function PostDialog(props: {
  asOf: string;
  defaultNarration: string;
  preview: Array<{ ledgerName: string; amount: number }>;
  onClose: () => void;
  onPost: (date: string, narration: string) => Promise<void>;
}) {
  const [date, setDate] = useState<string | null>(props.asOf);
  const [narration, setNarration] = useState(props.defaultNarration);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy || !date) return;
    if (date < props.asOf) {
      setError(`The journal date cannot be before the revaluation date (${formatDate(props.asOf)}).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onPost(date, narration.trim());
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  return (
    <Modal
      open
      onClose={props.onClose}
      size="md"
      title="Post Forex adjustment journal"
      description="Restates the foreign-currency balances at the closing rate. The difference goes to the unrealised exchange gain / loss ledger (Multi-currency Settings)."
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={busy || !date} onClick={() => void submit()}>
            Post journal
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void submit() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Journal date" required hint="Usually the balance-sheet date (as on).">
            <DateInput data-autofocus value={date} onChange={setDate} />
          </Field>
          <Field label="Narration">
            <TextArea rows={3} value={narration} maxLength={4000} onValueChange={setNarration} />
          </Field>
          <table className="bx-fx-preview" aria-label="Journal lines">
            <thead>
              <tr>
                <th>Ledger</th>
                <th className="bx-num">Debit</th>
                <th className="bx-num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {props.preview.map((l) => (
                <tr key={l.ledgerName}>
                  <td>{l.ledgerName}</td>
                  <td className="bx-num">{l.amount > 0 ? formatMoney(l.amount) : ''}</td>
                  <td className="bx-num">{l.amount < 0 ? formatMoney(-l.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Stack>
      </div>
    </Modal>
  );
}
