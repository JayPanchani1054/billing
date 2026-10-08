/**
 * Dashboard routes. 'dashboard.summary' is read-only and heavy (several aggregates): access
 * 'reports.view', transactional: false. Gross profit needs reports.financial and the GST card / e-invoice
 * counts need gst.view — without them those parts come back null. DTOs: src/shared/types/dashboard.ts.
 */
import type { DashboardSummary } from '../../../shared/types/dashboard.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v } from '../../lib/validate.ts';
import { summaryForCtx } from './summary.ts';

export const DashboardSummaryInputSchema = v
  .object({ asOf: v.date(), from: v.date(), to: v.date() })
  .refine((x) => (x.from > x.to ? 'The period ends before it starts. Choose an end date on or after the start date.' : null));

export const dashboardRoutes = {
  'dashboard.summary': companyRoute({
    access: 'reports.view',
    transactional: false,
    input: DashboardSummaryInputSchema,
    handler: (ctx, input): DashboardSummary => summaryForCtx(ctx, input),
  }),
} satisfies RouteMap;
