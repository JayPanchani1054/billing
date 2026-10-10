/**
 * Gateway notice (ModuleDef.gatewayNotices): TDS / TCS deposits overdue or due within a week, or a
 * quarterly statement past its due date, as on the working date. Dismissed for the rest of the
 * working day (per company). No hotkeys of its own.
 */
import { useState } from 'react';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import { useCan, useCompany, useFeatures } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import { Banner, Button, Stack } from '../../ui/index.ts';
import { dueNoticeText } from './lib/model.ts';

function readFlag(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, '1');
  } catch {
    // Storage unavailable: the notice shows again next time.
  }
}

export function TdsDueNotice() {
  const features = useFeatures();
  const can = useCan('tds.view');
  const company = useCompany();
  const { date } = useWorkingDate();
  const nav = useNav();
  const key = `bahi.tds.due.${company.id}.${date}`;
  const [dismissed, setDismissed] = useState(() => readFlag(key));
  const tds = useApiQuery('tds.outstanding', { asOf: date, kind: 'tds' }, { enabled: features.tds && can && !dismissed, staleTime: 60_000 });
  const tcs = useApiQuery('tds.outstanding', { asOf: date, kind: 'tcs' }, { enabled: features.tcs && can && !dismissed, staleTime: 60_000 });
  if (!can || dismissed) return null;
  const items = [features.tds && tds.data ? { kind: 'tds' as const, n: dueNoticeText(tds.data) } : null, features.tcs && tcs.data ? { kind: 'tcs' as const, n: dueNoticeText(tcs.data) } : null].filter(
    (x): x is { kind: 'tds' | 'tcs'; n: NonNullable<ReturnType<typeof dueNoticeText>> } => x !== null && x.n !== null,
  );
  if (items.length === 0) return null;
  const tone = items.some((x) => x.n.tone === 'danger') ? 'danger' : 'warning';
  return (
    <Banner
      tone={tone}
      icon="percent"
      title={tone === 'danger' ? 'TDS / TCS needs attention' : 'TDS / TCS due soon'}
      onDismiss={() => {
        writeFlag(key);
        setDismissed(true);
      }}
      action={
        <Button size="sm" variant="primary" onClick={() => nav.push('tds.outstanding', { kind: items[0].kind })}>
          Review
        </Button>
      }
    >
      <Stack gap={1}>
        {items.map((x) => (
          <span key={x.kind}>{x.n.text}</span>
        ))}
      </Stack>
    </Banner>
  );
}
