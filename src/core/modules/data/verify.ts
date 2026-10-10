/**
 * 'data.verify' — integrity report of the open company's data. Read-only; every check runs on the
 * live database and reports problems as plain-English details (at most MAX_DETAILS per check).
 *
 *   integrity            PRAGMA integrity_check
 *   foreign_keys         PRAGMA foreign_key_check (rows pointing at missing masters / vouchers)
 *   voucher_balance      Σ ledger_entries.amount = 0 for every voucher
 *   voucher_children     child rows carry their voucher's date / affects_books / post-dated flag;
 *                        cancelled vouchers have no child rows; only accounting vouchers are in the books
 *   bill_allocations     bills of an entry add up to the entry, on the entry's ledger
 *   cost_allocations     cost-centre allocations add up to the entry
 *   inventory_direction  stock goes out for sales-side and in for purchase-side vouchers
 *   gst_tax_postings     gst_lines tax per head = the voucher's GST duty-ledger postings
 *                        (skipped for reverse charge, imports, non-claimable tax and ledger-mode vouchers)
 *   orphans              vouchers in the books without entries; masters under missing parents
 *   group_tree           no cycles in the group / stock group / godown / cost centre trees
 *   opening_difference   Σ ledger openings + opening stock = 0 (else "Difference in opening balances")
 *   audit_chain          the edit log's SHA-256 hash chain is unbroken
 *   duplicate_numbers    no voucher number used twice in a voucher type's numbering period
 *   attachments          every attached file is in the company's attachments folder and matches its
 *                        SHA-256 (dataplus); files no attachment uses are mentioned, not counted
 */
import { ACCOUNTING_BASE_TYPES } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { DataVerifyCheck, DataVerifyResult } from '../../../shared/types/data.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { verifyAuditChain } from '../../lib/audit.ts';
import { checkAttachmentFiles } from '../attachments/backup.ts';
import { loadVoucherType, periodKey } from '../vouchers/numbering.ts';
import { requirePermission } from './common.ts';

export const MAX_DETAILS = 50;

interface VRef {
  id: number;
  type: string;
  number: string | null;
  date: string;
}

const vlabel = (v: VRef): string => `${v.type}${v.number ? ` ${v.number}` : ''} dated ${formatDate(v.date)} (id ${v.id})`;
const rupees = (p: number): string => `₹ ${formatMoney(Math.abs(p))} ${p > 0 ? 'Dr' : p < 0 ? 'Cr' : ''}`.trim();

function check(name: string, label: string, problems: string[], total?: number): DataVerifyCheck {
  const count = total ?? problems.length;
  return { name, label, ok: count === 0, count, details: problems.slice(0, MAX_DETAILS) };
}

const VREF_COLS = `v.id AS id, vt.name AS type, v.number AS number, v.date AS date`;

function integrity(db: Db): DataVerifyCheck {
  const rows = db.all<Record<string, unknown>>('PRAGMA integrity_check(100)').map((r) => String(Object.values(r)[0]));
  const ok = rows.length === 1 && rows[0] === 'ok';
  return check('integrity', 'Database file is intact', ok ? [] : rows);
}

function foreignKeys(db: Db): DataVerifyCheck {
  const rows = db.all<{ table: string; rowid: number | null; parent: string }>('SELECT "table", rowid, parent FROM pragma_foreign_key_check');
  return check(
    'foreign_keys',
    'Every row points at an existing record',
    rows.map((r) => `${r.table} row ${r.rowid ?? '?'} refers to a missing ${r.parent} record`),
  );
}

function voucherBalance(db: Db): DataVerifyCheck {
  const rows = db.all<VRef & { total: number }>(
    `SELECT ${VREF_COLS}, SUM(le.amount) AS total
       FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
      GROUP BY v.id HAVING SUM(le.amount) <> 0 ORDER BY v.date, v.id`,
  );
  return check(
    'voucher_balance',
    'Every voucher balances (debit = credit)',
    rows.map((r) => `${vlabel(r)} is out of balance by ${rupees(r.total)}`),
  );
}

function voucherChildren(db: Db): DataVerifyCheck {
  const problems: string[] = [];
  let total = 0;
  const run = (sql: string, describe: (r: VRef & { n: number }) => string, params: Record<string, string> = {}): void => {
    const rows = db.all<VRef & { n: number }>(sql, params);
    total += rows.length;
    for (const r of rows) if (problems.length < MAX_DETAILS) problems.push(describe(r));
  };
  for (const t of ['ledger_entries', 'bill_allocations', 'cost_allocations', 'gst_lines'] as const) {
    run(
      `SELECT ${VREF_COLS}, COUNT(*) AS n FROM ${t} c JOIN vouchers v ON v.id = c.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE c.date <> v.date OR c.affects_books <> v.affects_books OR c.is_post_dated <> v.is_post_dated
        GROUP BY v.id ORDER BY v.date, v.id`,
      (r) => `${vlabel(r)}: ${r.n} ${t.replace('_', ' ')} row(s) do not match the voucher's date or status`,
    );
  }
  run(
    `SELECT ${VREF_COLS}, COUNT(*) AS n FROM inventory_entries c JOIN vouchers v ON v.id = c.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE c.date <> v.date OR c.is_post_dated <> v.is_post_dated OR (c.affects_stock = 1 AND v.affects_stock = 0)
      GROUP BY v.id ORDER BY v.date, v.id`,
    (r) => `${vlabel(r)}: ${r.n} stock line(s) do not match the voucher's date or status`,
  );
  run(
    `SELECT ${VREF_COLS}, 1 AS n FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE v.is_cancelled = 1 AND (v.affects_books = 1 OR v.affects_stock = 1
            OR EXISTS (SELECT 1 FROM ledger_entries WHERE voucher_id = v.id) OR EXISTS (SELECT 1 FROM inventory_entries WHERE voucher_id = v.id)
            OR EXISTS (SELECT 1 FROM gst_lines WHERE voucher_id = v.id))
      ORDER BY v.date, v.id`,
    (r) => `${vlabel(r)} is cancelled but still has entries in the books`,
  );
  run(
    `SELECT ${VREF_COLS}, 1 AS n FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE v.affects_books = 1 AND (v.is_optional = 1 OR v.base_type NOT IN (SELECT value FROM json_each(:bases)))
      ORDER BY v.date, v.id`,
    (r) => `${vlabel(r)} is counted in the books although it is optional or not an accounting voucher`,
    { bases: JSON.stringify(ACCOUNTING_BASE_TYPES) },
  );
  run(
    `SELECT ${VREF_COLS}, 1 AS n FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE v.base_type <> vt.base_type ORDER BY v.date, v.id`,
    (r) => `${vlabel(r)} has a different base type from its voucher type`,
  );
  return check('voucher_children', 'Voucher details agree with their vouchers', problems, total);
}

function billAllocations(db: Db): DataVerifyCheck {
  const rows = db.all<VRef & { ledger: string; amount: number; bills: number; wrong_ledger: number }>(
    `SELECT ${VREF_COLS}, l.name AS ledger, le.amount AS amount, SUM(b.amount) AS bills, SUM(b.ledger_id <> le.ledger_id) AS wrong_ledger
       FROM bill_allocations b JOIN ledger_entries le ON le.id = b.ledger_entry_id JOIN vouchers v ON v.id = b.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id JOIN ledgers l ON l.id = le.ledger_id
      GROUP BY le.id HAVING SUM(b.amount) <> le.amount OR SUM(b.ledger_id <> le.ledger_id) > 0 ORDER BY v.date, v.id`,
  );
  return check(
    'bill_allocations',
    'Bill-wise details add up to their entries',
    rows.map((r) =>
      r.wrong_ledger > 0
        ? `${vlabel(r)}: bills of ${r.ledger} are recorded against another ledger`
        : `${vlabel(r)}: bills of ${r.ledger} total ${rupees(r.bills)} but the entry is ${rupees(r.amount)}`,
    ),
  );
}

function costAllocations(db: Db): DataVerifyCheck {
  const rows = db.all<VRef & { ledger: string; amount: number; costs: number }>(
    `SELECT ${VREF_COLS}, l.name AS ledger, le.amount AS amount, SUM(c.amount) AS costs
       FROM cost_allocations c JOIN ledger_entries le ON le.id = c.ledger_entry_id JOIN vouchers v ON v.id = c.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id JOIN ledgers l ON l.id = le.ledger_id
      GROUP BY le.id HAVING SUM(c.amount) <> le.amount ORDER BY v.date, v.id`,
  );
  return check(
    'cost_allocations',
    'Cost-centre allocations add up to their entries',
    rows.map((r) => `${vlabel(r)}: cost centres of ${r.ledger} total ${rupees(r.costs)} but the entry is ${rupees(r.amount)}`),
  );
}

const OUT_TYPES = ['sales', 'debit_note', 'delivery_note', 'rejection_out', 'sales_order'];
const IN_TYPES = ['purchase', 'credit_note', 'receipt_note', 'rejection_in', 'purchase_order'];

function inventoryDirection(db: Db): DataVerifyCheck {
  const rows = db.all<VRef & { item: string; qty: number }>(
    `SELECT ${VREF_COLS}, i.name AS item, ie.qty AS qty
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN stock_items i ON i.id = ie.item_id
      WHERE (v.base_type IN (SELECT value FROM json_each(:out)) AND ie.qty > 0)
         OR (v.base_type IN (SELECT value FROM json_each(:inw)) AND ie.qty < 0)
         OR (v.base_type = 'stock_journal' AND ((ie.is_consumption = 1 AND ie.qty > 0) OR (ie.is_consumption = 0 AND ie.qty < 0)))
      ORDER BY v.date, v.id`,
    { out: JSON.stringify(OUT_TYPES), inw: JSON.stringify(IN_TYPES) },
  );
  return check(
    'inventory_direction',
    'Stock moves in the right direction',
    rows.map((r) => `${vlabel(r)}: ${r.item} goes ${r.qty > 0 ? 'in' : 'out'}, which is wrong for this voucher type`),
  );
}

function gstPostings(db: Db): DataVerifyCheck {
  const rows = db.all<VRef & { gi: number; gc: number; gs: number; ge: number; pi: number; pc: number; ps: number; pe: number }>(
    `WITH g AS (
        -- Goods from an SEZ unit are imports: their IGST is paid at customs (bill of entry), never posted
        -- from the supplier's invoice (the services on such an invoice are).
        SELECT gl.voucher_id, SUM(gl.igst) AS gi, SUM(gl.cgst) AS gc, SUM(gl.sgst) AS gs, SUM(gl.cess) AS ge
          FROM gst_lines gl JOIN vouchers gv ON gv.id = gl.voucher_id
         WHERE NOT (COALESCE(gv.gst_nature, '') = 'inward_sez' AND gl.supply_type = 'goods')
         GROUP BY gl.voucher_id),
      p AS (
        SELECT voucher_id,
               ABS(SUM(CASE WHEN gst_duty_head = 'IGST' THEN amount ELSE 0 END)) AS pi,
               ABS(SUM(CASE WHEN gst_duty_head = 'CGST' THEN amount ELSE 0 END)) AS pc,
               ABS(SUM(CASE WHEN gst_duty_head = 'SGST' THEN amount ELSE 0 END)) AS ps,
               ABS(SUM(CASE WHEN gst_duty_head = 'CESS' THEN amount ELSE 0 END)) AS pe
          FROM ledger_entries WHERE role = 'tax' GROUP BY voucher_id)
     SELECT ${VREF_COLS}, g.gi, g.gc, g.gs, g.ge, COALESCE(p.pi, 0) AS pi, COALESCE(p.pc, 0) AS pc, COALESCE(p.ps, 0) AS ps, COALESCE(p.pe, 0) AS pe
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN g ON g.voucher_id = v.id LEFT JOIN p ON p.voucher_id = v.id
      WHERE v.affects_books = 1 AND v.is_reverse_charge = 0
        AND COALESCE(v.gst_nature, '') NOT IN ('import_goods', 'import_services', 'export_lut', 'sez_lut', 'inward_rcm')
        AND NOT EXISTS (SELECT 1 FROM gst_lines x WHERE x.voucher_id = v.id AND (x.is_reverse_charge = 1 OR x.itc_eligibility = 'ineligible'))
        AND (g.gi <> COALESCE(p.pi, 0) OR g.gc <> COALESCE(p.pc, 0) OR g.gs <> COALESCE(p.ps, 0) OR g.ge <> COALESCE(p.pe, 0))
      ORDER BY v.date, v.id`,
  );
  const problems: string[] = [];
  for (const r of rows) {
    for (const [head, lines, posted] of [
      ['IGST', r.gi, r.pi],
      ['CGST', r.gc, r.pc],
      ['SGST', r.gs, r.ps],
      ['Cess', r.ge, r.pe],
    ] as const) {
      if (lines !== posted) problems.push(`${vlabel(r)}: ${head} in the GST details is ₹ ${formatMoney(lines)} but ₹ ${formatMoney(posted)} is posted to ${head} ledgers`);
    }
  }
  return check('gst_tax_postings', 'GST details agree with the tax ledgers', problems, rows.length);
}

function orphans(db: Db): DataVerifyCheck {
  const problems: string[] = [];
  let total = 0;
  const add = (list: string[]): void => {
    total += list.length;
    for (const p of list) if (problems.length < MAX_DETAILS) problems.push(p);
  };
  add(
    db
      .all<VRef>(
        `SELECT ${VREF_COLS} FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
          WHERE v.affects_books = 1 AND v.total_amount <> 0 AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE voucher_id = v.id)
          ORDER BY v.date, v.id`,
      )
      .map((r) => `${vlabel(r)} is in the books but has no ledger entries`),
  );
  add(db.all<{ name: string }>('SELECT l.name FROM ledgers l LEFT JOIN groups g ON g.id = l.group_id WHERE g.id IS NULL').map((r) => `Ledger ${r.name} is under a group that no longer exists`));
  add(db.all<{ name: string }>('SELECT c.name FROM groups c LEFT JOIN groups p ON p.id = c.parent_id WHERE c.parent_id IS NOT NULL AND p.id IS NULL').map((r) => `Group ${r.name} is under a group that no longer exists`));
  add(db.all<{ name: string }>('SELECT i.name FROM stock_items i LEFT JOIN units u ON u.id = i.unit_id WHERE u.id IS NULL').map((r) => `Stock item ${r.name} has a unit that no longer exists`));
  add(
    db
      .all<{ t: string; n: number }>(
        `SELECT 'ledger entries' AS t, COUNT(*) AS n FROM ledger_entries c LEFT JOIN vouchers v ON v.id = c.voucher_id WHERE v.id IS NULL
         UNION ALL SELECT 'stock lines', COUNT(*) FROM inventory_entries c LEFT JOIN vouchers v ON v.id = c.voucher_id WHERE v.id IS NULL
         UNION ALL SELECT 'bill allocations', COUNT(*) FROM bill_allocations c LEFT JOIN ledger_entries e ON e.id = c.ledger_entry_id WHERE e.id IS NULL
         UNION ALL SELECT 'GST details', COUNT(*) FROM gst_lines c LEFT JOIN vouchers v ON v.id = c.voucher_id WHERE v.id IS NULL
         UNION ALL SELECT 'opening bills', COUNT(*) FROM opening_bills c LEFT JOIN ledgers l ON l.id = c.ledger_id WHERE l.id IS NULL
         UNION ALL SELECT 'opening stock rows', COUNT(*) FROM stock_openings c LEFT JOIN stock_items i ON i.id = c.item_id WHERE i.id IS NULL`,
      )
      .filter((r) => r.n > 0)
      .map((r) => `${r.n} ${r.t} belong to nothing (their voucher or master was removed)`),
  );
  return check('orphans', 'No orphaned records', problems, total);
}

function groupTree(db: Db): DataVerifyCheck {
  const problems: string[] = [];
  for (const [table, what] of [
    ['groups', 'Group'],
    ['stock_groups', 'Stock group'],
    ['godowns', 'Godown'],
    ['cost_centres', 'Cost centre'],
    ['stock_categories', 'Stock category'],
  ] as const) {
    const rows = db.all<{ id: number; parent_id: number | null; name: string }>(`SELECT id, parent_id, name FROM ${table}`);
    const parent = new Map(rows.map((r) => [r.id, r.parent_id]));
    for (const r of rows) {
      const seen = new Set<number>([r.id]);
      let p = r.parent_id;
      for (let i = 0; p !== null && p !== undefined && i < 1000; i++) {
        if (seen.has(p)) {
          problems.push(`${what} ${r.name} is inside itself (a loop in the tree)`);
          break;
        }
        seen.add(p);
        p = parent.get(p) ?? null;
      }
    }
  }
  return check('group_tree', 'Group trees have no loops', problems);
}

function openingDifference(db: Db): DataVerifyCheck {
  const ledgers = db.value<number>('SELECT COALESCE(SUM(opening_balance), 0) FROM ledgers') ?? 0;
  const stock = db.value<number>('SELECT COALESCE(SUM(value), 0) FROM stock_openings') ?? 0;
  const diff = ledgers + stock;
  const bills = db.all<{ name: string; opening: number; bills: number }>(
    `SELECT l.name, l.opening_balance AS opening, SUM(b.amount) AS bills FROM opening_bills b JOIN ledgers l ON l.id = b.ledger_id
      GROUP BY l.id HAVING SUM(b.amount) <> l.opening_balance`,
  );
  const problems = [
    ...(diff !== 0 ? [`Opening balances (with opening stock) differ by ${rupees(diff)} — shown as "Difference in opening balances"`] : []),
    ...bills.map((b) => `Opening bills of ${b.name} total ${rupees(b.bills)} but its opening balance is ${rupees(b.opening)}`),
  ];
  return check('opening_difference', 'Opening balances agree', problems);
}

function auditChain(db: Db): DataVerifyCheck {
  const r = verifyAuditChain(db);
  if (r.ok) return check('audit_chain', `Edit log is intact (${r.count.toLocaleString('en-IN')} entries)`, []);
  return check('audit_chain', 'Edit log is intact', [
    `Entry ${r.brokenAtId} of the edit log has been changed or removed (${r.reason === 'hash_mismatch' ? 'its contents do not match its seal' : 'the chain is broken before it'}). ${r.count.toLocaleString('en-IN')} earlier entries are intact.`,
  ]);
}

function duplicateNumbers(db: Db): DataVerifyCheck {
  const fy = db.value<number>('SELECT fy_start_month FROM company WHERE id = 1') ?? 4;
  const rows = db.all<VRef & { tid: number }>(
    `SELECT ${VREF_COLS}, v.voucher_type_id AS tid FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE v.number IS NOT NULL AND v.number <> ''
        AND EXISTS (SELECT 1 FROM vouchers w WHERE w.voucher_type_id = v.voucher_type_id AND w.number = v.number AND w.id <> v.id)
      ORDER BY v.voucher_type_id, v.number, v.date, v.id`,
  );
  const types = new Map<number, ReturnType<typeof loadVoucherType>>();
  const groups = new Map<string, VRef[]>();
  for (const r of rows) {
    let vt = types.get(r.tid);
    if (!vt) {
      vt = loadVoucherType(db, r.tid);
      types.set(r.tid, vt);
    }
    // A voucher type that allows repeated numbers ("Prevent duplicates" off) is not a problem.
    if (!vt.preventDuplicates) continue;
    const k = `${r.tid}|${r.number}|${periodKey(vt, r.date, fy)}`;
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }
  const problems: string[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    problems.push(`${list[0].type} number ${list[0].number} is used ${list.length} times: ${list.map((r) => `${formatDate(r.date)} (id ${r.id})`).join(', ')}`);
  }
  return check('duplicate_numbers', 'Voucher numbers are unique in each series (where duplicates are prevented)', problems);
}

/** Run every check. Read-only; safe on a live company. */
function attachmentFiles(ctx: CompanyCtx): DataVerifyCheck {
  const { problems, unused } = checkAttachmentFiles(ctx.db, ctx.company.dir);
  const c = check('attachments', 'Attached files are present and unchanged', problems);
  if (unused > 0) c.details.push(`(${unused} stored file(s) in the attachments folder are not attached to anything — e.g. copied there by hand or left by an interrupted attach; they are not in backups and can be deleted.)`);
  return c;
}

export function verifyData(ctx: CompanyCtx): DataVerifyResult {
  requirePermission(ctx, 'data.backup');
  const db = ctx.db;
  const checks = [
    integrity(db),
    foreignKeys(db),
    voucherBalance(db),
    voucherChildren(db),
    billAllocations(db),
    costAllocations(db),
    inventoryDirection(db),
    gstPostings(db),
    orphans(db),
    groupTree(db),
    openingDifference(db),
    auditChain(db),
    duplicateNumbers(db),
    attachmentFiles(ctx),
  ];
  return { ok: checks.every((c) => c.ok), checkedAt: ctx.clock.now().toISOString(), checks };
}
