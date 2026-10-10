/**
 * 'gst.setoff' {period?} — GST set-off and payment for a return period (GSTR-3B 6.1 for regular
 * taxpayers, CMP-08 for composition taxpayers):
 *   - how the input tax credit pays each head (s.49(5) / Rule 88A order — IGST credit first; CGST never
 *     against SGST and vice versa; cess only against cess),
 *   - the cash needed per major × minor head (tax, interest, penalty, fee, others), the cash already in
 *     the electronic cash ledger and what is still to deposit,
 *   - Alt+C Create challan (PMT-06: CPIN, CIN, BRN …) → a Payment voucher into "GST Electronic Cash Ledger",
 *   - Ctrl+A Post set-off → one Journal (Dr Output / RCM payable / interest …, Cr Input, Cr cash ledger).
 * Enter on a challan opens its voucher.
 */
import { useMemo, useRef, useState } from 'react';
import type { CashHeadAmount, CashMinorHead, GstChallanRow, GstSetoffResult } from '../../../shared/types/gst-plus.ts';
import { CASH_MINOR_HEADS } from '../../../shared/types/gst-plus.ts';
import type { LedgerPickerRow } from '../../../shared/types/accounts.ts';
import type { TaxAmounts, TaxHead } from '../../../shared/types/gst-returns.ts';
import { TAX_HEADS } from '../../../shared/types/gst-returns.ts';
import { formatDate, formatMoney, ReportScreen, useApiMutation, useApiQuery, useCan, useNav, useWorkingDate, userMessage } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import { AmountInput, Banner, Button, DataTable, DateInput, EmptyState, Field, Hotkeys, Modal, Panel, Select, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { GstHelp, WideTable } from './components.tsx';
import { challanDefaults, challanFieldErrors, challanGrid, gridToHeads, HEAD_NAMES, MINOR_LABELS, setoffExport } from './lib/gstplus.ts';
import { usePlusPeriod } from './plusComponents.tsx';

const money = (p: number): string => formatMoney(p);
const zero = (): TaxAmounts => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

export function SetoffScreen({ params }: ScreenProps<{ period?: string }>) {
  const nav = useNav();
  const canFile = useCan('gst.file');
  const pp = usePlusPeriod(params?.period);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const [penalty, setPenalty] = useState<TaxAmounts>(zero);
  const [others, setOthers] = useState<TaxAmounts>(zero);
  const q = useApiQuery('gst.setoff.compute', { period: pp.key ?? '', penalty, others }, { enabled: pp.key !== null, keepPrevious: true });
  const [dialog, setDialog] = useState<'challan' | 'post' | null>(null);
  const s = q.data;
  const posted = s?.posted ?? null;

  const actions: ScreenActionItem[] = [
    {
      key: 'Ctrl+A',
      label: 'Post set-off',
      icon: 'save',
      primary: true,
      onClick: () => setDialog('post'),
      disabled: !s || !canFile || posted !== null || (s.cashTotal === 0 && s.credit.length === 0),
      hint: posted ? 'Already posted for this period' : canFile ? 'Post the set-off journal for this period' : 'You need the "File GST returns" permission',
      group: 'edit',
    },
    { key: 'Alt+C', label: 'Create challan', icon: 'plus', onClick: () => setDialog('challan'), disabled: !s || !canFile, group: 'edit' },
    { key: 'Alt+F2', label: 'Return period', icon: 'calendar', onClick: () => selectRef.current?.focus(), group: 'period' },
    { key: 'Alt+V', label: 'Open set-off journal', icon: 'external', onClick: () => posted && nav.push('vouchers.view', { id: posted.voucherId }), disabled: !posted, group: 'go' },
    { key: 'Alt+L', label: 'Electronic cash ledger', icon: 'book', onClick: () => nav.push('gst.ledger.cash'), group: 'go' },
    { key: 'Alt+R', label: pp.composition ? 'CMP-08' : 'GSTR-3B', icon: 'gst', onClick: () => pp.key && nav.push(pp.composition ? 'gst.cmp08' : 'gst.gstr3b', { period: pp.key }), disabled: !pp.key, group: 'go' },
  ];

  return (
    <>
      <ReportScreen
        title="GST Set-off"
        subtitle={pp.label ? `${pp.composition ? 'CMP-08' : 'GSTR-3B'} · ${pp.label}` : undefined}
        periodMode="none"
        filters={pp.select(selectRef)}
        actions={actions}
        exportDef={s ? () => ({ ...setoffExport(s), title: 'GST Set-off', period: s.period.label }) : undefined}
        loading={pp.loading || (q.loading && !s)}
        refreshing={q.refreshing}
        error={pp.error ?? q.error}
        onRetry={() => (pp.error ? pp.refetch() : void q.refetch())}
        hint="Ctrl+A Post set-off · Alt+C Create challan · Enter Open challan · Alt+F2 Period · Alt+E Export · Esc Back"
      >
        {s ? (
          <SetoffBody
            s={s}
            penalty={penalty}
            others={others}
            onPenalty={setPenalty}
            onOthers={setOthers}
            canEdit={canFile && posted === null}
            onOpen={(id) => nav.push('vouchers.view', { id })}
          />
        ) : pp.key === null && !pp.loading ? (
          <EmptyState icon="calendar" title="No return period yet" body="Record sales or purchases to work out the tax for a period." />
        ) : null}
      </ReportScreen>
      {dialog === 'challan' && s ? <ChallanDialog s={s} onClose={() => setDialog(null)} /> : null}
      {dialog === 'post' && s ? <PostDialog s={s} penalty={penalty} others={others} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

function SetoffBody({
  s,
  penalty,
  others,
  onPenalty,
  onOthers,
  canEdit,
  onOpen,
}: {
  s: GstSetoffResult;
  penalty: TaxAmounts;
  others: TaxAmounts;
  onPenalty: (t: TaxAmounts) => void;
  onOthers: (t: TaxAmounts) => void;
  canEdit: boolean;
  onOpen: (id: number) => void;
}) {
  const challanCols = useMemo<Column<GstChallanRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 110 },
      { key: 'cpin', header: 'CPIN', width: 160 },
      { key: 'cin', header: 'CIN', width: 180, value: (r) => r.cin ?? '' },
      { key: 'brn', header: 'BRN', width: 140, value: (r) => r.brn ?? '' },
      { key: 'number', header: 'Voucher no.', width: 120, value: (r) => r.number ?? '' },
      { key: 'total', header: 'Amount', kind: 'amount', width: 140, total: true },
    ],
    [],
  );
  return (
    <div className="bx-gst-scroll">
      <GstHelp>
        {s.composition
          ? 'Composition tax and reverse-charge tax are paid in cash. Deposit the cash by challan (Alt+C), then post the set-off (Ctrl+A) when you file CMP-08.'
          : 'Credit is used in the order the law requires (IGST credit first; CGST credit never for SGST and vice versa; cess only for cess). Deposit the cash by challan (Alt+C), then post the set-off (Ctrl+A) when you file GSTR-3B.'}
      </GstHelp>
      {s.posted ? (
        <Banner tone="success" title={`Set-off posted on ${formatDate(s.posted.date)}`}>
          Journal {s.posted.number ?? ''} squares the GST accounts for this period. Alter or delete that journal (Alt+V) to post again.
        </Banner>
      ) : null}
      {s.notes.length > 0 ? (
        <Banner tone="info" inline>
          {s.notes.join(' ')}
        </Banner>
      ) : null}
      <div className="bx-gst-cashline" role="status" aria-live="polite">
        <span>Cash needed for {s.period.label}</span>
        <span className="bx-gst-cashline__amount">{formatMoney(s.cashTotal, { symbol: true })}</span>
        <span>{s.toDepositTotal > 0 ? `Still to deposit ${formatMoney(s.toDepositTotal, { symbol: true })}` : 'Covered by the electronic cash ledger'}</span>
      </div>
      {!s.composition ? (
        <Panel title="Credit used (input tax credit → tax head)" headingLevel={2}>
          <WideTable label="Credit utilisation">
            <thead>
              <tr>
                <th scope="col">Head</th>
                <th scope="col" className="is-num">Liability</th>
                <th scope="col" className="is-num">Credit available</th>
                {TAX_HEADS.map((h) => (
                  <th key={h} scope="col" className="is-num">
                    Paid by {HEAD_NAMES[h]} credit
                  </th>
                ))}
                <th scope="col" className="is-num">Credit carried forward</th>
              </tr>
            </thead>
            <tbody>
              {TAX_HEADS.map((to) => (
                <tr key={to}>
                  <th scope="row">{HEAD_NAMES[to]}</th>
                  <td className="is-num">{money(s.liability[to])}</td>
                  <td className="is-num">{money(s.creditAvailable[to])}</td>
                  {TAX_HEADS.map((from) => (
                    <td key={from} className="is-num">
                      {money(s.credit.find((c) => c.from === from && c.to === to)?.amount ?? 0)}
                    </td>
                  ))}
                  <td className="is-num">{money(s.creditBalance[to])}</td>
                </tr>
              ))}
            </tbody>
          </WideTable>
        </Panel>
      ) : null}
      <Panel title="Cash by head (electronic cash ledger)" headingLevel={2} description="Penalty and others are typed here; interest and late fee come from the return's own entries.">
        <WideTable label="Cash by head">
          <thead>
            <tr>
              <th scope="col">Major head</th>
              {CASH_MINOR_HEADS.map((m) => (
                <th key={m} scope="col" className="is-num">
                  {MINOR_LABELS[m]}
                </th>
              ))}
              <th scope="col" className="is-num">Total</th>
              <th scope="col" className="is-num">In cash ledger</th>
              <th scope="col" className="is-num">To deposit</th>
            </tr>
          </thead>
          <tbody>
            {s.cash.map((r) => (
              <tr key={r.head}>
                <th scope="row">{HEAD_NAMES[r.head]}</th>
                <td className="is-num">{money(r.tax)}</td>
                <td className="is-num">{money(r.interest)}</td>
                <td className="is-num">
                  {canEdit ? (
                    <AmountInput size="sm" aria-label={`Penalty ${HEAD_NAMES[r.head]}`} value={penalty[r.head] || null} onChange={(v) => onPenalty({ ...penalty, [r.head]: v ?? 0 })} />
                  ) : (
                    money(r.penalty)
                  )}
                </td>
                <td className="is-num">{money(r.fee)}</td>
                <td className="is-num">
                  {canEdit ? (
                    <AmountInput size="sm" aria-label={`Others ${HEAD_NAMES[r.head]}`} value={others[r.head] || null} onChange={(v) => onOthers({ ...others, [r.head]: v ?? 0 })} />
                  ) : (
                    money(r.others)
                  )}
                </td>
                <td className="is-num">{money(r.total)}</td>
                <td className="is-num">{money(r.available)}</td>
                <td className="is-num bx-gst-cash">{money(r.toDeposit)}</td>
              </tr>
            ))}
          </tbody>
        </WideTable>
      </Panel>
      <Panel title="Challans for this period" headingLevel={2} description="Enter opens the payment voucher.">
        <DataTable<GstChallanRow>
          aria-label="Challans"
          autoFocus
          columns={challanCols}
          rows={s.challans}
          getRowKey={(r) => String(r.voucherId)}
          onRowActivate={(r) => onOpen(r.voucherId)}
          height={Math.min(320, 40 + 32 * (s.challans.length + 2))}
          empty={<EmptyState size="sm" icon="receipt" title="No challan recorded" body="Press Alt+C after paying the challan on the portal." />}
        />
      </Panel>
    </div>
  );
}

// ───────────────────────────── Challan dialog ─────────────────────────────

function ChallanDialog({ s, onClose }: { s: GstSetoffResult; onClose: () => void }) {
  const toast = useToast();
  const nav = useNav();
  const { date } = useWorkingDate();
  const banks = useApiQuery('accounts.ledger.picker', { classes: ['cash_bank'] }, { staleTime: 60_000 });
  const [bankId, setBankId] = useState<number | null>(null);
  const [vdate, setVdate] = useState<string | null>(date);
  const [cpin, setCpin] = useState('');
  const [cin, setCin] = useState('');
  const [brn, setBrn] = useState('');
  const [challanDate, setChallanDate] = useState<string | null>(date);
  const [bankName, setBankName] = useState('');
  const [mode, setMode] = useState<'epayment' | 'neft_rtgs' | 'otc'>('epayment');
  const [grid, setGrid] = useState(() => challanGrid(challanDefaults(s)));
  const post = useApiMutation('gst.challan.post', { invalidates: ['gst', 'reports', 'vouchers', 'dashboard'] });
  const heads: CashHeadAmount[] = gridToHeads(grid);
  const total = heads.reduce((a, h) => a + h.amount, 0);
  const errs = challanFieldErrors({ cpin, cin });
  const bankRows: LedgerPickerRow[] = banks.data ?? [];
  const ready = bankId !== null && vdate !== null && total > 0 && !errs.cpin;
  const accept = async (): Promise<void> => {
    if (!ready || post.pending) return;
    try {
      const out = await post.mutate({
        date: vdate as string,
        bankLedgerId: bankId as number,
        cpin: cpin.trim(),
        cin: cin.trim() || undefined,
        brn: brn.trim() || undefined,
        challanDate: challanDate ?? undefined,
        bankName: bankName.trim() || undefined,
        mode,
        period: s.period.key ?? undefined,
        heads,
      });
      toast.success(`Challan recorded (Payment ${out.number ?? ''})`, { message: `${formatMoney(total, { symbol: true })} added to the electronic cash ledger.`, action: { label: 'Open', onClick: () => nav.push('vouchers.view', { id: out.id }) } });
      onClose();
    } catch (err) {
      toast.error('Could not record the challan', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void accept() });
  const setCell = (h: TaxHead, m: CashMinorHead, v: number | null) => setGrid((g) => ({ ...g, [h]: { ...g[h], [m]: v ?? 0 } }));
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Create GST challan"
      description={`Record a challan (PMT-06) paid for ${s.period.label}. Amounts are prefilled with what is still to deposit.`}
      footerStart={<span aria-live="polite">Total {formatMoney(total, { symbol: true })}</span>}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={post.pending} disabled={!ready} onClick={() => void accept()}>
            Record challan
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void accept() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          <div className="bx-gst-formgrid">
            <Field label="Voucher date" required>
              <DateInput data-autofocus value={vdate} onChange={setVdate} referenceDate={date} />
            </Field>
            <Field label="Paid from" required hint="Bank (or cash) ledger the challan was paid from" error={post.fieldErrors.bankLedgerId}>
              <Select
                value={bankId === null ? '' : String(bankId)}
                placeholder={banks.loading ? 'Loading…' : 'Choose the bank'}
                options={bankRows.map((r) => ({ value: String(r.id), label: r.name }))}
                onChange={(v) => setBankId(v ? Number(v) : null)}
              />
            </Field>
            <Field label="CPIN" required error={cpin ? errs.cpin : undefined}>
              <TextInput value={cpin} onChange={(e) => setCpin(e.target.value.replace(/\s/g, ''))} maxLength={14} inputMode="numeric" />
            </Field>
            <Field label="CIN" optional error={errs.cin}>
              <TextInput value={cin} onChange={(e) => setCin(e.target.value.replace(/\s/g, '').toUpperCase())} maxLength={17} />
            </Field>
            <Field label="BRN" optional hint="Bank reference number">
              <TextInput value={brn} onChange={(e) => setBrn(e.target.value)} maxLength={40} />
            </Field>
            <Field label="Challan date" optional>
              <DateInput value={challanDate} onChange={setChallanDate} referenceDate={date} />
            </Field>
            <Field label="Bank" optional>
              <TextInput value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={100} />
            </Field>
            <Field label="Mode">
              <Select
                value={mode}
                options={[
                  { value: 'epayment', label: 'e-Payment (net banking / card / UPI)' },
                  { value: 'neft_rtgs', label: 'NEFT / RTGS' },
                  { value: 'otc', label: 'Over the counter' },
                ]}
                onChange={(v) => setMode(v as 'epayment' | 'neft_rtgs' | 'otc')}
              />
            </Field>
          </div>
          <WideTable label="Challan amounts">
            <thead>
              <tr>
                <th scope="col">Major head</th>
                {CASH_MINOR_HEADS.map((m) => (
                  <th key={m} scope="col" className="is-num">
                    {MINOR_LABELS[m]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TAX_HEADS.map((h) => (
                <tr key={h}>
                  <th scope="row">{HEAD_NAMES[h]}</th>
                  {CASH_MINOR_HEADS.map((m) => (
                    <td key={m} className="is-num">
                      <AmountInput size="sm" aria-label={`${HEAD_NAMES[h]} ${MINOR_LABELS[m]}`} value={grid[h][m] || null} onChange={(v) => setCell(h, m, v)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </WideTable>
        </Stack>
      </div>
    </Modal>
  );
}

// ───────────────────────────── Post dialog ─────────────────────────────

function PostDialog({ s, penalty, others, onClose }: { s: GstSetoffResult; penalty: TaxAmounts; others: TaxAmounts; onClose: () => void }) {
  const toast = useToast();
  const nav = useNav();
  const { date } = useWorkingDate();
  const [vdate, setVdate] = useState<string | null>(date < s.period.to ? s.period.to : date);
  const [narration, setNarration] = useState('');
  const post = useApiMutation('gst.setoff.post', { invalidates: ['gst', 'reports', 'vouchers', 'dashboard'] });
  const accept = async (): Promise<void> => {
    if (!vdate || post.pending || !s.period.key) return;
    try {
      const out = await post.mutate({ period: s.period.key, date: vdate, penalty, others, narration: narration.trim() || undefined });
      toast.success(`Set-off posted (Journal ${out.number ?? ''})`, { action: { label: 'Open', onClick: () => nav.push('vouchers.view', { id: out.id }) } });
      onClose();
    } catch (err) {
      toast.error('Could not post the set-off', { message: userMessage(err) });
    }
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void accept() });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Post set-off for ${s.period.label}`}
      description={
        s.toDepositTotal > 0
          ? `${formatMoney(s.toDepositTotal, { symbol: true })} has not been deposited yet: the electronic cash ledger will show a negative balance until the challan is recorded.`
          : 'Posts one journal: the tax accounts are squared off against the credit used and the cash ledger.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={post.pending} disabled={!vdate} onClick={() => void accept()}>
            Post set-off
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void accept() }} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="Date" required hint={`On or after ${formatDate(s.period.to)} — usually the filing date`} error={post.fieldErrors.date}>
            <DateInput data-autofocus value={vdate} onChange={setVdate} referenceDate={date} />
          </Field>
          <Field label="Narration" optional>
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={500} />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}
