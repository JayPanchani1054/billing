import { useMemo } from 'react';
import { voucherChoices } from '../lib/voucherTypes.ts';
import type { VoucherChoice } from '../lib/voucherTypes.ts';
import { useAppState } from '../state.tsx';
import { useApiQuery } from './useApiQuery.ts';

/**
 * Voucher types for F10 and Go To: predefined + the company's own active types (needs
 * masters.view to read them; otherwise — or while loading — the predefined list).
 * Shares its cache entry with voucher entry ('accounts.voucherType.list' {}).
 */
export function useVoucherChoices(): VoucherChoice[] {
  const app = useAppState();
  const q = useApiQuery('accounts.voucherType.list', {}, { enabled: app.can('masters.view'), staleTime: 60_000 });
  const rows = q.data?.rows;
  return useMemo(() => voucherChoices(rows), [rows]);
}
