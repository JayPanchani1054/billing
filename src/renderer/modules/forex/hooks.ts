/**
 * Forex context for entry screens: which ledgers are kept in a foreign currency, the currencies and the
 * gain/loss settings. Loaded only when F11 › Multiple currencies is on (otherwise nothing is foreign).
 */
import { useMemo } from 'react';
import type { ForexContext, ForexCurrency } from '../../../shared/types/forex.ts';
import { useApiQuery, useFeatures } from '../../app/index.ts';

export interface ForexEntryContext {
  enabled: boolean;
  data: ForexContext | undefined;
  /** Currency a ledger is kept in, when foreign (undefined otherwise / feature off). */
  currencyOfLedger(ledgerId: number | null | undefined): ForexCurrency | undefined;
  currencyById(id: number | null | undefined): ForexCurrency | undefined;
}

export function useForexContext(): ForexEntryContext {
  const features = useFeatures();
  const enabled = features.multiCurrency === true;
  const q = useApiQuery('forex.context', {}, { enabled, staleTime: 60_000 });
  const data = enabled ? q.data : undefined;
  return useMemo(() => {
    const currencies = new Map((data?.currencies ?? []).map((c) => [c.id, c]));
    const ledgers = new Map((data?.ledgers ?? []).map((l) => [l.ledgerId, l.currencyId]));
    return {
      enabled,
      data,
      currencyOfLedger: (id) => {
        if (!enabled || id === null || id === undefined) return undefined;
        const c = ledgers.get(id);
        return c === undefined ? undefined : currencies.get(c);
      },
      currencyById: (id) => (id === null || id === undefined ? undefined : currencies.get(id)),
    };
  }, [enabled, data]);
}
