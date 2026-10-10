/**
 * Aggregated route table. Each module owns src/core/modules/<module>/routes.ts.
 * Route names must be globally unique ('<module>.<entity>.<action>').
 */
import { appRoutes } from '../app/routes.ts';
import { companyRoutes } from '../modules/company/routes.ts';
import { securityRoutes } from '../modules/security/routes.ts';
import { accountsRoutes } from '../modules/accounts/routes.ts';
import { inventoryRoutes } from '../modules/inventory/routes.ts';
import { vouchersRoutes } from '../modules/vouchers/routes.ts';
import { reportsRoutes } from '../modules/reports/routes.ts';
import { stockRoutes } from '../modules/stock/routes.ts';
import { outstandingRoutes } from '../modules/outstanding/routes.ts';
import { gstRoutes } from '../modules/gst/routes.ts';
import { gstreconRoutes } from '../modules/gstrecon/routes.ts';
import { bankingRoutes } from '../modules/banking/routes.ts';
import { dataRoutes } from '../modules/data/routes.ts';
import { dashboardRoutes } from '../modules/dashboard/routes.ts';
import { printRoutes } from '../modules/print/routes.ts';
import { chequesRoutes } from '../modules/cheques/routes.ts';
import { tdsRoutes } from '../modules/tds/routes.ts';
import { documentsRoutes } from '../modules/documents/routes.ts';
import { mfgRoutes } from '../modules/mfg/routes.ts';
import { forexRoutes } from '../modules/forex/routes.ts';
import { attachmentsRoutes } from '../modules/attachments/routes.ts';
import { posRoutes } from '../modules/pos/routes.ts';

export const routes = {
  ...appRoutes,
  ...companyRoutes,
  ...securityRoutes,
  ...accountsRoutes,
  ...inventoryRoutes,
  ...vouchersRoutes,
  ...reportsRoutes,
  ...stockRoutes,
  ...outstandingRoutes,
  ...gstRoutes,
  ...gstreconRoutes,
  ...bankingRoutes,
  ...dataRoutes,
  ...dashboardRoutes,
  ...printRoutes,
  ...chequesRoutes,
  ...tdsRoutes,
  ...documentsRoutes,
  ...mfgRoutes,
  ...forexRoutes,
  ...attachmentsRoutes,
  ...posRoutes,
};

export type ApiRoutes = typeof routes;
export type RouteName = keyof ApiRoutes;
