/**
 * Ordered migration list. Versions were pre-assigned per module (10, 20, … 140) so modules could
 * build their tables without clashing. Never edit a migration that has shipped. NOTE: migrations
 * are driven by PRAGMA user_version (migrate.ts), so a follow-up must be numbered ABOVE the highest
 * version already shipped — a new 031 would never run on a company already at 140. Follow-ups go
 * after 150 (150: duplicate-index clean-up).
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
import { migration150 } from './150_indexes.ts';
import { migration160 } from './160_tds.ts';
import { migration161 } from './161_tds_advances.ts';
import { migration170 } from './170_cheques.ts';
import { migration180 } from './180_pos.ts';
import { migration190 } from './190_documents.ts';
import { migration191 } from './191_recurring.ts';
import { migration192 } from './192_order_closures.ts';
import { migration193 } from './193_budgets.ts';
import { migration200 } from './200_gstplus.ts';
import { migration210 } from './210_mfg.ts';
import { migration220 } from './220_aliases.ts';
import { migration221 } from './221_numbering_rows.ts';
import { migration222 } from './222_attachments.ts';
import { migration230 } from './230_forex.ts';
import { migration240 } from './240_final_gaps.ts';
import { migration241 } from './241_perf_indexes.ts';
import { migration250 } from './250_renumber.ts';

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
  migration150,
  migration160,
  migration161,
  migration170,
  migration180,
  migration190,
  migration191,
  migration192,
  migration193,
  migration200,
  migration210,
  migration220,
  migration221,
  migration222,
  migration230,
  migration240,
  migration241,
  migration250,
];
