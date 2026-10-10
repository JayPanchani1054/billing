/** All feature modules, in Gateway display order. Each module owns src/renderer/modules/<module>/. */
import type { ModuleDef } from '../app/registry.ts';
import { companyModule } from './company/index.ts';
import { securityModule } from './security/index.ts';
import { accountsModule } from './accounts/index.ts';
import { inventoryModule } from './inventory/index.ts';
import { vouchersModule } from './vouchers/index.ts';
import { reportsModule } from './reports/index.ts';
import { stockModule } from './stock/index.ts';
import { outstandingModule } from './outstanding/index.ts';
import { gstModule } from './gst/index.ts';
import { gstreconModule } from './gstrecon/index.ts';
import { bankingModule } from './banking/index.ts';
import { dataModule } from './data/index.ts';
import { dashboardModule } from './dashboard/index.ts';
import { printModule } from './print/index.ts';
import { chequesModule } from './cheques/index.ts';
import { tdsModule } from './tds/index.ts';
import { documentsModule } from './documents/index.ts';
import { mfgModule } from './mfg/index.ts';
import { attachmentsModule } from './attachments/index.ts';
import { forexModule } from './forex/index.ts';

export const modules: ModuleDef[] = [
  companyModule,
  securityModule,
  accountsModule,
  inventoryModule,
  vouchersModule,
  reportsModule,
  stockModule,
  outstandingModule,
  gstModule,
  gstreconModule,
  bankingModule,
  dataModule,
  dashboardModule,
  printModule,
  chequesModule,
  tdsModule,
  documentsModule,
  mfgModule,
  attachmentsModule,
  forexModule,
];
