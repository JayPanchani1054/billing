/**
 * 'vouchers.view' panel (ModuleDef.voucherPanels): the voucher's GST details (advance, adjustment /
 * refund of advances, bill of entry, challan, stat adjustment, set-off) and, for an outward document of
 * a filed GSTR-1 period, its amendment log. Renders nothing when there is nothing GST-specific to show.
 */
import { useEffect, useRef } from 'react';
import type { VoucherPanelProps } from '../../app/index.ts';
import { formatMoney, useApiQuery, useAppState } from '../../app/index.ts';
import { Badge, Card, Stack } from '../../ui/index.ts';
import { amendmentTableLabel, gstDetailsSummary, taxSum } from './lib/gstplus.ts';

const OUTWARD = new Set(['sales', 'credit_note', 'debit_note']);

export function VoucherGstPanel({ voucherId, baseType, updatedAt }: VoucherPanelProps) {
  const app = useAppState();
  const on = app.company?.gstEnabled === true;
  const detail = useApiQuery('vouchers.get', { id: voucherId }, { enabled: on, staleTime: 0 });
  const amend = useApiQuery('gst.amendments.list', { voucherId }, { enabled: on && OUTWARD.has(baseType), staleTime: 0 });
  const seen = useRef(updatedAt);
  const refetchAmend = amend.refetch;
  useEffect(() => {
    if (seen.current === updatedAt) return;
    seen.current = updatedAt;
    if (on && OUTWARD.has(baseType)) void refetchAmend();
  }, [updatedAt, refetchAmend, on, baseType]);
  if (!on) return null;
  const summary = gstDetailsSummary(detail.data?.input.gstDetails);
  const rows = amend.data ?? [];
  if (!summary && rows.length === 0) return null;
  return (
    <Card title="GST details" padding="sm">
      <Stack gap={2}>
        {summary ? <p>{summary}</p> : null}
        {rows.map((r) => (
          <p key={r.id}>
            <Badge tone={r.table === 'late' ? 'info' : 'warning'} size="sm">
              {amendmentTableLabel(r)}
            </Badge>{' '}
            {r.kind === 'added' ? 'Added after GSTR-1 for' : 'Changed after GSTR-1 for'} {r.originalPeriod} was filed — reported in {r.amendPeriod} (Δ taxable {formatMoney(r.delta.taxable)}, Δ tax{' '}
            {formatMoney(taxSum(r.delta))}).
          </p>
        ))}
      </Stack>
    </Card>
  );
}
