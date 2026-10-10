/** Shared bits of the forex screens. */
import { useMemo } from 'react';
import type { ForexLedgerCurrency } from '../../../shared/types/forex.ts';
import { Screen, useNav } from '../../app/index.ts';
import { Button, Combobox, EmptyState } from '../../ui/index.ts';

/** Shown instead of a forex screen while F11 › Multiple currencies is off. */
export function ForexOff({ title }: { title: string }) {
  const nav = useNav();
  return (
    <Screen title={title} icon="rupee" hint="Esc Back">
      <EmptyState
        icon="rupee"
        title="Multiple currencies is turned off for this company"
        body="Turn it on in Features (F11) › Accounting to keep customers, suppliers and bank accounts in a foreign currency."
        action={
          <Button variant="primary" onClick={() => nav.push('company.features')}>
            Open Features (F11)
          </Button>
        }
      />
    </Screen>
  );
}

/** Picker over the ledgers kept in a foreign currency (from forex.context). */
export function ForexLedgerPicker(props: {
  id?: string;
  ledgers: readonly ForexLedgerCurrency[];
  symbolOf: (currencyId: number) => string;
  value: number | null;
  onChange: (ledgerId: number | null) => void;
  autoFocus?: boolean;
}) {
  const current = useMemo(() => props.ledgers.find((l) => l.ledgerId === props.value) ?? null, [props.ledgers, props.value]);
  return (
    <Combobox<ForexLedgerCurrency>
      id={props.id}
      aria-label="Ledger kept in a foreign currency"
      items={props.ledgers}
      getKey={(l) => String(l.ledgerId)}
      getLabel={(l) => l.ledgerName}
      rightMeta={(l) => <span className="bx-muted">{props.symbolOf(l.currencyId)}</span>}
      value={current}
      onChange={(l) => props.onChange(l?.ledgerId ?? null)}
      placeholder="Choose a ledger kept in a foreign currency"
      emptyText="No ledger is kept in a foreign currency (Ledger › Currency)"
      {...(props.autoFocus ? { 'data-autofocus': true } : {})}
    />
  );
}
