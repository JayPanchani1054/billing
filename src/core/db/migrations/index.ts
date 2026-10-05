/**
 * Ordered migration list. Versions are pre-assigned per module (10, 20, … 140) so modules
 * can evolve their own tables without clashing. Never edit a migration that has shipped —
 * add a follow-up within your module's range (e.g. 31, 32 for accounts).
 */
import { migration001 } from './001_init.ts';
import { migration010 } from './010_company.ts';
import { migration020 } from './020_security.ts';
import { migration030 } from './030_accounts.ts';
import { migration040 } from './040_inventory.ts';
import { migration050 } from './050_vouchers.ts';
import { migration060 } from './060_reports.ts';
import { migration070 } from './070_stock.ts';
import { migration080 } from './080_outstanding.ts';
import { migration090 } from './090_gst.ts';
import { migration100 } from './100_gstrecon.ts';
import { migration110 } from './110_banking.ts';
import { migration120 } from './120_data.ts';
import { migration130 } from './130_dashboard.ts';
import { migration140 } from './140_print.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  migration001,
  migration010,
  migration020,
  migration030,
  migration040,
  migration050,
  migration060,
  migration070,
  migration080,
  migration090,
  migration100,
  migration110,
  migration120,
  migration130,
  migration140,
];
