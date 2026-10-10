/**
 * Foreign-currency panel of voucher entry (rendered by vouchers.entry in its side column when F11 ›
 * Multiple currencies is on and the voucher touches a ledger kept in a foreign currency).
 *
 * Invoice in a currency: the document value in that currency from the form (amount fields hold
 * foreign × 100), the rate, and the rupee value the server computed in the last check. Other
 * vouchers: each foreign line (amount @ rate → rupees) and the realised exchange difference the voucher
 * will post. Alt+Y (registered by the entry screen) changes the currency / rate or a line's amount.
 */
import { formatExchangeRate, formatForex } from '../../../shared/forex.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { ForexCurrency, ForexVoucherPreview, VoucherForexInput } from '../../../shared/types/forex.ts';
import { Button, Kbd, Stack } from '../../ui/index.ts';
import { decodeForex } from './lib/entry.ts';
import { entrySummary } from './lib/model.ts';

export interface ForexEntryPanelProps {
  /** Invoice in a foreign currency: its currency + rate (null otherwise). */
  doc: VoucherForexInput | null;
  docCurrency: ForexCurrency | undefined;
  /** Invoice total on the form (foreign × 10^formDecimals) when `doc` is set. */
  formTotal: Paise;
  /** Decimal places of the form's amount fields (VoucherForm.forexDecimals; default 2). */
  formDecimals?: number;
  /** Rupee invoice value of the last server check (null: not checked yet). */
  serverTotal: Paise | null;
  preview: ForexVoucherPreview | undefined;
  currencyOf: (id: number) => ForexCurrency | undefined;
  checking?: boolean;
  /** Something on the voucher is in a foreign currency (else the panel hides). */
  relevant: boolean;
  onChange?: () => void;
}

const money = (p: Paise): string => formatMoney(p);

export function ForexEntryPanel(p: ForexEntryPanelProps) {
  if (!p.relevant) return null;
  const lines = entrySummary(p.preview, p.currencyOf, money);
  const c = p.docCurrency;
  return (
    <section className="bx-vch-side" aria-label="Foreign currency" aria-live="polite">
      <h3 className="bx-vch-side__title">
        Foreign currency {p.checking ? <span className="bx-muted">· checking…</span> : null}
      </h3>
      <Stack gap={1}>
        {p.doc && c ? (
          <>
            <span>
              Invoice in {c.formalName} @ ₹{formatExchangeRate(p.doc.rate)}
            </span>
            <span className="bx-num">
              Total <strong>{formatForex(decodeForex(p.formTotal, p.formDecimals ?? 2), c.decimalPlaces, c.symbol)}</strong>
              {p.serverTotal !== null ? <> · books ₹ {money(p.serverTotal)}</> : null}
            </span>
            <span className="bx-muted">Rates and amounts on the lines are in {c.symbol}; GST is computed in rupees.</span>
          </>
        ) : null}
        {lines
          .filter((l) => !(p.doc && l.key === 'doc'))
          .map((l) => (
            <span key={l.key}>
              <span className="bx-muted">{l.label}:</span> <span className="bx-num">{l.value}</span>
            </span>
          ))}
        {lines.length === 0 && !p.doc ? <span className="bx-muted">Enter the amount of the foreign-currency line (Alt+Y).</span> : null}
        {p.onChange ? (
          <Button size="sm" variant="ghost" icon="edit" onClick={p.onChange}>
            {p.doc ? 'Currency & rate' : 'Amount & rate'} <Kbd keys="Alt+Y" size="sm" />
          </Button>
        ) : null}
      </Stack>
    </section>
  );
}
