/**
 * 'forex.opening' {ledgerId} — Opening balance of a ledger kept in a foreign currency, in that
 * currency: the rupee opening balance (from the ledger master, read-only here) with its amount in the
 * currency and, for a bill-wise ledger, the foreign amount of each opening bill (so settling an opening
 * bill books the realised exchange difference against the rupees it was carried at).
 * Opened without a ledger (Masters menu / Go To) it asks for the ledger first.
 * Keys: Enter next field · Alt+R fill every amount at one rate · Ctrl+A save · Alt+M ledger master · Esc back.
 */
import { useEffect, useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatExchangeRate, roundForex } from '../../../shared/forex.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { ForexOpeningView } from '../../../shared/types/forex.ts';
import { Screen, useApiMutation, useApiQuery, useCan, useFeatures, useNav } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Banner, Button, EmptyState, Field, Hotkeys, Modal, NumberInput, Stack, useEnterAdvance, useToast } from '../../ui/index.ts';
import { ForexLedgerPicker, ForexOff } from './components.tsx';
import { forexAtRate, impliedRate, openingIssues } from './lib/model.ts';

const drcr = (p: number): string => (p === 0 ? '' : `${formatMoney(Math.abs(p))} ${p > 0 ? 'Dr' : 'Cr'}`);

export function OpeningScreen({ params }: ScreenProps<{ ledgerId?: number }>) {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canSave = useCan('masters.alter');
  // Opened from the menu / Go To without a ledger: chosen here.
  const [picked, setPicked] = useState<number | null>(null);
  const ledgerId = typeof params?.ledgerId === 'number' ? params.ledgerId : (picked ?? 0);
  const ctxQ = useApiQuery('forex.context', {}, { enabled: features.multiCurrency && ledgerId <= 0, staleTime: 60_000 });
  const q = useApiQuery('forex.opening.get', { ledgerId }, { enabled: features.multiCurrency && ledgerId > 0 });
  const save = useApiMutation('forex.opening.save', { invalidates: ['reports', 'outstanding'] });
  const [loadedFrom, setLoadedFrom] = useState<ForexOpeningView | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [bills, setBills] = useState<Array<number | null>>([]);
  const [fillOpen, setFillOpen] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (!d || d === loadedFrom) return;
    setLoadedFrom(d);
    setOpening(d.openingForex === 0 ? null : Math.abs(d.openingForex));
    setBills(d.bills.map((b) => (b.forexAmount === 0 ? null : Math.abs(b.forexAmount))));
  }, [d]);
  const dp = d?.currency.decimalPlaces ?? 2;
  // Amounts are typed unsigned and take the side of their rupee amount.
  const signed = (abs: number | null, inr: number): number => (abs === null || abs === 0 ? 0 : inr < 0 ? -Math.abs(abs) : Math.abs(abs));
  const draftBills = useMemo(() => (d ? d.bills.map((b, i) => ({ billName: b.billName, amount: b.amount, forexAmount: signed(bills[i] ?? null, b.amount) })) : []), [d, bills]);
  const openingSigned = d ? signed(opening, d.openingInr) : 0;
  const issues = d ? openingIssues(d.openingInr, openingSigned, draftBills, dp) : [];
  const dirty = !!d && (openingSigned !== d.openingForex || draftBills.some((b, i) => b.forexAmount !== (d.bills[i]?.forexAmount ?? 0)));
  const submit = async (): Promise<void> => {
    if (!d || !canSave || save.pending || issues.length > 0) return;
    try {
      const withBills = draftBills.some((b) => b.forexAmount !== 0);
      await save.mutate({ ledgerId, openingForex: openingSigned, ...(withBills ? { bills: draftBills.map((b) => ({ billName: b.billName, forexAmount: b.forexAmount })) } : {}) });
      toast.success(`Opening balance of ${d.ledgerName} in ${d.currency.symbol} saved`);
      nav.pop();
    } catch {
      /* field errors / banner below */
    }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  if (!features.multiCurrency) return <ForexOff title="Opening Balance in Currency" />;
  if (ledgerId <= 0) {
    const ledgers = ctxQ.data?.ledgers ?? [];
    const symbols = new Map((ctxQ.data?.currencies ?? []).map((c) => [c.id, c.symbol]));
    return (
      <Screen title="Opening Balance in Currency" icon="ledger" width="form" hint="Type a ledger name · Enter Open · Esc Back" loading={ctxQ.loading} error={ctxQ.error} onRetry={() => void ctxQ.refetch()}>
        {ctxQ.data && ledgers.length === 0 ? (
          <EmptyState icon="ledger" title="No ledger is kept in a foreign currency" body="Set a Currency on the ledger master (Ledger › Currency) of a party or bank account kept in a foreign currency." />
        ) : (
          <Field label="Ledger" htmlFor="fx-opening-ledger" hint="A party or bank account kept in a foreign currency.">
            <ForexLedgerPicker id="fx-opening-ledger" ledgers={ledgers} symbolOf={(id) => symbols.get(id) ?? ''} value={null} onChange={(id) => id !== null && setPicked(id)} autoFocus />
          </Field>
        )}
      </Screen>
    );
  }
  const fill = (rate: number) => {
    if (!d || !(rate > 0)) return;
    setOpening(Math.abs(forexAtRate(d.openingInr, rate, dp)) || null);
    setBills(d.bills.map((b) => Math.abs(forexAtRate(b.amount, rate, dp)) || null));
    setFillOpen(false);
  };
  const rate = d ? impliedRate(d.openingInr, openingSigned) : null;
  return (
    <Screen
      title="Opening Balance in Currency"
      subtitle={d ? `${d.ledgerName} · kept in ${d.currency.formalName} (${d.currency.symbol})` : undefined}
      icon="ledger"
      width="form"
      dirty={dirty}
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Next field · Alt+R Fill at a rate · Ctrl+A Save · Alt+M Ledger master · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, disabled: !canSave || save.pending || issues.length > 0, hint: canSave ? undefined : 'Needs the “Alter masters” permission', onClick: () => void submit() },
        { key: 'Alt+R', label: 'Fill at a rate', icon: 'rupee', hidden: !canSave, disabled: !canSave || !d, onClick: () => setFillOpen(true), group: 'details' },
        { key: 'Alt+M', label: 'Ledger master', icon: 'edit', onClick: () => nav.push('accounts.ledger.form', { id: ledgerId }), group: 'details' },
      ]}
    >
      {d ? (
        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <Stack gap={3}>
            {!canSave ? <Banner tone="info">You can view this; changing it needs the “Alter masters” permission.</Banner> : null}
            {d.openingInr === 0 ? (
              <Banner tone="info">This ledger has no opening balance in rupees. Enter it in the ledger master (Alt+M) first.</Banner>
            ) : null}
            {issues.length > 0 && dirty ? (
              <Banner tone="warning">
                {issues.map((m) => (
                  <div key={m}>{m}</div>
                ))}
              </Banner>
            ) : null}
            <Field label="Opening balance in rupees" hint="From the ledger master (books are kept in rupees).">
              <div className="bx-num">₹ {drcr(d.openingInr) || '0.00'}</div>
            </Field>
            <Field
              label={`Opening balance in ${d.currency.formalName} (${d.currency.symbol})`}
              htmlFor="fx-opening"
              error={save.fieldErrors.openingForex}
              hint={rate !== null ? `Carried at ₹${formatExchangeRate(rate)} per ${d.currency.symbol} (${d.openingInr >= 0 ? 'Dr' : 'Cr'}, same side as the rupees)` : 'Same side (Dr / Cr) as the rupee opening balance'}
            >
              <NumberInput id="fx-opening" data-autofocus decimals={dp} min={0} value={opening} onChange={(v) => setOpening(v === null ? null : roundForex(v, dp))} disabled={!canSave || d.openingInr === 0} />
            </Field>
            {d.bills.length > 0 ? (
              <table className="bx-fx-bills" aria-label="Opening bills">
                <caption className="bx-rep-note">Opening bills — the foreign amount of each (they must add up to the balance above)</caption>
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th className="bx-num">Rupees</th>
                    <th className="bx-num">{d.currency.symbol}</th>
                    <th className="bx-num">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {d.bills.map((b, i) => {
                    const r = impliedRate(b.amount, draftBills[i]?.forexAmount ?? 0);
                    return (
                      <tr key={b.billName}>
                        <td>{b.billName}</td>
                        <td>{formatDate(b.billDate)}</td>
                        <td className="bx-num">{drcr(b.amount)}</td>
                        <td className="bx-num">
                          <NumberInput
                            aria-label={`Bill ${b.billName} in ${d.currency.symbol}`}
                            decimals={dp}
                            min={0}
                            value={bills[i] ?? null}
                            disabled={!canSave}
                            onChange={(v) => setBills(bills.map((x, j) => (j === i ? (v === null ? null : roundForex(v, dp)) : x)))}
                          />
                        </td>
                        <td className="bx-num">{r !== null ? `₹${formatExchangeRate(r)}` : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
          </Stack>
        </form>
      ) : null}
      {fillOpen && d ? <FillDialog symbol={d.currency.symbol} onClose={() => setFillOpen(false)} onFill={fill} /> : null}
    </Screen>
  );
}

function FillDialog({ symbol, onClose, onFill }: { symbol: string; onClose: () => void; onFill: (rate: number) => void }) {
  const [rate, setRate] = useState<number | null>(null);
  const accept = () => {
    if (rate !== null && rate > 0) onFill(rate);
  };
  const ref = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Fill the foreign amounts at one rate"
      description={`Each rupee amount ÷ the rate, rounded to the currency's decimals. Use the rate the opening balances were booked at.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" disabled={!rate || rate <= 0} onClick={accept}>
            Fill
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': accept }} />
      <div ref={ref}>
        <Field label={`Rate of exchange (₹ per ${symbol})`} required>
          <NumberInput data-autofocus decimals={6} grouping={false} min={0} value={rate} onChange={setRate} />
        </Field>
      </div>
    </Modal>
  );
}
