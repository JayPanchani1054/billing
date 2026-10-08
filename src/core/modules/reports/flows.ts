/**
 * Cash Flow and Funds Flow (README §13–§14).
 */
import type { Paise } from '../../../shared/money.ts';
import type { CashFlowGroupRow, CashFlowMonth, CashFlowResult, FundsFlowLine, FundsFlowResult, WorkingCapitalRow } from '../../../shared/types/reports.ts';
import { BOOKS_FILTER } from '../accounts/books.ts';
import { assertPeriod, buildSnapshot, ledgersByGroup, monthSlices, stockAt, stockAtEnd, type ReportEnv, type Snapshot } from './engine.ts';
import { neg } from './financials.ts';

/**
 * Group a counter ledger is reported under in the cash-flow breakup: its primary group, or the
 * first sub-group below it (Sundry Debtors rather than Current Assets, Duties & Taxes rather than
 * Current Liabilities).
 */
export function reportingGroup(env: ReportEnv, groupId: number): number | undefined {
  const g = env.tree.byId.get(groupId);
  if (!g) return undefined;
  return g.chainIds[Math.min(1, g.chainIds.length - 1)];
}

/** Ledgers under Cash-in-Hand, Bank Accounts and Bank OD A/c. */
export function cashBankLedgerIds(env: ReportEnv): number[] {
  const out: number[] = [];
  for (const l of env.ledgers) if (env.tree.byId.get(l.groupId)?.cls.isCashOrBank) out.push(l.id);
  return out;
}

/**
 * Cash flow of [from, to]: per voucher, the net effect on cash & bank ledgers (transfers between
 * them cancel out); positive = inflow, negative = outflow, by month. The group-wise breakup gives
 * each counter entry's effect (−amount) to the reporting group of its ledger; Σ group net = Σ net.
 */
export function cashFlow(env: ReportEnv, input: { from: string; to: string }): CashFlowResult {
  assertPeriod(input.from, input.to);
  const snap = buildSnapshot(env, { from: input.from, to: input.to });
  const cash = cashBankLedgerIds(env);
  const cashSet = new Set(cash);
  let opening = 0;
  let closing = 0;
  for (const id of cash) {
    const b = snap.ledgers.get(id);
    opening += b?.opening ?? 0;
    closing += b?.closing ?? 0;
  }
  const months = new Map<string, { inflow: number; outflow: number }>();
  const groups = new Map<number, { inflow: number; outflow: number }>();
  if (cash.length > 0) {
    const rows = env.db.all<{ voucher_id: number; date: string; ledger_id: number; amount: number }>(
      `SELECT le.voucher_id, le.date, le.ledger_id, SUM(le.amount) AS amount
         FROM ledger_entries le
        WHERE le.voucher_id IN (SELECT DISTINCT voucher_id FROM ledger_entries
                                 WHERE ledger_id IN (SELECT value FROM json_each(:ids))
                                   AND date >= :from AND date <= :to AND ${BOOKS_FILTER()})
          AND ${BOOKS_FILTER('le')}
        GROUP BY le.voucher_id, le.ledger_id
        ORDER BY le.voucher_id`,
      { ids: JSON.stringify(cash), from: snap.from, to: snap.to, today: env.today },
    );
    let i = 0;
    while (i < rows.length) {
      const vid = rows[i].voucher_id;
      const month = rows[i].date.slice(0, 7);
      let c = 0;
      const counter: Array<{ ledgerId: number; amount: number }> = [];
      for (; i < rows.length && rows[i].voucher_id === vid; i++) {
        if (cashSet.has(rows[i].ledger_id)) c += rows[i].amount;
        else counter.push({ ledgerId: rows[i].ledger_id, amount: rows[i].amount });
      }
      if (c === 0) continue;
      const m = months.get(month) ?? { inflow: 0, outflow: 0 };
      if (c > 0) m.inflow += c;
      else m.outflow -= c;
      months.set(month, m);
      for (const e of counter) {
        const l = env.ledgerById.get(e.ledgerId);
        const pid = l ? reportingGroup(env, l.groupId) : undefined;
        if (pid === undefined) continue;
        const g = groups.get(pid) ?? { inflow: 0, outflow: 0 };
        const effect = -e.amount;
        if (effect > 0) g.inflow += effect;
        else g.outflow -= effect;
        groups.set(pid, g);
      }
    }
  }
  const totals = { inflow: 0, outflow: 0, net: 0 };
  const monthRows: CashFlowMonth[] = monthSlices(snap.from, snap.to).map((s) => {
    const m = months.get(s.month) ?? { inflow: 0, outflow: 0 };
    totals.inflow += m.inflow;
    totals.outflow += m.outflow;
    return { month: s.month, from: s.from, to: s.to, inflow: m.inflow, outflow: m.outflow, net: m.inflow - m.outflow };
  });
  totals.net = totals.inflow - totals.outflow;
  const groupRows: CashFlowGroupRow[] = [];
  for (const id of env.tree.order) {
    const g = groups.get(id);
    if (!g) continue;
    groupRows.push({ groupId: id, groupName: env.tree.byId.get(id)?.name ?? '', inflow: g.inflow, outflow: g.outflow, net: g.inflow - g.outflow });
  }
  return { from: snap.from, to: snap.to, opening, closing, months: monthRows, groups: groupRows, totals };
}

/** Σ (opening, closing) Dr-signed of every ledger under a group, P&L A/c ledger excluded. */
function groupOpenClose(env: ReportEnv, snap: Snapshot, groupId: number): [Paise, Paise] {
  let o = 0;
  let c = 0;
  for (const l of env.ledgers) {
    if (l.id === env.plLedgerId) continue;
    const g = env.tree.byId.get(l.groupId);
    if (!g || !g.chainIds.includes(groupId)) continue;
    const b = snap.ledgers.get(l.id);
    o += b?.opening ?? 0;
    c += b?.closing ?? 0;
  }
  return [o, c];
}

/**
 * Funds flow of [from, to]: changes in every non-current primary group between the start of `from`
 * and the end of `to` (liability up / asset down = source; the reverse = application), the net
 * profit (source) or loss (application), and the resulting change in working capital
 * (Current Assets incl. closing stock − Current Liabilities).
 */
export function fundsFlow(env: ReportEnv, input: { from: string; to: string }): FundsFlowResult {
  assertPeriod(input.from, input.to);
  const snap = buildSnapshot(env, { from: input.from, to: input.to });
  const caId = env.groupByCode.get('CURRENT_ASSETS');
  const clId = env.groupByCode.get('CURRENT_LIABILITIES');
  const sources: FundsFlowLine[] = [];
  const applications: FundsFlowLine[] = [];
  const put = (key: string, label: string, groupId: number | null, change: Paise): void => {
    if (change > 0) sources.push({ key, label, groupId, amount: change });
    else if (change < 0) applications.push({ key, label, groupId, amount: -change });
  };
  const stockGroupId = env.groupByCode.get('STOCK_IN_HAND');
  const openStock = stockAt(env, snap.from);
  const closeStock = stockAtEnd(env, snap.to);
  // Profit earned by the period's transactions: −Σ nominal movements + stock movement. This equals the
  // P&L net profit except in the first period of a company that started its books mid-year, whose
  // income/expense opening balances are earlier results already sitting in the opening position (they
  // brought no funds in this period, so counting them would leave a difference).
  let nominal = 0;
  for (const l of env.ledgers) {
    if (!l.isNominal) continue;
    const b = snap.ledgers.get(l.id);
    if (b) nominal += b.debit - b.credit;
  }
  const np = 0 - nominal + closeStock - openStock;
  put('np', np >= 0 ? 'Net Profit' : 'Net Loss', null, np);
  for (const id of env.tree.rootIds) {
    if (id === caId || id === clId) continue;
    const g = env.tree.byId.get(id);
    if (!g || (g.nature !== 'assets' && g.nature !== 'liabilities')) continue;
    const [o, c] = groupOpenClose(env, snap, id);
    // Source when funds come in: a liability grows (more credit) or an asset shrinks.
    put(`g:${id}`, g.name, id, -(c - o));
  }
  if (env.plLedgerId !== null) {
    const b = snap.ledgers.get(env.plLedgerId);
    if (b) put('pl', 'Profit & Loss A/c (direct entries)', null, -(b.closing - b.opening));
  }

  const wcRows: WorkingCapitalRow[] = [];
  const byGroup = ledgersByGroup(env);
  const addRows = (rootId: number | undefined, side: 'asset' | 'liability'): void => {
    if (rootId === undefined) return;
    const root = env.tree.byId.get(rootId);
    if (!root) return;
    const nat = (v: Paise): Paise => (side === 'asset' ? v : neg(v));
    const push = (key: string, label: string, groupId: number | null, ledgerId: number | null, o: Paise, c: Paise): void => {
      if (o === 0 && c === 0) return;
      const on = nat(o);
      const cn = nat(c);
      wcRows.push({ key, label, groupId, ledgerId, side, opening: on, closing: cn, change: side === 'asset' ? cn - on : neg(cn - on) });
    };
    for (const cid of root.childIds) {
      let [o, c] = groupOpenClose(env, snap, cid);
      if (side === 'asset' && cid === stockGroupId) {
        o += openStock;
        c += closeStock;
      }
      push(`g:${cid}`, env.tree.byId.get(cid)?.name ?? '', cid, null, o, c);
    }
    for (const l of byGroup.get(rootId) ?? []) {
      if (l.id === env.plLedgerId) continue;
      const b = snap.ledgers.get(l.id);
      push(`l:${l.id}`, l.name, null, l.id, b?.opening ?? 0, b?.closing ?? 0);
    }
  };
  addRows(caId, 'asset');
  addRows(clId, 'liability');
  // Stock without a Stock-in-Hand group under Current Assets (should not happen): its own row.
  if ((stockGroupId === undefined || env.tree.byId.get(stockGroupId)?.parentId !== caId) && (openStock !== 0 || closeStock !== 0)) {
    wcRows.push({ key: 'stock', label: 'Stock-in-Hand', groupId: null, ledgerId: null, side: 'asset', opening: openStock, closing: closeStock, change: closeStock - openStock });
  }
  let wcOpen = 0;
  let wcClose = 0;
  for (const r of wcRows) {
    const s = r.side === 'asset' ? 1 : -1;
    wcOpen += s * r.opening;
    wcClose += s * r.closing;
  }
  const totalSources = sources.reduce((s, l) => s + l.amount, 0);
  const totalApplications = applications.reduce((s, l) => s + l.amount, 0);
  const change = wcClose - wcOpen;
  return {
    from: snap.from,
    to: snap.to,
    sources,
    applications,
    totalSources,
    totalApplications,
    workingCapital: { opening: wcOpen, closing: wcClose, change },
    workingCapitalRows: wcRows,
    difference: totalSources - totalApplications - change,
  };
}
