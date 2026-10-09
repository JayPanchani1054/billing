/**
 * Manufacturing Journal / Material Out / Material In — stock journals with a class.
 *
 * The voucher is entered as a `stockJournal` block (roles: component, product, by-product, scrap,
 * transfer, receipt, issue — see shared/types/mfg.ts); `composeJournal` derives the ordinary stock
 * journal item lines from it (consumption = source, production = destination) plus the per-line
 * costing basis and job work details. The vouchers module posts those lines exactly like any stock
 * journal (no ledger entries: additional costs only add to the value of the finished goods, as in
 * Tally — book the expense itself with a Payment / Journal), and the stock valuation engine values
 * the production side with the basis (shared/mfg/costing.ts), so every stock report and the Balance
 * Sheet agree. Composition runs for preview and save alike (vouchers/hooks.ts › compose) and never
 * writes; the derived rows are written by hook.ts in the save transaction.
 */
import { formatQty } from '../../../shared/format.ts';
import { costJournal, type JournalCostResult, type ProductionBasis, type ProductionTerm } from '../../../shared/mfg/costing.ts';
import type { JobWorkGoodsType } from '../../../shared/mfg/jobwork.ts';
import { lineAmount, roundTo } from '../../../shared/money.ts';
import type { FieldIssue } from '../../../shared/api.ts';
import type {
  StockJournalClass,
  StockJournalCostPreview,
  StockJournalExtInput,
  StockJournalLineInput,
  ThirdPartyKind,
} from '../../../shared/types/mfg.ts';
import type { ItemLineInput, VoucherInput } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';
import { rule, validation } from '../../lib/errors.ts';
import { estimateIssueCosts } from '../inventory/valuation.ts';

export type DerivedRole = 'component' | 'product' | 'by_product' | 'scrap' | 'transfer_out' | 'transfer_in' | 'receipt' | 'issue';

/** One derived item line (index = line_no − 1 of the posted voucher). */
export interface DerivedLine {
  lineNo: number;
  /** Index of the block line it comes from. */
  blockIndex: number;
  role: DerivedRole;
  isConsumption: boolean;
  basis: ProductionBasis | null;
  pct: number | null;
  sourceLineNo: number | null;
  goodsType: JobWorkGoodsType | null;
  challanValue: number | null;
  extendedTo: string | null;
}

export interface GodownInfo {
  id: number;
  name: string;
  kind: ThirdPartyKind;
  partyLedgerId: number | null;
}

export interface ComposedJournal {
  cls: StockJournalClass;
  items: ItemLineInput[];
  derived: DerivedLine[];
  terms: Map<number, ProductionTerm>;
  /** The job work godown and the direction it implies ('out': principal, 'in': job worker). */
  thirdParty: GodownInfo | null;
  direction: 'out' | 'in' | null;
  productItemId: number | null;
  productQty: number | null;
  bomRevision: number | null;
  estimate: StockJournalCostPreview;
  cost: JournalCostResult;
}

interface ItemInfo {
  id: number;
  name: string;
  is_service: number;
  maintain_batches: number;
  unit: string;
  decimals: number;
}

const ROLES_BY_CLASS: Readonly<Record<StockJournalClass, Record<'none' | 'ours_with_party' | 'party_with_us', readonly StockJournalLineInput['role'][]>>> = {
  manufacturing: {
    none: ['component', 'product', 'by_product', 'scrap'],
    ours_with_party: ['component', 'product', 'by_product', 'scrap'],
    party_with_us: ['component', 'product', 'by_product', 'scrap'],
  },
  material_out: { none: [], ours_with_party: ['transfer'], party_with_us: ['issue'] },
  material_in: { none: [], ours_with_party: ['component', 'product', 'by_product', 'scrap', 'transfer'], party_with_us: ['receipt'] },
};

const ROLE_LABEL: Readonly<Record<StockJournalLineInput['role'], string>> = {
  component: 'component',
  product: 'finished goods',
  by_product: 'by-product',
  scrap: 'scrap',
  transfer: 'material',
  receipt: 'material received',
  issue: 'material returned',
};

export function loadGodowns(db: Db): Map<number, GodownInfo> {
  return new Map(
    db
      .all<{ id: number; name: string; kind: ThirdPartyKind; party_ledger_id: number | null }>(
        'SELECT id, name, third_party_kind AS kind, party_ledger_id FROM godowns',
      )
      .map((g) => [g.id, { id: g.id, name: g.name, kind: g.kind, partyLedgerId: g.party_ledger_id }]),
  );
}

/**
 * Derive the item lines and costing terms of a classed stock journal (throws VALIDATION with
 * `stockJournal.…` paths). `voucherId`: the voucher being altered (left out of the cost estimate).
 */
export function composeJournal(
  db: Db,
  env: { today: string; batches: boolean; manufacturing: boolean; jobWork: boolean },
  cls: StockJournalClass,
  input: VoucherInput,
  block: StockJournalExtInput,
  voucherId: number | null,
): ComposedJournal {
  if (cls === 'manufacturing' && !env.manufacturing) {
    throw rule('Bill of materials and manufacturing is turned off for this company. Turn it on under F11 › Features (Inventory).');
  }
  if (cls !== 'manufacturing' && !env.jobWork) {
    throw rule('Job work is turned off for this company. Turn it on under F11 › Features (Inventory; needs Multiple godowns).');
  }
  const issues: FieldIssue[] = [];
  const P = 'stockJournal';
  const godowns = loadGodowns(db);
  const main = db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ?? 0;
  const lines = block.lines ?? [];
  if (lines.length === 0) throw validation([{ path: `${P}.lines`, message: 'Enter at least one item line.' }]);

  // Job work godown.
  let third: GodownInfo | null = null;
  if (block.thirdPartyGodownId !== undefined) {
    third = godowns.get(block.thirdPartyGodownId) ?? null;
    if (!third) issues.push({ path: `${P}.thirdPartyGodownId`, message: 'The selected godown no longer exists. Select it again.' });
  }
  if (cls !== 'manufacturing') {
    if (!third && block.thirdPartyGodownId === undefined) {
      issues.push({
        path: `${P}.thirdPartyGodownId`,
        message: `Select the job worker's (or principal's) godown the material ${cls === 'material_out' ? 'goes to / leaves from' : 'comes from / goes into'}.`,
      });
    } else if (third && third.kind === 'none') {
      issues.push({
        path: `${P}.thirdPartyGodownId`,
        message: `${third.name} is one of your own godowns. Mark the job worker's godown as "Our stock with third party" (or a principal's as "Third-party stock with us") in the godown master.`,
      });
    }
    if (!input.partyLedgerId) issues.push({ path: 'partyLedgerId', message: 'Select the job worker (or principal) in "Party A/c name".' });
  } else if (third) {
    issues.push({ path: `${P}.thirdPartyGodownId`, message: 'A Manufacturing Journal has no job work godown; enter the godown on each line.' });
  }
  if (issues.length > 0) throw validation(issues);
  const kind = third?.kind ?? 'none';
  const allowed = ROLES_BY_CLASS[cls][kind];
  const direction: 'out' | 'in' | null = third ? (third.kind === 'ours_with_party' ? 'out' : third.kind === 'party_with_us' ? 'in' : null) : null;

  // Items.
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const itemRows = new Map(
    db
      .all<ItemInfo>(
        `SELECT i.id, i.name, i.is_service, i.maintain_batches, u.symbol AS unit, u.decimal_places AS decimals
           FROM stock_items i JOIN units u ON u.id = i.unit_id WHERE i.id IN (SELECT value FROM json_each(:ids))`,
        { ids: JSON.stringify(ids) },
      )
      .map((r) => [r.id, r]),
  );
  let products = 0;
  lines.forEach((l, i) => {
    const p = `${P}.lines[${i}]`;
    const item = itemRows.get(l.itemId);
    if (!item) {
      issues.push({ path: `${p}.itemId`, message: 'This stock item no longer exists. Select it again.' });
      return;
    }
    if (!allowed.includes(l.role)) {
      const what =
        cls === 'material_out'
          ? kind === 'ours_with_party'
            ? 'Material Out to a job worker sends material (transfer lines) only'
            : "Material Out from a principal's godown returns material (issue lines) only"
          : cls === 'material_in'
            ? kind === 'party_with_us'
              ? "Material In into a principal's godown receives material (receipt lines) only"
              : 'Material In from a job worker receives finished goods, by-products, scrap, unused material and consumes components'
            : 'A Manufacturing Journal has components, finished goods, by-products and scrap';
      issues.push({ path: `${p}.role`, message: `${item.name}: ${what}.` });
    }
    if (item.is_service === 1) issues.push({ path: `${p}.itemId`, message: `${item.name} is a service item and has no stock.` });
    if (!(l.qty > 0)) issues.push({ path: `${p}.qty`, message: `Enter the quantity of ${item.name}.` });
    const dp = Math.max(0, Math.min(6, item.decimals | 0));
    if (Math.abs(roundTo(l.qty, dp) - l.qty) > 1e-9) {
      issues.push({ path: `${p}.qty`, message: `${item.name}: ${l.qty} is not valid — ${item.unit} allows ${dp === 0 ? 'whole numbers only' : `at most ${dp} decimal places`}.` });
    }
    if (env.batches && item.maintain_batches === 1 && !(l.batchName ?? '').trim()) {
      issues.push({ path: `${p}.batchName`, message: `${item.name}: enter the batch — this item maintains batches.` });
    }
    if (l.godownId !== undefined) {
      const g = godowns.get(l.godownId);
      if (!g) issues.push({ path: `${p}.godownId`, message: 'The selected godown no longer exists.' });
      else if (third && l.role === 'transfer' && g.id === third.id) {
        issues.push({ path: `${p}.godownId`, message: `${item.name}: choose your own godown for this line (the job work godown is ${third.name}).` });
      } else if (third && l.role === 'transfer' && g.kind === 'party_with_us') {
        issues.push({ path: `${p}.godownId`, message: `${item.name}: ${g.name} holds a principal's stock, not yours.` });
      }
    }
    if (l.role === 'product') products++;
    if ((l.role === 'by_product' || l.role === 'scrap') && l.valueBasis === 'rate' && !(typeof l.valueRate === 'number' && l.valueRate >= 0)) {
      issues.push({ path: `${p}.valueRate`, message: `Enter the rate at which ${item.name} is valued.` });
    }
    if ((l.role === 'by_product' || l.role === 'scrap') && l.valueBasis === 'percent' && !(typeof l.valuePct === 'number' && l.valuePct > 0 && l.valuePct <= 100)) {
      issues.push({ path: `${p}.valuePct`, message: `Enter the share of the production cost (above 0% and up to 100%) carried by ${item.name}.` });
    }
  });
  const hasComponents = lines.some((l) => l.role === 'component');
  if (cls === 'manufacturing' && products !== 1) {
    issues.push({ path: `${P}.lines`, message: products === 0 ? 'Enter the finished goods produced (one product line).' : 'A Manufacturing Journal makes one finished item; enter other outputs as by-products or scrap.' });
  }
  if (cls === 'manufacturing' && !hasComponents) issues.push({ path: `${P}.lines`, message: 'Enter the components consumed to make the finished goods.' });
  if (cls === 'material_in' && products > 1) issues.push({ path: `${P}.lines`, message: 'Receive one finished item per Material In; enter other outputs as by-products or scrap.' });
  if (cls === 'material_in' && hasComponents && products === 0 && !lines.some((l) => l.role === 'by_product' || l.role === 'scrap')) {
    issues.push({ path: `${P}.lines`, message: 'Components consumed by the job worker need the finished goods received (a product line).' });
  }
  const pctTotal = lines.reduce((s, l) => s + ((l.role === 'by_product' || l.role === 'scrap') && l.valueBasis === 'percent' ? (l.valuePct ?? 0) : 0), 0);
  if (pctTotal > 100) issues.push({ path: `${P}.lines`, message: `By-products and scrap take ${roundTo(pctTotal, 2)}% of the cost; the total cannot exceed 100%.` });

  // Additional costs.
  const additional = block.additionalCosts ?? [];
  if (additional.length > 0 && !(cls === 'manufacturing' || (cls === 'material_in' && kind === 'ours_with_party'))) {
    issues.push({ path: `${P}.additionalCosts`, message: 'Additional costs apply to a Manufacturing Journal or to finished goods received from a job worker.' });
  }
  additional.forEach((a, i) => {
    const p = `${P}.additionalCosts[${i}]`;
    if (a.ledgerId !== undefined && db.value('SELECT 1 FROM ledgers WHERE id = :id', { id: a.ledgerId }) === undefined) {
      issues.push({ path: `${p}.ledgerId`, message: 'The selected ledger no longer exists.' });
    }
    if (a.ledgerId === undefined && !(a.label ?? '').trim()) issues.push({ path: `${p}.ledgerId`, message: 'Select the expense ledger (or name the cost).' });
    if (a.basis === 'amount' && !Number.isSafeInteger(a.value)) issues.push({ path: `${p}.value`, message: 'Enter the amount in rupees and paise.' });
    if (a.basis === 'percent' && a.value > 1000) issues.push({ path: `${p}.value`, message: 'A percentage of the consumed cost above 1000% is not plausible.' });
  });

  // BOM.
  let bomRevision: number | null = null;
  const productLine = lines.find((l) => l.role === 'product');
  if (block.bomId !== undefined) {
    const bom = db.get<{ item_id: number; name: string; revision: number }>('SELECT item_id, name, revision FROM boms WHERE id = :id', { id: block.bomId });
    if (!bom) issues.push({ path: `${P}.bomId`, message: 'The selected bill of materials no longer exists.' });
    else if (productLine && productLine.itemId !== bom.item_id) {
      issues.push({ path: `${P}.bomId`, message: `Bill of materials '${bom.name}' is for another item; select one of the finished item's BOMs.` });
    } else bomRevision = bom.revision;
  }

  // Job work order.
  if (block.jobWorkOrderId !== undefined) {
    const o = db.get<{ direction: string; party_ledger_id: number; number: string }>('SELECT direction, party_ledger_id, number FROM job_work_orders WHERE id = :id', {
      id: block.jobWorkOrderId,
    });
    if (!o) issues.push({ path: `${P}.jobWorkOrderId`, message: 'The selected job work order no longer exists.' });
    else if (cls === 'manufacturing') issues.push({ path: `${P}.jobWorkOrderId`, message: 'Link a job work order to a Material In or Material Out voucher.' });
    else if (input.partyLedgerId !== undefined && o.party_ledger_id !== input.partyLedgerId) {
      issues.push({ path: `${P}.jobWorkOrderId`, message: `Job work order ${o.number} belongs to another party.` });
    } else if (direction !== null && o.direction !== direction) {
      issues.push({
        path: `${P}.jobWorkOrderId`,
        message: `Job work order ${o.number} is a Job Work ${o.direction === 'out' ? 'Out' : 'In'} Order; this godown is for job work ${direction === 'out' ? 'given out' : 'received'}.`,
      });
    }
  }
  if (issues.length > 0) throw validation(issues);

  // Derive the item lines.
  const items: ItemLineInput[] = [];
  const derived: DerivedLine[] = [];
  const terms = new Map<number, ProductionTerm>();
  const thirdId = third?.id ?? main;
  const push = (blockIndex: number, l: StockJournalLineInput, role: DerivedRole, consume: boolean, godownId: number, extra: Partial<DerivedLine> = {}): number => {
    const lineNo = items.length + 1;
    const it: ItemLineInput = { itemId: l.itemId, qty: l.qty, rate: 0, godownId, isConsumption: consume || undefined };
    if (l.batchName) it.batchName = l.batchName;
    if (l.mfgDate) it.mfgDate = l.mfgDate;
    if (l.expiryDate) it.expiryDate = l.expiryDate;
    if (l.description) it.description = l.description;
    items.push(it);
    derived.push({
      lineNo,
      blockIndex,
      role,
      isConsumption: consume,
      basis: null,
      pct: null,
      sourceLineNo: null,
      goodsType: null,
      challanValue: null,
      extendedTo: null,
      ...extra,
    });
    return lineNo;
  };
  const jw = (l: StockJournalLineInput): Partial<DerivedLine> =>
    third ? { goodsType: l.goodsType ?? 'inputs', extendedTo: l.extendedTo ?? null } : {};
  lines.forEach((l, i) => {
    switch (l.role) {
      case 'component':
        push(i, l, 'component', true, l.godownId ?? (cls === 'material_in' && third ? third.id : main), jw(l));
        break;
      case 'product':
        push(i, l, 'product', false, l.godownId ?? main, { basis: 'residual' });
        break;
      case 'by_product':
      case 'scrap': {
        const basis = l.valueBasis ?? 'nil';
        push(i, l, l.role, false, l.godownId ?? main, basis === 'percent' ? { basis: 'percent', pct: l.valuePct ?? 0 } : { basis: 'fixed' });
        if (basis === 'rate') {
          const it = items[items.length - 1];
          it.rate = l.valueRate ?? 0;
          it.amount = lineAmount(l.qty, l.valueRate ?? 0);
        } else if (basis === 'nil') items[items.length - 1].amount = 0;
        break;
      }
      case 'transfer': {
        const own = l.godownId ?? main;
        const outward = cls === 'material_out';
        const src = push(i, l, 'transfer_out', true, outward ? own : thirdId, jw(l));
        push(i, l, 'transfer_in', false, outward ? thirdId : own, { basis: 'source', sourceLineNo: src, ...jw(l) });
        break;
      }
      case 'receipt':
        push(i, l, 'receipt', false, thirdId, { basis: 'fixed', ...jw(l) });
        items[items.length - 1].amount = l.rate !== undefined ? lineAmount(l.qty, l.rate) : 0;
        break;
      case 'issue':
        push(i, l, 'issue', true, thirdId, jw(l));
        break;
    }
  });
  for (const d of derived) if (d.basis !== null) terms.set(d.lineNo, { basis: d.basis, pct: d.pct, sourceLineNo: d.sourceLineNo });

  // Cost estimate at entry time (the engine recomputes the real figures from the books).
  const consumption = derived.filter((d) => d.isConsumption);
  const costs = estimateIssueCosts(db, {
    asOf: input.date,
    today: env.today,
    excludeVoucherId: voucherId,
    lines: consumption.map((d) => ({ itemId: items[d.lineNo - 1].itemId, qty: items[d.lineNo - 1].qty, godownId: items[d.lineNo - 1].godownId ?? null })),
  });
  const costByLine = new Map<number, number>();
  consumption.forEach((d, k) => costByLine.set(d.lineNo, costs[k]));
  const ownGodown = (d: DerivedLine): boolean => (godowns.get(items[d.lineNo - 1].godownId ?? main)?.kind ?? 'none') !== 'party_with_us';
  const cost = costJournal({
    consumption: consumption.filter(ownGodown).map((d) => ({ lineNo: d.lineNo, qty: items[d.lineNo - 1].qty, cost: costByLine.get(d.lineNo) ?? 0 })),
    production: derived
      .filter((d) => !d.isConsumption && ownGodown(d))
      .map((d) => ({ lineNo: d.lineNo, qty: items[d.lineNo - 1].qty, amount: items[d.lineNo - 1].amount ?? 0 })),
    terms,
    additional: additional.map((a) => ({ basis: a.basis, value: a.value })),
  });

  // Amounts shown on the voucher (Day Book, print) are the estimate — the engine values the lines from
  // the books. A job work challan line with a declared rate carries that rate instead.
  const lineValues: Array<number | null> = lines.map(() => null);
  for (const d of derived) {
    const it = items[d.lineNo - 1];
    const bl = lines[d.blockIndex];
    let value: number;
    if (d.isConsumption) value = costByLine.get(d.lineNo) ?? 0;
    else if (cost.values.has(d.lineNo)) value = cost.values.get(d.lineNo) ?? 0;
    else value = it.amount ?? 0;
    const declared = third && bl.rate !== undefined && d.role !== 'product' && d.role !== 'by_product' && d.role !== 'scrap';
    if (declared) {
      it.rate = bl.rate as number;
      it.amount = lineAmount(bl.qty, bl.rate as number);
    } else if (d.basis !== 'fixed') {
      it.amount = Math.max(0, value);
      it.rate = it.qty > 0 ? roundTo(it.amount / it.qty / 100, 4) : 0;
    }
    if (third && d.role !== 'product' && d.role !== 'by_product' && d.role !== 'scrap') {
      // The value declared on the challan / in ITC-04: the rate entered, else the estimated cost.
      const src = d.role === 'transfer_in' && d.sourceLineNo !== null ? (costByLine.get(d.sourceLineNo) ?? 0) : value;
      d.challanValue = declared ? lineAmount(bl.qty, bl.rate as number) : src;
    }
    if (d.role !== 'transfer_in') lineValues[d.blockIndex] = value;
  }

  const product = derived.find((d) => d.role === 'product');
  const productQty = product ? items[product.lineNo - 1].qty : 0;
  const productValue = product ? (cost.values.get(product.lineNo) ?? 0) : 0;
  const estimate: StockJournalCostPreview = {
    class: cls,
    consumed: cost.consumed,
    transferred: cost.transferred,
    additional: cost.additional,
    additionalValues: cost.additionalValues,
    byProducts: cost.byProducts,
    productValue,
    productQty,
    productRate: productQty > 0 ? roundTo(productValue / productQty / 100, 4) : 0,
    shortfall: cost.shortfall,
    lineValues,
    jobWorkDirection: direction,
  };
  return {
    cls,
    items,
    derived,
    terms,
    thirdParty: third,
    direction,
    productItemId: productLine?.itemId ?? null,
    productQty: productLine?.qty ?? null,
    bomRevision,
    estimate,
    cost,
  };
}

/** "5 Nos" with the item's unit, for messages. */
export function qtyLabel(db: Db, itemId: number, qty: number): string {
  const u = db.get<{ symbol: string; decimals: number }>(
    'SELECT u.symbol, u.decimal_places AS decimals FROM stock_items i JOIN units u ON u.id = i.unit_id WHERE i.id = :id',
    { id: itemId },
  );
  return formatQty(qty, u?.decimals ?? 2, u?.symbol);
}
