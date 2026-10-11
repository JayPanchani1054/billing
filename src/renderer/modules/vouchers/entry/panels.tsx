/**
 * Voucher entry panels (2.1, SPEC-21 D13/D15/D16): the one-line party facts under the party, the sticky
 * totals strip of an invoice, the side column's pending bills of a receipt / payment party, and the checks
 * list (server warnings from preview / save — the side column shows it only with something to fix or
 * confirm; info ones never interrupt saving). Every figure comes from the pure builders of lib/strip.ts.
 */
import { Fragment, memo } from 'react';
import { formatDate } from '../../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../../shared/format.ts';
import type { PartyContext, VoucherWarning } from '../../../../shared/types/vouchers.ts';
import { Badge, Banner, Button, Skeleton } from '../../../ui/index.ts';
import { stripAmount } from '../lib/strip.ts';
import type { PartyLineSegment, TotalsStrip } from '../lib/strip.ts';

/**
 * "Cur bal 54,356.00 Cr · Overdue 14,644.00 (190 d) · Limit exceeded" — one muted line, no keys (D15). The
 * line is always there (empty until a party is chosen), so choosing one never moves the grid.
 */
export function PartyLine({ segments, onBalance }: { segments: readonly PartyLineSegment[]; onBalance?: () => void }) {
  if (segments.length === 0) {
    return (
      <p className="bx-vch-partyline" aria-hidden="true">
        {'\u00a0'}
      </p>
    );
  }
  return (
    <p className="bx-vch-partyline">
      {segments.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 ? ' · ' : null}
          {s.key === 'balance' && onBalance ? (
            <button type="button" className="bx-vch-partyline__link" title="Open the ledger" onClick={onBalance}>
              {s.text}
            </button>
          ) : (
            <span className={s.danger ? 'bx-vch-over' : undefined}>{s.text}</span>
          )}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * The sticky totals strip of an invoice (D13): Taxable · CGST · SGST (or IGST) · Cess · Round off ·
 * Total ₹ — right-aligned; the Total's tooltip says the supply kind, the GSTR-1 table and the amount in
 * words; notes (engine notes, the server figure when it differs) as a second muted line.
 */
export const TotalsStripBar = memo(function TotalsStripBar({ strip, tooltip, notes }: { strip: TotalsStrip; tooltip: string; notes: readonly string[] }) {
  return (
    <section className="bx-vch-strip" aria-label="Totals">
      <dl className="bx-vch-strip__row bx-num">
        {strip.items.map((i) => (
          <div key={i.key} className={i.muted ? 'bx-muted' : undefined}>
            <dt>{i.label}</dt>
            <dd>{stripAmount(i.amount)}</dd>
          </div>
        ))}
        <div className="bx-vch-strip__total" title={tooltip || undefined}>
          <dt>Total</dt>
          <dd aria-live="polite">{`₹ ${formatMoney(strip.total)}`}</dd>
        </div>
      </dl>
      {notes.length > 0 ? <p className="bx-vch-strip__notes">{notes.join(' · ')}</p> : null}
    </section>
  );
});

export interface PartyBillsPanelProps {
  party: PartyContext | undefined;
  loading: boolean;
  onOpenLedger?: () => void;
}

/**
 * The side column of a receipt / payment whose party keeps bills (D16): the party, its balance and its
 * pending bills (top 5 + "N more") — the work of the voucher, so it stays in view. Plain text, no card.
 */
export const PartyBillsPanel = memo(function PartyBillsPanel({ party, loading, onOpenLedger }: PartyBillsPanelProps) {
  if (loading && !party) {
    return (
      <section className="bx-vch-side" aria-label="Party details">
        <Skeleton lines={4} />
      </section>
    );
  }
  if (!party) return null;
  const pending = party.pendingBills.slice(0, 5);
  return (
    <section className="bx-vch-side" aria-label="Party details">
      <h3 className="bx-vch-side__title">
        {party.name}
        {onOpenLedger ? (
          <>
            {' · '}
            <Button variant="link" onClick={onOpenLedger}>
              Ledger
            </Button>
          </>
        ) : null}
      </h3>
      <p className="bx-num">Cur bal {formatDrCr(party.balance, { keepZero: true })}</p>
      <h4 className="bx-vch-side__subtitle">Pending bills</h4>
      {pending.length === 0 ? (
        <p className="bx-muted">None</p>
      ) : (
        <ul className="bx-vch-side__list">
          {pending.map((b) => (
            <li key={b.billName}>
              <span>{b.billName}</span>
              <span className="bx-muted">{formatDate(b.dueDate ?? b.billDate, 'D-MMM-YY')}</span>
              <span className="bx-num">{formatDrCr(b.amount)}</span>
            </li>
          ))}
          {party.pendingBills.length > pending.length ? <li className="bx-muted">{party.pendingBills.length - pending.length} more</li> : null}
        </ul>
      )}
    </section>
  );
});

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

/** D16: the side column shows the checks only when one must be fixed or confirmed (info notes stay on their rows). */
export const hasWork = (items: readonly CheckItem[]): boolean => items.some((i) => i.level !== 'info');

export const ChecksPanel = memo(function ChecksPanel({ items, checking, onFocusPath }: ChecksPanelProps) {
  if (!hasWork(items)) return null;
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
