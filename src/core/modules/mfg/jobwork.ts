/**
 * Job work reports: goods with job workers (principal) / principals' goods with us (job worker), the
 * s.143 return deadlines, and ITC-04.
 *
 * Source of truth: stock movements in third-party godowns. Every inward line into a godown of the
 * kind is a lot (a challan line: Material Out, or a purchase delivered straight to the job worker);
 * every outward line from it (Material In consumption / return, a transfer to another job worker, a
 * sale from the job worker's premises) is matched to the oldest lots of the same godown and item
 * (FIFO). What is left of a lot is still with the job worker; its due date follows the goods type
 * (shared/mfg/jobwork.ts). Opening stock in such a godown has no challan date: it is consumed first
 * and listed as "unexplained" while any of it remains.
 */
import { formatDate } from '../../../shared/dates.ts';
import { JOB_WORK_GOODS_TYPES, itc04Periods, returnDueDate, returnStatus, type JobWorkGoodsType } from '../../../shared/mfg/jobwork.ts';
import { roundPaise } from '../../../shared/money.ts';
import type {
  Itc04Input,
  Itc04Result,
  Itc04ReturnRow,
  Itc04SentRow,
  JobWorkAlerts,
  JobWorkDirection,
  PendingJobWorkInput,
  PendingJobWorkResult,
  PendingJobWorkRow,
} from '../../../shared/types/mfg.ts';
import type { Db } from '../../db/db.ts';
import { rule } from '../../lib/errors.ts';
import { resolveItemGstProfile } from '../inventory/gst.ts';
import { roundQty, STOCK_MOVEMENT_FILTER } from '../inventory/stock.ts';

const EPS = 1e-9;

interface MoveRow {
  id: number;
  voucher_id: number;
  line_no: number;
  item_id: number;
  godown_id: number;
  qty: number;
  amount: number;
  date: string;
  number: string | null;
  base_type: string;
  party_ledger_id: number | null;
  cls: string | null;
  order_id: number | null;
  process: string | null;
  role: string | null;
  goods_type: JobWorkGoodsType | null;
  challan_value: number | null;
  extended_to: string | null;
  source_kind: string | null;
  dest_kind: string | null;
  product_item_id: number | null;
  product_qty: number | null;
}

export interface Lot {
  key: string;
  ieId: number | null;
  voucherId: number | null;
  lineNo: number;
  date: string;
  number: string | null;
  godownId: number;
  itemId: number;
  partyLedgerId: number | null;
  orderId: number | null;
  goodsType: JobWorkGoodsType;
  qty: number;
  remaining: number;
  value: number;
  extendedTo: string | null;
  /** Received from another job worker (ITC-04: reported in 5B by the sending side, not in table 4). */
  fromThirdParty: boolean;
  baseType: string;
  isOpening: boolean;
}

export interface OutEvent {
  ieId: number;
  voucherId: number;
  lineNo: number;
  date: string;
  number: string | null;
  godownId: number;
  itemId: number;
  qty: number;
  baseType: string;
  cls: string | null;
  role: string | null;
  process: string | null;
  partyLedgerId: number | null;
  /** The movement goes on to another job worker's godown. */
  toThirdParty: boolean;
  productItemId: number | null;
  productQty: number | null;
  matches: Array<{ lot: Lot; qty: number }>;
}

const KIND_OF: Readonly<Record<JobWorkDirection, string>> = { out: 'ours_with_party', in: 'party_with_us' };

const MOVES_SQL = /* sql */ `
  SELECT ie.id, ie.voucher_id, ie.line_no, ie.item_id, ie.godown_id, ie.qty, ie.amount, ie.date,
         v.number, v.base_type, v.party_ledger_id,
         d.class AS cls, d.job_work_order_id AS order_id, d.process, d.item_id AS product_item_id, d.qty AS product_qty,
         l.role, l.goods_type, l.challan_value, l.extended_to,
         sg.third_party_kind AS source_kind, dg.third_party_kind AS dest_kind
    FROM inventory_entries ie
    JOIN vouchers v ON v.id = ie.voucher_id
    LEFT JOIN stock_journal_details d ON d.voucher_id = ie.voucher_id
    LEFT JOIN stock_journal_lines l ON l.voucher_id = ie.voucher_id AND l.line_no = ie.line_no
    LEFT JOIN inventory_entries se ON se.voucher_id = ie.voucher_id AND se.line_no = l.source_line_no
    LEFT JOIN godowns sg ON sg.id = se.godown_id
    LEFT JOIN stock_journal_lines dl ON dl.voucher_id = ie.voucher_id AND dl.source_line_no = ie.line_no
    LEFT JOIN inventory_entries de ON de.voucher_id = ie.voucher_id AND de.line_no = dl.line_no
    LEFT JOIN godowns dg ON dg.id = de.godown_id
   WHERE ie.godown_id IN (SELECT id FROM godowns WHERE third_party_kind = :kind)
     AND ie.date <= :asOf AND ${STOCK_MOVEMENT_FILTER}
   ORDER BY ie.date, ie.voucher_id, ie.line_no`;

/** FIFO of the movements in third-party godowns of one kind, up to `asOf`. */
export function jobWorkFifo(db: Db, today: string, asOf: string, direction: JobWorkDirection): { lots: Lot[]; outs: OutEvent[] } {
  const kind = KIND_OF[direction];
  const godownParty = new Map(
    db
      .all<{ id: number; party_ledger_id: number | null }>('SELECT id, party_ledger_id FROM godowns WHERE third_party_kind = :kind', { kind })
      .map((g) => [g.id, g.party_ledger_id]),
  );
  const booksFrom = db.value<string>('SELECT books_from FROM company WHERE id = 1') ?? asOf;
  const queues = new Map<string, Lot[]>();
  const lots: Lot[] = [];
  const outs: OutEvent[] = [];
  const queue = (g: number, i: number): Lot[] => {
    const k = `${g}|${i}`;
    let q = queues.get(k);
    if (!q) {
      q = [];
      queues.set(k, q);
    }
    return q;
  };
  for (const o of db.all<{ id: number; item_id: number; godown_id: number; qty: number; value: number }>(
    `SELECT id, item_id, godown_id, qty, value FROM stock_openings WHERE godown_id IN (SELECT id FROM godowns WHERE third_party_kind = :kind) ORDER BY id`,
    { kind },
  )) {
    if (!(o.qty > EPS)) continue;
    const lot: Lot = {
      key: `o:${o.id}`,
      ieId: null,
      voucherId: null,
      lineNo: 0,
      date: booksFrom,
      number: null,
      godownId: o.godown_id,
      itemId: o.item_id,
      partyLedgerId: godownParty.get(o.godown_id) ?? null,
      orderId: null,
      goodsType: 'inputs',
      qty: o.qty,
      remaining: o.qty,
      value: Number(o.value),
      extendedTo: null,
      fromThirdParty: false,
      baseType: 'opening',
      isOpening: true,
    };
    lots.push(lot);
    queue(o.godown_id, o.item_id).push(lot);
  }
  for (const m of db.all<MoveRow>(MOVES_SQL, { kind, asOf, today })) {
    if (m.qty > EPS) {
      const lot: Lot = {
        key: `m:${m.id}`,
        ieId: m.id,
        voucherId: m.voucher_id,
        lineNo: m.line_no,
        date: m.date,
        number: m.number,
        godownId: m.godown_id,
        itemId: m.item_id,
        partyLedgerId: m.party_ledger_id ?? godownParty.get(m.godown_id) ?? null,
        orderId: m.order_id,
        goodsType: m.goods_type && (JOB_WORK_GOODS_TYPES as readonly string[]).includes(m.goods_type) ? m.goods_type : 'inputs',
        qty: m.qty,
        remaining: m.qty,
        value: m.challan_value ?? Math.abs(Number(m.amount)),
        extendedTo: m.extended_to,
        fromThirdParty: m.source_kind === 'ours_with_party' || m.source_kind === 'party_with_us',
        baseType: m.base_type,
        isOpening: false,
      };
      lots.push(lot);
      queue(m.godown_id, m.item_id).push(lot);
    } else if (m.qty < -EPS) {
      const ev: OutEvent = {
        ieId: m.id,
        voucherId: m.voucher_id,
        lineNo: m.line_no,
        date: m.date,
        number: m.number,
        godownId: m.godown_id,
        itemId: m.item_id,
        qty: -m.qty,
        baseType: m.base_type,
        cls: m.cls,
        role: m.role,
        process: m.process,
        partyLedgerId: m.party_ledger_id ?? godownParty.get(m.godown_id) ?? null,
        toThirdParty: m.dest_kind === 'ours_with_party' || m.dest_kind === 'party_with_us',
        productItemId: m.product_item_id,
        productQty: m.product_qty,
        matches: [],
      };
      let need = ev.qty;
      for (const lot of queue(m.godown_id, m.item_id)) {
        if (need <= EPS) break;
        if (lot.remaining <= EPS) continue;
        const take = Math.min(need, lot.remaining);
        lot.remaining = roundQty(lot.remaining - take);
        need = roundQty(need - take);
        ev.matches.push({ lot, qty: take });
      }
      outs.push(ev);
    }
  }
  return { lots, outs };
}

interface NameRow {
  id: number;
  name: string;
  unit?: string;
  uqc?: string | null;
  gstin?: string | null;
  state_code?: string | null;
}

function names(db: Db, sql: string): Map<number, NameRow> {
  return new Map(db.all<NameRow>(sql).map((r) => [r.id, r]));
}

// ───────────────────────────── Pending job work ─────────────────────────────

export function pendingJobWork(db: Db, today: string, input: PendingJobWorkInput): PendingJobWorkResult {
  const direction = input.direction ?? 'out';
  const { lots } = jobWorkFifo(db, today, input.asOf, direction);
  const items = names(db, 'SELECT i.id, i.name, u.symbol AS unit FROM stock_items i JOIN units u ON u.id = i.unit_id');
  const godowns = names(db, 'SELECT id, name FROM godowns');
  const parties = names(db, 'SELECT id, name FROM ledgers');
  const orders = names(db, 'SELECT id, number AS name FROM job_work_orders');
  const rows: PendingJobWorkRow[] = [];
  const unexplained: PendingJobWorkResult['unexplained'] = [];
  const warnDays = input.warnDays ?? 30;
  for (const lot of lots) {
    if (lot.remaining <= EPS) continue;
    if (input.partyLedgerId !== undefined && lot.partyLedgerId !== input.partyLedgerId) continue;
    const item = items.get(lot.itemId);
    if (lot.isOpening) {
      unexplained.push({ godownId: lot.godownId, godownName: godowns.get(lot.godownId)?.name ?? '', itemId: lot.itemId, itemName: item?.name ?? '', unit: item?.unit ?? '', qty: roundQty(lot.remaining) });
      continue;
    }
    const due = returnDueDate(lot.goodsType, lot.date, lot.extendedTo);
    const st = returnStatus(due, input.asOf, warnDays);
    if (input.onlyAlerts && st.status !== 'overdue' && st.status !== 'due_soon') continue;
    rows.push({
      key: lot.key,
      direction,
      voucherId: lot.voucherId as number,
      lineNo: lot.lineNo,
      challanNo: lot.number,
      sentOn: lot.date,
      partyLedgerId: lot.partyLedgerId,
      partyName: lot.partyLedgerId !== null ? (parties.get(lot.partyLedgerId)?.name ?? null) : null,
      godownId: lot.godownId,
      godownName: godowns.get(lot.godownId)?.name ?? '',
      itemId: lot.itemId,
      itemName: item?.name ?? '',
      unit: item?.unit ?? '',
      goodsType: lot.goodsType,
      sentQty: roundQty(lot.qty),
      returnedQty: roundQty(lot.qty - lot.remaining),
      pendingQty: roundQty(lot.remaining),
      pendingValue: lot.qty > EPS ? roundPaise((lot.value * lot.remaining) / lot.qty) : 0,
      dueDate: due,
      daysLeft: st.daysLeft,
      status: st.status,
      ageDays: Math.max(0, Math.round((Date.parse(input.asOf) - Date.parse(lot.date)) / 86_400_000)),
      orderNo: lot.orderId !== null ? (orders.get(lot.orderId)?.name ?? null) : null,
    });
  }
  rows.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.sentOn.localeCompare(b.sentOn) || a.key.localeCompare(b.key));
  const overdue = rows.filter((r) => r.status === 'overdue');
  return {
    asOf: input.asOf,
    rows,
    unexplained,
    counts: { overdue: overdue.length, dueSoon: rows.filter((r) => r.status === 'due_soon').length, total: rows.length },
    overdueValue: overdue.reduce((s, r) => s + r.pendingValue, 0),
  };
}

/** s.143 alerts (goods with job workers past / near their return date) for banners and the Gateway. */
export function jobWorkAlerts(db: Db, today: string, asOf: string, warnDays = 30): JobWorkAlerts {
  const res = pendingJobWork(db, today, { asOf, direction: 'out', warnDays });
  const next = res.rows.find((r) => r.status === 'due_soon' || r.status === 'ok')?.dueDate ?? null;
  return { asOf, overdue: res.counts.overdue, dueSoon: res.counts.dueSoon, overdueValue: res.overdueValue, nextDue: next };
}

// ───────────────────────────── ITC-04 ─────────────────────────────

/**
 * ITC-04 of the principal for [from, to]: table 4 (inputs / capital goods sent to job workers) and
 * tables 5A (received back), 5B (sent on to another job worker) and 5C (supplied from the job worker's
 * premises), with the original challans found by FIFO. A clean CSV layout of the form's columns — not
 * the GST portal's JSON schema (see the README).
 */
export function itc04(db: Db, today: string, input: Itc04Input): Itc04Result {
  if (input.from > input.to) throw rule('The period starts after it ends. Choose the ITC-04 period again.');
  const { lots, outs } = jobWorkFifo(db, today, input.to, 'out');
  const company = db.get<{ state_code: string | null }>('SELECT state_code FROM company WHERE id = 1');
  const items = names(db, 'SELECT i.id, i.name, u.symbol AS unit, u.uqc FROM stock_items i JOIN units u ON u.id = i.unit_id');
  const parties = names(db, 'SELECT id, name, gstin, state_code FROM ledgers');
  const warnings: string[] = [];
  const party = (id: number | null): { gstin: string | null; state: string | null; name: string | null } => {
    const p = id !== null ? parties.get(id) : undefined;
    return { gstin: p?.gstin ?? null, state: p?.state_code ?? (p?.gstin ? p.gstin.slice(0, 2) : null), name: p?.name ?? null };
  };
  const uqcOf = (itemId: number): string => {
    const it = items.get(itemId);
    return (it?.uqc || it?.unit || 'OTH').toUpperCase();
  };

  const sent: Itc04SentRow[] = [];
  for (const lot of lots) {
    if (lot.isOpening || lot.date < input.from || lot.date > input.to || lot.fromThirdParty) continue;
    const p = party(lot.partyLedgerId);
    if (!p.gstin) warnings.push(`Challan ${lot.number ?? '(no number)'} of ${formatDate(lot.date)}: the job worker ${p.name ?? ''} has no GSTIN — ITC-04 reports unregistered job workers by state.`);
    const profile = resolveItemGstProfile(db, lot.itemId, lot.date);
    const rate = profile && profile.taxability === 'taxable' ? profile.rate : 0;
    const inter = p.state !== null && company?.state_code !== null && p.state !== company?.state_code;
    sent.push({
      jobWorkerGstin: p.gstin,
      jobWorkerState: p.state,
      jobWorkerName: p.name,
      challanNo: lot.number,
      challanDate: lot.date,
      goodsType: lot.goodsType,
      description: items.get(lot.itemId)?.name ?? '',
      hsn: profile?.hsnSac ?? null,
      uqc: uqcOf(lot.itemId),
      qty: roundQty(lot.qty),
      taxableValue: lot.value,
      igstRate: inter ? rate : 0,
      cgstRate: inter ? 0 : rate / 2,
      sgstRate: inter ? 0 : rate / 2,
      cessRate: profile?.cessRate ?? 0,
      voucherId: lot.voucherId as number,
    });
  }

  const returned: Itc04ReturnRow[] = [];
  for (const ev of outs) {
    if (ev.date < input.from || ev.date > input.to) continue;
    let table: Itc04ReturnRow['table'] | null;
    if (ev.baseType === 'sales' || ev.baseType === 'delivery_note') table = '5C';
    else if (ev.baseType === 'stock_journal') table = ev.toThirdParty ? '5B' : '5A';
    else table = null;
    if (table === null) {
      warnings.push(`${ev.number ?? 'A voucher'} of ${formatDate(ev.date)} reduces stock at a job worker but is not a Material In, a transfer or a sale; it is left out of ITC-04.`);
      continue;
    }
    const p = party(ev.partyLedgerId);
    const product = table === '5A' && ev.role === 'component' && ev.productItemId !== null ? ev.productItemId : null;
    const segments = ev.matches.length > 0 ? ev.matches : [{ lot: null, qty: ev.qty }];
    for (const seg of segments) {
      const orig = seg.lot && !seg.lot.isOpening ? seg.lot : null;
      returned.push({
        table,
        jobWorkerGstin: p.gstin,
        jobWorkerState: p.state,
        jobWorkerName: p.name,
        docNo: ev.number,
        docDate: ev.date,
        originalChallanNo: orig?.number ?? null,
        originalChallanDate: orig?.date ?? null,
        description: items.get(ev.itemId)?.name ?? '',
        uqc: uqcOf(ev.itemId),
        qty: roundQty(seg.qty),
        receivedDescription: product !== null ? (items.get(product)?.name ?? null) : null,
        receivedUqc: product !== null ? uqcOf(product) : null,
        receivedQty: product !== null && ev.productQty !== null && ev.qty > EPS ? roundQty((ev.productQty * seg.qty) / ev.qty) : null,
        lossesQty: 0,
        natureOfJobWork: ev.process,
        voucherId: ev.voucherId,
      });
    }
    const unmatched = roundQty(ev.qty - ev.matches.reduce((s, m) => s + m.qty, 0));
    if (unmatched > EPS && ev.matches.length > 0) {
      warnings.push(`${ev.number ?? 'A voucher'} of ${formatDate(ev.date)} takes back more than was sent to the job worker; check the challans.`);
    }
  }
  const period = itc04Periods(input.from, input.aatoAbove5Cr === true).find((p) => p.from === input.from && p.to === input.to) ?? null;
  return { from: input.from, to: input.to, frequency: period?.frequency ?? null, dueDate: period?.dueDate ?? null, sent, returned, warnings };
}
