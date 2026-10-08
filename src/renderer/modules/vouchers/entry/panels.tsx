/**
 * Side panels of the voucher screen: party details (GSTIN, state, balance, credit limit, pending
 * bills), live totals with the GST breakup and amount in words, and the checks list (server
 * warnings from preview / save, shown inline — info ones never interrupt saving).
 */
import { memo } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../../shared/format.ts';
import { stateLabel } from '../../../../shared/gst/index.ts';
import type { Paise } from '../../../../shared/money.ts';
import { amountInWords } from '../../../../shared/words.ts';
import type { PartyContext, VoucherWarning } from '../../../../shared/types/vouchers.ts';
import { Badge, Banner, Button, Icon, KeyValueList, Skeleton } from '../../../ui/index.ts';
import { REF_TYPE_LABEL } from '../lib/bills.ts';
import type { BillAllocationInput } from '../../../../shared/types/vouchers.ts';
import type { TaxBreakupRow } from '../lib/masters.ts';

const REG_TEXT: Readonly<Record<string, string>> = {
  regular: 'Regular',
  composition: 'Composition',
  unregistered: 'Unregistered',
  consumer: 'Consumer',
  sez: 'SEZ',
  overseas: 'Overseas',
  deemed_export: 'Deemed export',
  uin: 'UIN holder',
};

export interface PartyPanelProps {
  party: PartyContext | undefined;
  loading: boolean;
  /** Amount this voucher adds to the party's Dr balance (sales) — for the credit-limit line. */
  voucherEffect: Paise;
  bills: readonly BillAllocationInput[] | null;
  billWiseOn: boolean;
  onBills?: () => void;
  onOpenLedger?: () => void;
}

export const PartyPanel = memo(function PartyPanel({ party, loading, voucherEffect, bills, billWiseOn, onBills, onOpenLedger }: PartyPanelProps) {
  if (loading && !party) {
    return (
      <section className="bx-vch-side" aria-label="Party details">
        <Skeleton lines={5} />
      </section>
    );
  }
  if (!party) return null;
  const after = party.balance + voucherEffect;
  const overLimit = party.creditLimit !== null && party.creditLimit > 0 && voucherEffect > 0 && after > party.creditLimit;
  const pending = party.pendingBills.slice(0, 6);
  return (
    <section className="bx-vch-side" aria-label="Party details">
      <div className="bx-vch-side__head">
        <h3 className="bx-vch-side__title">{party.name}</h3>
        {onOpenLedger ? (
          <Button size="sm" variant="link" onClick={onOpenLedger}>
            Ledger
          </Button>
        ) : null}
      </div>
      <KeyValueList
        layout="inline"
        labelWidth={110}
        items={[
          { label: 'GSTIN', value: party.gstin ?? (party.kind === 'debtor' || party.kind === 'creditor' ? 'Not registered' : '—') },
          { label: 'Registration', value: party.registrationType ? (REG_TEXT[party.registrationType] ?? party.registrationType) : '—', hideEmpty: true },
          { label: 'State', value: party.stateCode ? stateLabel(party.stateCode) : (party.country ?? '—') },
          { label: 'Balance', value: <span className="bx-num">{formatDrCr(party.balance, { keepZero: true })}</span> },
          ...(party.creditLimit
            ? [{ label: 'Credit limit', value: <span className={overLimit ? 'bx-num bx-vch-over' : 'bx-num'}>{`₹ ${formatMoney(party.creditLimit)}${overLimit ? ' — exceeded' : ''}`}</span> }]
            : []),
          ...(party.creditDays ? [{ label: 'Credit period', value: `${party.creditDays} days` }] : []),
        ]}
      />
      {party.billWise && billWiseOn ? (
        <div className="bx-vch-side__bills">
          <div className="bx-vch-side__head">
            <h4 className="bx-vch-side__subtitle">Pending bills</h4>
            {onBills ? (
              <Button size="sm" variant="ghost" icon="receipt" shortcut="Alt+B" onClick={onBills}>
                {bills ? 'Edit allocation' : 'Allocate'}
              </Button>
            ) : null}
          </div>
          {pending.length === 0 ? (
            <p className="bx-muted">No pending bills.</p>
          ) : (
            <ul className="bx-vch-side__list">
              {pending.map((b) => (
                <li key={b.billName}>
                  <span>{b.billName}</span>
                  <span className="bx-muted">{b.dueDate ? `due ${formatDate(b.dueDate, 'D-MMM-YY')}` : formatDate(b.billDate, 'D-MMM-YY')}</span>
                  <span className="bx-num">{formatDrCr(b.amount)}</span>
                </li>
              ))}
              {party.pendingBills.length > pending.length ? <li className="bx-muted">+ {party.pendingBills.length - pending.length} more</li> : null}
            </ul>
          )}
          {bills ? (
            <p className="bx-vch-side__alloc">
              This voucher: {bills.map((b) => `${REF_TYPE_LABEL[b.refType]}${b.billName ? ` ${b.billName}` : ''} ₹ ${formatMoney(b.amount)}`).join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});

export interface TotalsPanelProps {
  title: string;
  /** Rows above the grand total (taxable, tax heads, charges, round off). */
  rows: ReadonlyArray<{ key: string; label: ReactNode; amount: Paise; muted?: boolean }>;
  total: Paise;
  totalLabel: string;
  words: boolean;
  notes: readonly string[];
  /** Server figure when it differs from the client's (shown as a note). */
  serverTotal: Paise | null;
  extra?: ReactNode;
}

export const TotalsPanel = memo(function TotalsPanel({ title, rows, total, totalLabel, words, notes, serverTotal, extra }: TotalsPanelProps) {
  return (
    <section className="bx-vch-side bx-vch-totals" aria-label={title}>
      <h3 className="bx-vch-side__title">{title}</h3>
      <dl className="bx-vch-totals__list">
        {rows.map((r) => (
          <div key={r.key} className={r.muted ? 'bx-vch-totals__row is-muted' : 'bx-vch-totals__row'}>
            <dt>{r.label}</dt>
            <dd className="bx-num">{r.amount < 0 ? `(−) ${formatMoney(-r.amount)}` : formatMoney(r.amount)}</dd>
          </div>
        ))}
        <div className="bx-vch-totals__row is-grand">
          <dt>{totalLabel}</dt>
          <dd className="bx-num" aria-live="polite">
            ₹ {formatMoney(total)}
          </dd>
        </div>
      </dl>
      {words && total > 0 ? <p className="bx-vch-totals__words">{amountInWords(total)}</p> : null}
      {serverTotal !== null && serverTotal !== total ? (
        <p className="bx-vch-totals__note">
          <Icon name="info" size="sm" /> The books will record ₹ {formatMoney(serverTotal)} (checked with the saved masters).
        </p>
      ) : null}
      {extra}
      {notes.length > 0 ? (
        <ul className="bx-vch-totals__notes" aria-label="GST notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
});

export function breakupRows(o: {
  taxable: Paise;
  tax: readonly TaxBreakupRow[];
  outside: Paise;
  roundOff: Paise;
  showTaxable: boolean;
}): Array<{ key: string; label: ReactNode; amount: Paise; muted?: boolean }> {
  const out: Array<{ key: string; label: ReactNode; amount: Paise; muted?: boolean }> = [];
  if (o.showTaxable) out.push({ key: 'taxable', label: 'Taxable value', amount: o.taxable });
  for (const t of o.tax) out.push({ key: t.key, label: t.label, amount: t.amount, muted: t.key.startsWith('rc:') });
  if (o.outside !== 0) out.push({ key: 'outside', label: 'Other charges / deductions', amount: o.outside });
  if (o.roundOff !== 0) out.push({ key: 'ro', label: 'Round off', amount: o.roundOff });
  return out;
}

/** One line of the checks list: a server warning, or a hard error the preview reported. */
export interface CheckItem {
  key: string;
  level: VoucherWarning['level'];
  message: string;
  /** VoucherInput path (items[2].qty, partyLedgerId…) when known. */
  path?: string;
}

export const checkItemsOf = (warnings: readonly VoucherWarning[]): CheckItem[] => warnings.map((w, i) => ({ key: `${w.code}-${i}`, level: w.level, message: w.message, path: w.path }));

export interface ChecksPanelProps {
  items: readonly CheckItem[];
  checking: boolean;
  onFocusPath?: (path: string) => void;
}

const LEVEL_TONE = { block: 'danger', confirm: 'warning', info: 'info' } as const;
const LEVEL_TEXT = { block: 'Must fix', confirm: 'Check', info: 'Note' } as const;

export const ChecksPanel = memo(function ChecksPanel({ items, checking, onFocusPath }: ChecksPanelProps) {
  if (items.length === 0 && !checking) return null;
  const sorted = [...items].sort((a, b) => rank(a.level) - rank(b.level));
  return (
    <section className="bx-vch-side" aria-label="Checks" aria-live="polite">
      <h3 className="bx-vch-side__title">Checks {checking ? <span className="bx-muted">· checking…</span> : null}</h3>
      <ul className="bx-vch-checks">
        {sorted.map((w) => (
          <li key={w.key} className="bx-vch-checks__item">
            <Badge size="sm" tone={LEVEL_TONE[w.level]}>
              {LEVEL_TEXT[w.level]}
            </Badge>
            {w.path && onFocusPath ? (
              <button type="button" className="bx-vch-checks__link" onClick={() => onFocusPath(w.path as string)}>
                {w.message}
              </button>
            ) : (
              <span>{w.message}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
});

const rank = (l: VoucherWarning['level']): number => (l === 'block' ? 0 : l === 'confirm' ? 1 : 2);

export function ErrorBanner({ title, messages, onDismiss }: { title: string; messages: readonly string[]; onDismiss: () => void }) {
  if (messages.length === 0) return null;
  return (
    <Banner tone="danger" title={title} onDismiss={onDismiss}>
      {messages.length === 1 ? (
        messages[0]
      ) : (
        <ul className="bx-vch-banner-list">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </Banner>
  );
}
