/**
 * Dashboard card (ModuleDef.dashboardCards) for composition taxpayers: CMP-08 for the quarter being
 * filed (due on the 18th after the quarter) and the next one, and GSTR-4 for the last financial year
 * (due 30 April) until it is marked filed. Hidden for regular taxpayers and without gst.view. No hotkeys
 * (the Gateway embeds the dashboard): each line is a link to its return.
 */
import { formatDate, useApiQuery, useAppState, useCan, useNav, useWorkingDate } from '../../app/index.ts';
import { Badge, Button, Card, Inline, Stack } from '../../ui/index.ts';
import { compositionDues } from './lib/gstplus.ts';

export function CompositionCard({ className }: { className?: string }) {
  const app = useAppState();
  const canView = useCan('gst.view');
  const nav = useNav();
  const { date } = useWorkingDate();
  const on = app.company?.gstEnabled === true && app.company.gstRegistration === 'composition' && canView;
  const filings = useApiQuery('gst.filing.list', {}, { enabled: on, staleTime: 60_000 });
  if (!on) return null;
  const dues = compositionDues(date, filings.data ?? []);
  return (
    <Card className={className} title="Composition returns" subtitle="CMP-08 by the 18th after each quarter · GSTR-4 by 30 April" padding="sm">
      <Stack gap={2}>
        {dues.map((d) => (
          <Inline gap={2} justify="between" key={`${d.form}:${d.period}`}>
            <Button size="sm" variant="link" onClick={() => nav.push(d.form === 'cmp08' ? 'gst.cmp08' : 'gst.gstr4', d.form === 'cmp08' ? { period: d.period } : { fy: d.period })}>
              {d.label}
            </Button>
            {d.filed ? (
              <Badge tone="success" size="sm">
                Filed
              </Badge>
            ) : (
              <Badge tone={d.overdue ? 'danger' : 'warning'} size="sm">
                {d.overdue ? `Overdue since ${formatDate(d.dueDate)}` : `Due ${formatDate(d.dueDate)}`}
              </Badge>
            )}
          </Inline>
        ))}
        <p className="bx-muted">Due dates as notified; check the portal for any extension.</p>
      </Stack>
    </Card>
  );
}
