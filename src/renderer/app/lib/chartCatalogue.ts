/**
 * The 2.1 graph catalogue (SPEC-21 §5): for every registered screen, the ONE graph that answers its
 * question — or, deliberately, none, with the reason. Data only (no React); `reportCharts.test.ts`
 * checks it against the registered screens and the screen sources.
 *
 * Shared registry (SPEC-21 §6.1): written whole by WP-C0. A wave-2 package only DELETES ITS OWN ids
 * from `PENDING_GRAPH` once their graphs are wired; the integrator removes leftovers and sets
 * `GRAPHS_STRICT`. No other edits.
 *
 * Form legend: column · bar (horizontal; `inline` = drawn as 4 px bars inside the table when its
 * categories are the table's ≤ 7 rows, else a Top-6 + Other strip — D26) · line · share (one 100 %
 * bar) · meter (a ratio against a limit) · mini (Home's MiniColumns) · none.
 * Class (D28): 'report' = shown by default (`uiPrefs.graphs`), 'detail' = drill-down reports, folded
 * by default (`uiPrefs.detailGraphs`).
 */
import type { ChartColor } from '../../ui/lib/chartSpec.ts';

export type GraphForm = 'column' | 'bar' | 'line' | 'share' | 'meter' | 'mini' | 'none';
export type GraphClass = 'report' | 'detail';
export type Priority = 'P1' | 'P2' | 'P3';
export type PackageId = 'WP-E1' | 'WP-E2' | 'WP-F' | 'WP-G' | 'WP-H' | 'WP-I1' | 'WP-I2' | 'WP-J1' | 'WP-J2' | 'WP-K1' | 'WP-K2' | 'WP-L1' | 'WP-L2' | 'WP-M' | 'WP-N';

export interface CatalogueRow {
  /** Registered screen id (`modules/<m>/index.ts`, or 'app.gateway' for Home). */
  id: string;
  /** The view of the screen this row is about (e.g. 'ageing' — Ctrl+3), when it has several. */
  view?: string;
  /** The ONE question the screen answers. */
  question?: string;
  form: GraphForm;
  /** bar↹: drawn inline in the table when its categories are the table's ≤ 7 rows (D26). */
  inline?: boolean;
  /** Colour rule (D29); absent = 'series'. */
  color?: ChartColor;
  /** Plus one context series in --chart-other (the Dashboard's Purchases). */
  context?: boolean;
  /** D28 class; every graph row has one. */
  graphClass?: GraphClass;
  /** Title fixed by the spec (accessible name; e2e reads some). */
  title?: string;
  /** When the builder returns null although data exists (besides `enoughData`). */
  gate?: string;
  /** Where the numbers come from. */
  data?: string;
  /** Why there is deliberately no graph — required for every 'none' row. */
  reason?: string;
  /** The toolbar-row stat in the owner's words (D24), if any. */
  stat?: string;
  priority?: Priority;
  /** The wave-2 package that wires (or deliberately omits) the graph. */
  owner: PackageId;
  /**
   * How the graph reaches the screen: the `graph` prop of `ReportScreen`/`Screen` built with
   * `reportGraph(…)` from a `lib/charts.ts` builder (default), Home's `MiniColumns`, or the full
   * Dashboard's cards through `LazyChart`.
   */
  via?: 'graph' | 'MiniColumns' | 'LazyChart';
}

const none = (owner: PackageId, reason: string, ids: readonly string[], extra: Partial<CatalogueRow> = {}): CatalogueRow[] => ids.map((id) => ({ id, form: 'none', reason, owner, ...extra }));

const MASTER = 'a lookup list or master form, not a report';
const WORKFLOW = 'a workflow or settings screen, not a report';

export const GRAPH_CATALOGUE: readonly CatalogueRow[] = [
  // ── Home and dashboard (WP-M) ──────────────────────────────────────────────────────────────
  { id: 'app.gateway', question: 'Where does my money stand, and how are sales going?', form: 'mini', color: 'emphasis', graphClass: 'report', title: 'Sales — last 12 months', via: 'MiniColumns', gate: 'months from the books-beginning month (≥ 3) to the working-date month (≤ 12); that month slot 1, earlier months grey', data: 'dashboard.summary trend[].sales, sales.mtd, sales.lastYear.mtd, booksFrom, asOf', stat: 'To collect · To pay · Cash & bank (3 figures)', priority: 'P1', owner: 'WP-M' },
  { id: 'dashboard.home', question: 'How is the business doing?', form: 'line', context: true, graphClass: 'report', title: 'Sales and purchases — last 12 months', via: 'LazyChart', data: 'dashboard.summary trend[12] (Sales slot 1 + area; Purchases grey, no area) + receivables.ageing as an ordinal column card', stat: 'Sales ▲% · Gross profit % · Receivables · Cash & bank (4 figures)', priority: 'P2', owner: 'WP-M' },
  ...none('WP-M', WORKFLOW, ['company.about', 'company.changePassword', 'company.config', 'company.features', 'company.periodLock', 'company.profile', 'company.settings', 'company.shortcuts']),

  // ── Reports module (WP-H) ──────────────────────────────────────────────────────────────────
  { id: 'reports.profitLoss', question: 'Am I making money, month by month?', form: 'column', color: 'polarity', graphClass: 'report', title: 'Net profit by month', gate: '< 3 months, Compare mode, or !inventoryIntegrated with purchases in the period (About this report says why)', data: 'NEW reports.profitTrend {from,to,scenarioId}; foldMonths; axis Profit ↑ / Loss ↓; label max; Enter → P&L of that month', stat: 'Net profit/loss ₹x as the context state word (allow-listed)', priority: 'P1', owner: 'WP-H' },
  { id: 'reports.balanceSheet', question: 'What do I own and owe?', form: 'none', reason: 'a balance sheet balances by construction (two equal bars); the Difference line is a data-entry fault, said by the banner', priority: 'P1', owner: 'WP-H' },
  { id: 'reports.trialBalance', question: 'Do debits equal credits?', form: 'none', reason: 'a check, not a story', stat: 'Agrees ✓ / Differs by ₹d (danger)', priority: 'P1', owner: 'WP-H' },
  { id: 'reports.cashBank', question: 'Where is my money sitting?', form: 'bar', inline: true, color: 'polarity', graphClass: 'report', gate: 'none with < 3 cash/bank ledgers', data: 'rows kind ledger .closing; total = totals.closing (overdraft slot 2)', priority: 'P1', owner: 'WP-H' },
  { id: 'reports.register', view: 'months', question: 'How much did I sell / buy / receive / pay each month?', form: 'column', graphClass: 'report', title: 'Sales before GST, by month', data: 'months[].taxable for sales, purchase, credit and debit notes; months[].amount for receipt, payment, contra, journal; label max; partialLast', priority: 'P1', owner: 'WP-H' },
  { id: 'reports.register', view: 'vouchers', form: 'none', reason: 'the vouchers view (Alt+V) is a list; the months view carries the graph', priority: 'P1', owner: 'WP-H' },
  { id: 'reports.ledger', question: "How did this account's balance move?", form: 'line', graphClass: 'detail', data: 'rows (last .balance per .date) + opening, natural side; when truncated: reports.monthlySummary {ledgerId} rows[].closing; label last', priority: 'P2', owner: 'WP-H' },
  { id: 'reports.monthlySummary', question: 'How much moved / how did the balance move each month?', form: 'column', graphClass: 'detail', data: 'rows[]; subject.isNominal → net movement columns on the natural side, else a line of month-end closing; Enter → month', priority: 'P2', owner: 'WP-H' },
  { id: 'reports.groupSummary', view: 'summary', question: 'What makes up this group?', form: 'bar', inline: true, color: 'polarity', graphClass: 'detail', data: 'rows level 0 .closing by |closing| (unnatural-side children slot 2), group.nature', priority: 'P2', owner: 'WP-H' },
  { id: 'reports.groupSummary', view: 'vouchers', form: 'none', reason: 'the vouchers view is a list; the summary view carries the graph', priority: 'P2', owner: 'WP-H' },
  { id: 'reports.cashFlow', question: 'Net cash in or out by month?', form: 'column', color: 'polarity', graphClass: 'report', data: 'months[].net; captions In ↑ / Out ↓; Enter → month', priority: 'P2', owner: 'WP-H' },
  { id: 'reports.fundsFlow', question: 'Where did funds come from and go?', form: 'none', reason: 'sources equal applications by construction (the Balance Sheet argument)', priority: 'P3', owner: 'WP-H' },
  { id: 'reports.costCentres', question: 'Which centre spends most?', form: 'bar', inline: true, color: 'polarity', graphClass: 'report', data: 'rows kind centre .net for the first/given category', priority: 'P3', owner: 'WP-H' },
  { id: 'reports.ratios', question: 'Is the business healthy?', form: 'none', reason: 'the four ratios are the content (figures, no icons)', priority: 'P3', owner: 'WP-H' },
  { id: 'reports.exceptions', question: 'What needs correcting?', form: 'none', reason: 'a to-do list; counts on the tabs', priority: 'P3', owner: 'WP-H' },
  { id: 'reports.statistics', question: 'How many vouchers and masters?', form: 'none', reason: 'housekeeping counts', priority: 'P3', owner: 'WP-H' },

  // ── Outstanding (WP-I1) ────────────────────────────────────────────────────────────────────
  { id: 'outstanding.receivables', view: 'parties', question: 'How much do customers owe, and how late is it?', form: 'none', reason: 'the Ageing view (Ctrl+3) is the graph; no ageing fetch on this view', stat: 'To collect ₹x · Overdue ₹y › · ₹z not matched to bills › (zeros hidden; "To collect" allow-listed); context: N over credit limit', priority: 'P1', owner: 'WP-I1' },
  { id: 'outstanding.receivables', view: 'bills', question: 'Which bills to chase first?', form: 'none', reason: 'a worklist sorted by days', stat: 'as the Parties view', priority: 'P3', owner: 'WP-I1' },
  { id: 'outstanding.receivables', view: 'ageing', question: "How old is what I'm owed?", form: 'column', color: 'ordinal', graphClass: 'report', data: 'outstanding.ageing totals.amounts[] (Not due grey, buckets o1…o5); label max; takeaway names its base; Enter → Bills with minDays', stat: 'as the Parties view', priority: 'P1', owner: 'WP-I1' },
  { id: 'outstanding.payables', view: 'parties', question: 'How much do I owe suppliers, and how late (MSME 45 days)?', form: 'none', reason: 'the Ageing view (Ctrl+3) is the graph', stat: 'To pay ₹x · Overdue ₹y › · … ("To pay" allow-listed)', priority: 'P1', owner: 'WP-I1' },
  { id: 'outstanding.payables', view: 'bills', form: 'none', reason: 'a worklist sorted by days', stat: 'as the Parties view', priority: 'P3', owner: 'WP-I1' },
  { id: 'outstanding.payables', view: 'ageing', question: 'How old is what I owe?', form: 'column', color: 'ordinal', graphClass: 'report', data: "outstanding.ageing {side:'payable'} totals.amounts[]", stat: 'as the Parties view', priority: 'P1', owner: 'WP-I1' },
  { id: 'outstanding.party', question: 'This party against its credit limit', form: 'meter', graphClass: 'detail', gate: 'only when creditLimit > 0 and the balance > 0; else none', data: 'balance, ledger.creditLimit ("Balance ₹A of limit ₹B")', priority: 'P3', owner: 'WP-I1' },
  { id: 'outstanding.statement', question: "Where does this party's account stand?", form: 'line', graphClass: 'detail', data: 'transactions[].balance, openingBalance (screen only — never on the printed statement)', priority: 'P2', owner: 'WP-I1' },
  { id: 'outstanding.interest', question: 'Interest to charge / owed', form: 'none', reason: 'two figures, in the total row', priority: 'P3', owner: 'WP-I1' },
  { id: 'outstanding.reminders', question: 'Whom to remind?', form: 'none', reason: 'a letter-printing workflow', stat: 'M of N selected', priority: 'P3', owner: 'WP-I1' },

  // ── Stock reports (WP-I2) ──────────────────────────────────────────────────────────────────
  { id: 'stock.summary', question: 'Where is money locked in stock?', form: 'bar', inline: true, graphClass: 'report', gate: 'none in Quantities only (Alt+V)', data: 'byGroup.data.rows (parentKey === null, closing.value), valuesShown; Enter = summaryDrill', priority: 'P1', owner: 'WP-I2' },
  { id: 'stock.ageing', question: 'How much stock is old?', form: 'column', color: 'ordinal', graphClass: 'report', data: 'buckets[].label, totals.buckets (always value; Alt+Q changes the table only)', priority: 'P2', owner: 'WP-I2' },
  { id: 'stock.item', question: 'Is this item running down?', form: 'line', graphClass: 'detail', data: "opening.qty, rows[].date, rows[].closing.qty in the item's unit (custom valueFormat), zero baseline", priority: 'P2', owner: 'WP-I2' },
  { id: 'stock.profitability', question: 'Which items make or lose money?', form: 'bar', inline: true, color: 'polarity', graphClass: 'report', data: 'rows[].grossProfit: top 6 by gross profit + up to 3 loss items, rest Other', priority: 'P2', owner: 'WP-I2' },
  { id: 'stock.categories', question: 'Stock by category', form: 'bar', inline: true, color: 'emphasis', graphClass: 'report', gate: 'none in quantities mode', data: 'byCategory level 0 (categories slot 1, "Not categorised" grey)', priority: 'P3', owner: 'WP-I2' },
  { id: 'stock.godowns', question: 'Where is stock lying?', form: 'bar', inline: true, graphClass: 'report', data: 'rows kind godown level 0 .value', priority: 'P3', owner: 'WP-I2' },
  { id: 'stock.movement', question: 'Biggest buyers / suppliers of this stock', form: 'bar', inline: true, graphClass: 'report', data: 'd[side].rows (value); same slot for both sides, not recoloured on the toggle', priority: 'P3', owner: 'WP-I2' },
  { id: 'stock.pendingOrders', question: 'Still to deliver, late?', form: 'none', reason: 'two numbers', stat: 'N overdue', priority: 'P3', owner: 'WP-I2' },
  { id: 'stock.batches', question: 'Expired / expiring', form: 'none', reason: 'counts of mixed units, no value', stat: 'Expired N · Expiring in 30 days M', priority: 'P3', owner: 'WP-I2' },
  { id: 'stock.negative', question: 'Items below zero', form: 'none', reason: 'an exception list; empty is success', stat: 'N items below zero', priority: 'P3', owner: 'WP-I2' },
  { id: 'stock.physicalVariance', question: 'Gain / loss on count', form: 'none', reason: 'three numbers in the total row', priority: 'P3', owner: 'WP-I2' },
  { id: 'stock.reorder', question: 'What to buy today?', form: 'none', reason: 'mixed units', stat: 'Order now: N of M items', priority: 'P3', owner: 'WP-I2' },

  // ── GST returns (WP-J1) ────────────────────────────────────────────────────────────────────
  { id: 'gst.gstr1', question: 'Can I file; is anything blocking?', form: 'none', reason: 'a statutory form: the portal tables are the filing', stat: 'Nothing blocking / N block the JSON · Review ›', priority: 'P1', owner: 'WP-J1' },
  { id: 'gst.gstr1.section', question: 'Documents in one table', form: 'none', reason: 'the drill-down behind a GSTR-1 row', priority: 'P3', owner: 'WP-J1' },
  { id: 'gst.gstr3b', question: 'Cash to pay after credit?', form: 'meter', graphClass: 'report', gate: 'meter "From credit ₹A · In cash ₹B" only when both parts > 0; the head figure "Cash to pay ₹x" always', data: 'payment.cashTotal, Σ payment.itcUsed, Σ rows[].liability + rcmLiability', stat: 'the figure + due date + N warnings › (allow-listed)', priority: 'P1', owner: 'WP-J1' },
  { id: 'gst.gstr9', question: 'Tax payable after credit, month by month?', form: 'column', color: 'polarity', graphClass: 'report', title: 'Tax payable after credit, by month', data: 'months[].outwardTax, monthly ITC heads (payable ↑ slot 1, credit carried ↓ slot 2; Payable ↑ / Credit left ↓); Enter → that month 3B', priority: 'P2', owner: 'WP-J1' },
  { id: 'gst.cmp08', question: 'Composition tax owed / paid', form: 'none', reason: 'a statutory form; two numbers', priority: 'P3', owner: 'WP-J1' },
  { id: 'gst.gstr4', question: 'Due vs paid by quarter', form: 'none', reason: 'a statutory form', priority: 'P3', owner: 'WP-J1' },
  { id: 'gst.composition', question: 'Composition rates', form: 'none', reason: 'a rates master', priority: 'P3', owner: 'WP-J1' },
  { id: 'gst.setoff', question: 'Is there enough cash in the e-ledger?', form: 'meter', graphClass: 'report', gate: 'both parts > 0', data: 'cashTotal, Σ cash[].available (capped), toDepositTotal ("Cash in ledger ₹A of ₹B needed")', stat: 'To deposit ₹x', priority: 'P2', owner: 'WP-J1' },
  { id: 'gst.ledger.cash', question: 'Cash in the GST cash ledger', form: 'line', graphClass: 'detail', data: 'totals.opening ± signed transactions (running balance)', priority: 'P3', owner: 'WP-J1' },
  { id: 'gst.ledger.credit', question: 'Credit in hand, building or used?', form: 'line', graphClass: 'detail', data: 'Σ rows[].opening + signed transactions[] (running balance)', priority: 'P3', owner: 'WP-J1' },

  // ── GST registers and reconciliation (WP-J2) ───────────────────────────────────────────────
  { id: 'gst.register', question: 'Sales / purchases by GST rate', form: 'column', graphClass: 'report', gate: '≥ 3 rates', data: 'rateTotals[] taxable by rate, label max (replaces the "Totals by rate" panel; its table moves to More)', priority: 'P2', owner: 'WP-J2' },
  { id: 'gst.hsn', question: 'Which HSN/SAC dominate?', form: 'bar', inline: true, graphClass: 'report', data: 'rows[] grouped by hsn, by taxable; label "code · short description"', priority: 'P2', owner: 'WP-J2' },
  { id: 'gst.itc', question: 'ITC, and from whom?', form: 'bar', graphClass: 'report', data: 'rows[].eligible by supplier, top 6 + Other (rows are documents, so always a strip), totals', stat: 'Blocked ₹y (only when > 0)', priority: 'P2', owner: 'WP-J2' },
  { id: 'gst.exceptions', question: 'What blocks filing?', form: 'bar', color: 'problem', graphClass: 'report', gate: '≥ 3 problem types; none when there are no issues (success state)', data: 'counts.byCode (errors slot 2, warnings grey), label tips; click = type filter', stat: 'N errors · M warnings', priority: 'P2', owner: 'WP-J2' },
  { id: 'gst.boe', view: 'reconcile', question: 'BOE vs GSTR-2B', form: 'share', color: 'problem', graphClass: 'report', gate: '≥ 3 non-zero segments', data: 'BoeReconResult.counts (Matched grey; Mismatch / Not in books / Not in 2B slot 2)', stat: 'N matched of M', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.boe', view: 'register', form: 'none', reason: 'the register view is a list; the reconcile view carries the graph', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.advances', question: 'Tax on advances in 3.1(a)', form: 'none', reason: 'one figure', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.amendments', question: 'What changed after filing', form: 'none', reason: 'a change log', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.gstr3b.changes', question: 'Δ after 3B filing', form: 'none', reason: 'a change log', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.rule37', question: 'Reverse / reclaim now', form: 'none', reason: 'two numbers driving actions', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.einvoice', question: 'Which need an IRN?', form: 'none', reason: 'a work queue', stat: 'N pending', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.ewaybill', question: 'Which need an e-way bill?', form: 'none', reason: 'a work queue', stat: 'N pending', priority: 'P3', owner: 'WP-J2' },
  { id: 'gst.filings', question: 'What is filed', form: 'none', reason: 'a log', priority: 'P3', owner: 'WP-J2' },
  { id: 'gstrecon.home', view: 'purchases', question: 'ITC not backed by the portal?', form: 'share', color: 'problem', graphClass: 'report', data: 'gstrecon.summary run.counts (Matched + accepted grey; Amount differs, Not in books, Not on portal slot 2); click = status filter; via the Screen graph prop', stat: 'ITC at risk ₹x · y % reconciled', priority: 'P2', owner: 'WP-J2' },
  { id: 'gstrecon.home', view: 'gstr1', question: 'GSTR-1 vs books', form: 'share', color: 'problem', graphClass: 'report', data: "gstrecon.summary (source 'gstr1')", stat: 'Tax not reported ₹x', priority: 'P3', owner: 'WP-J2' },
  { id: 'gstrecon.home', view: 'suppliers', question: 'Whom to chase for ITC', form: 'bar', inline: true, graphClass: 'report', data: 'supplierSummary |taxDifference| (label says "less/more on portal")', priority: 'P3', owner: 'WP-J2' },

  // ── Banking and cheques (WP-K1) ────────────────────────────────────────────────────────────
  { id: 'banking.summary', question: 'How much in each bank?', form: 'bar', inline: true, color: 'polarity', graphClass: 'report', gate: 'none with < 3 accounts', data: 'useBanks(asOf) balanceAsPerBooks, shortName (OD/CC left of 0, slot 2)', stat: 'N entries not in the bank', priority: 'P2', owner: 'WP-K1' },
  { id: 'banking.pdc', question: 'PDC in/out in the coming weeks', form: 'column', color: 'polarity', graphClass: 'report', data: 'rows[] bucketed by floor(daysToMaturity / 7): Due now, W1–W8, Later; captions In ↑ / Out ↓', priority: 'P3', owner: 'WP-K1' },
  { id: 'banking.cheques', question: 'Uncleared cheques?', form: 'none', reason: 'two numbers', stat: 'Not cleared: issued ₹x · received ₹y (3 stale)', priority: 'P3', owner: 'WP-K1' },
  { id: 'banking.brs', question: 'Does the bank agree?', form: 'none', reason: 'the books-to-bank bridge is already the picture', stat: 'Agrees ✓ / Difference ₹x', priority: 'P3', owner: 'WP-K1' },
  ...none('WP-K1', 'a document or a worksheet, not a report', ['banking.depositSlip', 'banking.match', 'banking.import'], { priority: 'P3' }),
  { id: 'cheques.register', question: 'Leaves left in this book', form: 'meter', graphClass: 'report', gate: 'only with a book selected; else none', data: 'totals.unused, totals.leaves ("Leaves used N of M", static); via the Screen graph prop', priority: 'P3', owner: 'WP-K1' },
  ...none('WP-K1', `${MASTER} (cheque masters and printing workflows)`, ['cheques.bank', 'cheques.book.form', 'cheques.books', 'cheques.epayments', 'cheques.layout.form', 'cheques.layouts', 'cheques.payee.form', 'cheques.payees', 'cheques.print']),

  // ── TDS and forex (WP-K2) ──────────────────────────────────────────────────────────────────
  { id: 'tds.computation', question: 'What is not yet deposited, by section?', form: 'bar', inline: true, graphClass: 'report', title: 'Not yet deposited, by section', data: 'Σ by rows[].section of deducted − deposited', priority: 'P2', owner: 'WP-K2' },
  { id: 'tds.outstanding', question: 'What is left to deposit, late?', form: 'column', color: 'problem', graphClass: 'report', data: 'rows by period, Σ balance, status (overdue months slot 2, due grey; legend Overdue / Due); Enter → tds.lines', stat: 'Interest ₹y (only when > 0)', priority: 'P2', owner: 'WP-K2' },
  { id: 'tds.challans', question: 'Paid monthly, on time?', form: 'column', color: 'problem', graphClass: 'report', data: 'depositDate.slice(0,7), Σ total, any late (late months slot 2, on time grey)', priority: 'P3', owner: 'WP-K2' },
  { id: 'tds.receivable', question: 'TDS missing from 26AS', form: 'bar', inline: true, graphClass: 'report', gate: 'none when every row matches', data: 'rows (status ≠ matched) |difference|, totals.difference', stat: 'Books agree with 26AS (when all match)', priority: 'P3', owner: 'WP-K2' },
  { id: 'tds.return', question: 'Is the quarter covered by challans?', form: 'meter', graphClass: 'report', gate: 'both parts > 0', data: 'totals.deposited, totals.tax ("Deposited ₹A of tax ₹B")', stat: '₹x not covered (only when > 0)', priority: 'P3', owner: 'WP-K2' },
  { id: 'tds.exceptions', form: 'none', reason: 'a to-do list', stat: 'Shortfall ₹x (when > 0)', priority: 'P3', owner: 'WP-K2' },
  { id: 'tds.lines', form: 'none', reason: 'the drill-down behind another report', priority: 'P3', owner: 'WP-K2' },
  ...none('WP-K2', MASTER, ['tds.challan', 'tds.ledger.form', 'tds.ledgers', 'tds.nature.form', 'tds.natures', 'tds.setup']),
  { id: 'forex.outstanding', question: 'Foreign money owed, overdue?', form: 'column', color: 'ordinal', graphClass: 'report', gate: 'none for side "All"', data: 'parties[].bills[] (overdueDays, revaluedAmount ?? inr) for the chosen side (Not due grey, 1-30…90+ o1…)', stat: 'one line per currency', priority: 'P3', owner: 'WP-K2' },
  { id: 'forex.revaluation', question: 'Unrealised gain/loss by party', form: 'bar', inline: true, color: 'polarity', graphClass: 'report', data: 'Σ lines[].adjustment by ledger (loss slot 2), net; words gain/loss', priority: 'P3', owner: 'WP-K2' },
  { id: 'forex.ledger', question: 'Foreign balance movement', form: 'line', graphClass: 'detail', gate: '≥ 3 rows', data: 'rows[].forexBalance, openingForex (step line in the currency)', priority: 'P3', owner: 'WP-K2' },
  ...none('WP-K2', MASTER, ['forex.opening', 'forex.settings']),

  // ── Documents, manufacturing, POS (WP-L1) ──────────────────────────────────────────────────
  { id: 'documents.quotations', question: 'Quoted → business?', form: 'none', reason: 'two numbers (a share bar would put "Open" in a colour that means "bad")', stat: 'Open ₹x · Conversion y %', priority: 'P3', owner: 'WP-L1' },
  { id: 'documents.billsPending', question: 'Delivered, not invoiced, how old?', form: 'column', color: 'ordinal', graphClass: 'report', data: 'client ageing (0–7 grey, 8–30 o1, 31–90 o3, > 90 o5); an eager screen: LazyChart keeps the kit out of the entry', priority: 'P3', owner: 'WP-L1' },
  { id: 'documents.budget.variance', question: 'Over/under budget', form: 'bar', inline: true, color: 'polarity', graphClass: 'report', data: 'rows[].variance (over-budget slot 2; inTotal !== false), totals; null-% lines table only', priority: 'P3', owner: 'WP-L1' },
  { id: 'documents.recurring.due', form: 'none', reason: 'a to-do list', stat: '₹x to post today', priority: 'P3', owner: 'WP-L1' },
  ...none('WP-L1', MASTER, ['documents.budget.form', 'documents.budgets', 'documents.order.preclose', 'documents.quotation.status', 'documents.recurring', 'documents.recurring.form', 'documents.scenarios'], { priority: 'P3' }),
  { id: 'mfg.production', question: 'Produced and cost', form: 'column', graphClass: 'report', gate: '≥ 3 months', data: 'rows[].date, productValue by month; label max', priority: 'P3', owner: 'WP-L1' },
  { id: 'mfg.jobWork.pending', question: 'With job workers, late?', form: 'share', color: 'ordinal', graphClass: 'report', gate: 'none with Ctrl+3 (overdue only)', data: 'Σ rows[].pendingValue by status (Later o1, ≤ 30 days o3, Overdue o5)', stat: 'N overdue', priority: 'P3', owner: 'WP-L1' },
  { id: 'mfg.itc04', question: 'Job-work return', form: 'none', reason: 'a statutory form', stat: 'N lines in table 4 · M in 5', priority: 'P3', owner: 'WP-L1' },
  ...none('WP-L1', MASTER, ['mfg.bom.form', 'mfg.bom.list', 'mfg.jobWorkOrder.form', 'mfg.jobWorkOrder.list']),
  ...none('WP-L1', 'entry, not a report', ['mfg.journal.entry', 'pos.counter', 'pos.return']),
  { id: 'pos.summary', question: 'Takings by tender', form: 'bar', inline: true, graphClass: 'report', data: 'byTender[].net (one colour; the tender names carry the identity)', stat: 'Cash in drawer ₹y', priority: 'P3', owner: 'WP-L1' },
  ...none('WP-L1', WORKFLOW, ['pos.settings']),

  // ── Data, security, attachments (WP-L2) ────────────────────────────────────────────────────
  { id: 'data.verify', question: 'Are the books sound?', form: 'none', reason: 'a check list', owner: 'WP-L2' },
  ...none('WP-L2', 'a lookup list or settings, not a report', ['attachments.manage', 'attachments.register', 'data.backup', 'data.export', 'data.import', 'data.restore', 'data.xmlExport', 'data.xmlImport', 'security.audit', 'security.role.form', 'security.session', 'security.settings', 'security.user.form', 'security.users']),

  // ── Vouchers, accounts, inventory, print — deliberately none (WP-E1/E2, WP-F, WP-G, WP-N) ──
  { id: 'vouchers.daybook', form: 'none', reason: 'a journal of entries; mixed voucher types have no single magnitude', stat: 'N vouchers', owner: 'WP-E2' },
  { id: 'vouchers.list', form: 'none', reason: "the drill-down behind another report's number", owner: 'WP-E2' },
  { id: 'vouchers.view', form: 'none', reason: 'a document, not a report', owner: 'WP-E2' },
  { id: 'vouchers.entry', form: 'none', reason: 'entry, not a report', owner: 'WP-E1' },
  ...none('WP-F', 'a lookup list; the closing-balance column is the answer', ['accounts.chart', 'accounts.costCentres', 'accounts.currencies', 'accounts.group.list', 'accounts.ledger.list', 'accounts.numbering', 'accounts.voucherTypes']),
  { id: 'accounts.openingBalances', form: 'none', reason: 'a lookup list; the closing-balance column is the answer', stat: 'Difference ₹x (when ≠ 0)', owner: 'WP-F' },
  ...none('WP-F', MASTER, ['accounts.group.form', 'accounts.ledger.bulk', 'accounts.ledger.form', 'accounts.voucherType.form']),
  ...none('WP-G', 'a lookup list; the in-stock column is the answer', ['inventory.category.list', 'inventory.godown.list', 'inventory.group.list', 'inventory.item.list', 'inventory.priceList', 'inventory.unit.list']),
  ...none('WP-G', MASTER, ['inventory.category.form', 'inventory.godown.form', 'inventory.group.form', 'inventory.item.bulk', 'inventory.item.form', 'inventory.unit.form']),
  ...none('WP-N', 'printing, not a report — graphs never print (D30)', ['print.batch', 'print.settings', 'print.voucher']),
];

/**
 * Graph ids not yet wired (wave 2 deletes its own, one line each). While an id is listed,
 * `reportCharts.test.ts` does not require its screen to pass `graph=`.
 */
export const PENDING_GRAPH: readonly string[] = [
  'app.gateway',
  'banking.pdc',
  'banking.summary',
  'cheques.register',
  'dashboard.home',
  'documents.billsPending',
  'documents.budget.variance',
  'forex.ledger',
  'forex.outstanding',
  'forex.revaluation',
  'gst.boe',
  'gst.exceptions',
  'gst.gstr3b',
  'gst.gstr9',
  'gst.hsn',
  'gst.itc',
  'gst.ledger.cash',
  'gst.ledger.credit',
  'gst.register',
  'gst.setoff',
  'gstrecon.home',
  'mfg.jobWork.pending',
  'mfg.production',
  'outstanding.party',
  'outstanding.payables',
  'outstanding.receivables',
  'outstanding.statement',
  'pos.summary',
  'reports.cashBank',
  'reports.cashFlow',
  'reports.costCentres',
  'reports.groupSummary',
  'reports.ledger',
  'reports.monthlySummary',
  'reports.profitLoss',
  'reports.register',
  'stock.ageing',
  'stock.categories',
  'stock.godowns',
  'stock.item',
  'stock.movement',
  'stock.profitability',
  'stock.summary',
  'tds.challans',
  'tds.computation',
  'tds.outstanding',
  'tds.receivable',
  'tds.return',
];

/**
 * D24 exceptions: screens whose stat may repeat a visible table total, with the reason. A builder's
 * `xxxStat` test asserts `statRepeatsTotal(...) === false` unless its id is listed here.
 */
export const STAT_TOTAL_ALLOWED: Readonly<Record<string, string>> = {
  'reports.profitLoss': 'the Net profit/loss row sits in the second section, often below the fold; the context word says it at the top',
  'outstanding.receivables': '"To collect" is the Net outstanding total in the owner\'s words (bills + advances + on account)',
  'outstanding.payables': '"To pay" is the Net outstanding total in the owner\'s words (bills + advances + on account)',
  'gst.gstr3b': 'the cash-to-pay figure is table 6.1\'s total, which sits at the bottom of the form',
};

/** Set by the integrator once PENDING_GRAPH is empty: every graph row must then be wired. */
export const GRAPHS_STRICT = false;

export function catalogueRows(id: string): CatalogueRow[] {
  return GRAPH_CATALOGUE.filter((r) => r.id === id);
}

export function graphRows(): CatalogueRow[] {
  return GRAPH_CATALOGUE.filter((r) => r.form !== 'none');
}

/** The D28 class of a screen's graph (null when the screen has none). */
export function graphClassOf(id: string): GraphClass | null {
  return catalogueRows(id).find((r) => r.form !== 'none')?.graphClass ?? null;
}

export function statTotalAllowed(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(STAT_TOTAL_ALLOWED, id);
}
