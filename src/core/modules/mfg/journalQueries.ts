/**
 * Read side of the classed stock journals: the entry context, a journal for alteration / duplication,
 * and the Production Register (manufacturing / job work receipts with the engine's own figures).
 */
import { explodeBom } from '../../../shared/mfg/bom.ts';
import { costJournal, type AdditionalCostTerm, type ProductionTerm } from '../../../shared/mfg/costing.ts';
import { roundPaise, roundTo } from '../../../shared/money.ts';
import type {
  GodownKindRow,
  MfgJournalContext,
  MfgJournalDetail,
  ProductionRegisterInput,
  ProductionRegisterResult,
  ProductionRegisterRow,
  StockJournalClass,
  StockJournalExtInput,
  StockJournalTypeRow,
} from '../../../shared/types/mfg.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { currentUnitCosts, traceStockMovements } from '../inventory/valuation.ts';
import { loadVoucherType } from '../vouchers/numbering.ts';
import { loadVoucherRow, nextVoucherNumber, storedInput } from '../vouchers/service.ts';
import { getBom } from './bom.ts';
import { stockJournalClassOf } from './voucherTypes.ts';

export function classedTypes(db: Db, includeInactive = false): StockJournalTypeRow[] {
  return db
    .all<{ id: number; name: string; config: string; is_active: number }>(
      `SELECT id, name, config, is_active FROM voucher_types WHERE base_type = 'stock_journal' ORDER BY name COLLATE NOCASE`,
    )
    .map((r) => {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(r.config) as Record<string, unknown>;
      } catch {
        cfg = {};
      }
      const cls = stockJournalClassOf(cfg);
      return cls ? { id: r.id, name: r.name, class: cls, isActive: r.is_active === 1 } : null;
    })
    .filter((r): r is StockJournalTypeRow => r !== null && (includeInactive || r.isActive));
}

export function godownKinds(db: Db): GodownKindRow[] {
  return db
    .all<{ id: number; name: string; kind: GodownKindRow['kind']; party_ledger_id: number | null; party_name: string | null }>(
      `SELECT g.id, g.name, g.third_party_kind AS kind, g.party_ledger_id, l.name AS party_name
         FROM godowns g LEFT JOIN ledgers l ON l.id = g.party_ledger_id
        ORDER BY g.is_predefined DESC, g.name COLLATE NOCASE`,
    )
    .map((g) => ({ id: g.id, name: g.name, kind: g.kind, partyLedgerId: g.party_ledger_id, partyName: g.party_name }));
}

function classOfType(db: Db, voucherTypeId: number): { cls: StockJournalClass; row: StockJournalTypeRow } {
  const vt = loadVoucherType(db, voucherTypeId);
  const cls = vt.baseType === 'stock_journal' ? stockJournalClassOf(vt.config) : null;
  if (!cls) {
    throw validation([{ path: 'voucherTypeId', message: `${vt.name} is not a Manufacturing Journal, Material In or Material Out voucher type.` }]);
  }
  return { cls, row: { id: vt.id, name: vt.name, class: cls, isActive: vt.isActive } };
}

export function journalContext(ctx: CompanyCtx, input: { voucherTypeId: number; date: string }): MfgJournalContext {
  const { db } = ctx;
  const { row } = classOfType(db, input.voucherTypeId);
  return {
    voucherType: row,
    types: classedTypes(db),
    godowns: godownKinds(db),
    nextNumber: nextVoucherNumber(ctx, input.voucherTypeId, input.date) || null,
    mainGodownId: db.value<number>('SELECT id FROM godowns WHERE is_predefined = 1 ORDER BY id LIMIT 1') ?? 0,
  };
}

/** The block as entered; vouchers saved without one (imported) are read back from their lines. */
export function getJournal(ctx: CompanyCtx, id: number): MfgJournalDetail {
  const { db } = ctx;
  const row = loadVoucherRow(db, id);
  if (!row) throw notFound('Voucher', id);
  const { cls } = classOfType(db, row.voucher_type_id);
  const input = storedInput(db, row);
  let block: StockJournalExtInput | undefined = input.stockJournal;
  if (!block) {
    let product = false;
    block = {
      lines: (input.items ?? []).map((it) => {
        const role = it.isConsumption ? 'component' : product ? 'by_product' : 'product';
        if (role === 'product') product = true;
        return { role, itemId: it.itemId, qty: it.qty, godownId: it.godownId, batchName: it.batchName, ...(role === 'by_product' ? { valueBasis: 'rate' as const, valueRate: it.rate } : {}) };
      }),
    };
  }
  const itemIds = [...new Set(block.lines.map((l) => l.itemId))];
  const ledgerIds = [...new Set([...(block.additionalCosts ?? []).map((c) => c.ledgerId).filter((x): x is number => typeof x === 'number'), ...(row.party_ledger_id ? [row.party_ledger_id] : [])])];
  return {
    id: row.id,
    voucherTypeId: row.voucher_type_id,
    class: cls,
    date: row.date,
    number: row.number,
    partyLedgerId: row.party_ledger_id,
    narration: row.narration,
    isOptional: row.is_optional === 1,
    isPostDated: row.is_post_dated === 1,
    referenceNo: row.reference_no,
    block,
    updatedAt: row.updated_at,
    items: db.all<{ id: number; name: string; unit: string; decimals: number }>(
      `SELECT i.id, i.name, u.symbol AS unit, u.decimal_places AS decimals FROM stock_items i JOIN units u ON u.id = i.unit_id
        WHERE i.id IN (SELECT value FROM json_each(:ids))`,
      { ids: JSON.stringify(itemIds) },
    ),
    ledgers: db.all<{ id: number; name: string }>('SELECT id, name FROM ledgers WHERE id IN (SELECT value FROM json_each(:ids))', { ids: JSON.stringify(ledgerIds) }),
    bomName: block.bomId !== undefined ? (db.value<string>('SELECT name FROM boms WHERE id = :id', { id: block.bomId }) ?? null) : null,
    orderNumber: block.jobWorkOrderId !== undefined ? (db.value<string>('SELECT number FROM job_work_orders WHERE id = :id', { id: block.jobWorkOrderId }) ?? null) : null,
  };
}

/** A copy of a journal for a new voucher dated `date` (Alt+2): no id, number or extension dates. */
export function duplicateJournal(ctx: CompanyCtx, id: number): MfgJournalDetail {
  const src = getJournal(ctx, id);
  return {
    ...src,
    id: null,
    number: null,
    date: ctx.clock.today(),
    updatedAt: null,
    isOptional: false,
    isPostDated: false,
    // The job worker's / principal's challan number belongs to the source voucher only.
    referenceNo: null,
    block: { ...src.block, lines: src.block.lines.map((l) => ({ ...l, extendedTo: undefined })) },
  };
}

// ───────────────────────────── Production register ─────────────────────────────

interface DetailRow {
  voucher_id: number;
  class: StockJournalClass;
  item_id: number | null;
  qty: number | null;
  bom_id: number | null;
  date: string;
  number: string | null;
  type_name: string;
  party_name: string | null;
  item_name: string | null;
  unit: string | null;
  bom_name: string | null;
}

/**
 * Manufacturing Journals and finished goods received from job workers in the period, with the values
 * the stock engine gives them (the costing rule applied to the components' issue cost at their place in
 * the replay — identical to the Stock Summary), and the BOM estimate at today's costs for comparison.
 */
export function productionRegister(ctx: CompanyCtx, input: ProductionRegisterInput): ProductionRegisterResult {
  const { db } = ctx;
  const today = ctx.clock.today();
  if (input.from > input.to) throw rule('The period starts after it ends. Choose the period again (Alt+F2).');
  const conds = ['d.date BETWEEN :from AND :to', 'd.affects_stock = 1', '(d.is_post_dated = 0 OR d.date <= :today)', 'd.item_id IS NOT NULL'];
  const params: Record<string, string | number> = { from: input.from, to: input.to, today };
  if (input.itemId !== undefined) {
    conds.push('d.item_id = :itemId');
    params.itemId = input.itemId;
  }
  if (input.bomId !== undefined) {
    conds.push('d.bom_id = :bomId');
    params.bomId = input.bomId;
  }
  if (input.class !== undefined) {
    conds.push('d.class = :cls');
    params.cls = input.class;
  }
  const details = db.all<DetailRow>(
    `SELECT d.voucher_id, d.class, d.item_id, d.qty, d.bom_id, d.date, v.number, vt.name AS type_name, v.party_name,
            i.name AS item_name, u.symbol AS unit, b.name AS bom_name
       FROM stock_journal_details d
       JOIN vouchers v ON v.id = d.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN stock_items i ON i.id = d.item_id
       LEFT JOIN units u ON u.id = i.unit_id
       LEFT JOIN boms b ON b.id = d.bom_id
      WHERE ${conds.join(' AND ')}
      ORDER BY d.date, d.voucher_id`,
    params,
  );
  const totals = { consumed: 0, additional: 0, byProducts: 0, productValue: 0 };
  if (details.length === 0) return { from: input.from, to: input.to, rows: [], totals };

  const vids = JSON.stringify(details.map((d) => d.voucher_id));
  const lines = db.all<{ id: number; voucher_id: number; line_no: number; item_id: number; qty: number; amount: number; role: string; basis: ProductionTerm['basis'] | null; pct: number | null; source_line_no: number | null; third: number }>(
    `SELECT ie.id, ie.voucher_id, ie.line_no, ie.item_id, ie.qty, ie.amount, l.role, l.basis, l.pct, l.source_line_no,
            CASE WHEN g.third_party_kind = 'party_with_us' THEN 1 ELSE 0 END AS third
       FROM inventory_entries ie
       JOIN stock_journal_lines l ON l.voucher_id = ie.voucher_id AND l.line_no = ie.line_no
       LEFT JOIN godowns g ON g.id = ie.godown_id
      WHERE ie.voucher_id IN (SELECT value FROM json_each(:vids))
      ORDER BY ie.voucher_id, ie.line_no`,
    { vids },
  );
  const costs = db.all<{ voucher_id: number; basis: AdditionalCostTerm['basis']; value: number }>(
    'SELECT voucher_id, basis, value FROM stock_journal_costs WHERE voucher_id IN (SELECT value FROM json_each(:vids)) ORDER BY voucher_id, line_no',
    { vids },
  );
  // Lines and costs by voucher (one pass each — no per-voucher scan of every line).
  const linesBy = new Map<number, typeof lines>();
  for (const l of lines) {
    if (l.third !== 0) continue;
    const list = linesBy.get(l.voucher_id);
    if (list) list.push(l);
    else linesBy.set(l.voucher_id, [l]);
  }
  const costsBy = new Map<number, AdditionalCostTerm[]>();
  for (const c of costs) {
    const list = costsBy.get(c.voucher_id) ?? [];
    list.push({ basis: c.basis, value: Number(c.value) });
    costsBy.set(c.voucher_id, list);
  }
  const itemIds = [...new Set(lines.map((l) => l.item_id))];
  // One replay: the cost the engine gave every consumption line of these journals.
  const trace = traceStockMovements(db, { from: input.from, to: input.to, today, itemIds, traceItemIds: itemIds });

  // BOM estimate at today's cost (standard vs actual).
  const boms = new Map<number, ReturnType<typeof getBom>>();
  for (const d of details) if (d.bom_id !== null && !boms.has(d.bom_id)) boms.set(d.bom_id, getBom(db, d.bom_id));
  const bomItems = [...new Set([...boms.values()].flatMap((b) => b.lines.filter((l) => l.kind === 'component').map((l) => l.itemId)))];
  const rates = currentUnitCosts(db, { itemIds: bomItems, asOf: today, today });

  const rows: ProductionRegisterRow[] = details.map((d) => {
    const own = linesBy.get(d.voucher_id) ?? [];
    const terms = new Map<number, ProductionTerm>();
    for (const l of own) if (l.basis) terms.set(l.line_no, { basis: l.basis, pct: l.pct, sourceLineNo: l.source_line_no });
    const res = costJournal({
      consumption: own.filter((l) => l.qty < 0).map((l) => ({ lineNo: l.line_no, qty: -l.qty, cost: trace.values.get(l.id) ?? 0 })),
      production: own.filter((l) => l.qty > 0).map((l) => ({ lineNo: l.line_no, qty: l.qty, amount: Math.abs(Number(l.amount)) })),
      terms,
      additional: costsBy.get(d.voucher_id) ?? [],
    });
    const product = own.find((l) => l.role === 'product');
    const productValue = product ? (trace.values.get(product.id) ?? 0) : 0;
    const qty = Number(d.qty ?? 0);
    let bomEstimate: number | null = null;
    const bom = d.bom_id !== null ? boms.get(d.bom_id) : undefined;
    if (bom && qty > 0) {
      let est = 0;
      let comp = 0;
      for (const e of explodeBom(bom.lines, bom.outputQty, qty)) {
        if (e.line.kind === 'component') comp += roundPaise(e.qty * (rates.get(e.line.itemId) ?? 0) * 100);
      }
      est = comp;
      for (const e of explodeBom(bom.lines, bom.outputQty, qty)) {
        if (e.line.kind === 'component') continue;
        if (e.line.valueBasis === 'rate') est -= roundPaise(e.qty * (e.line.valueRate ?? 0) * 100);
        else if (e.line.valueBasis === 'percent') est -= roundPaise((comp * (e.line.valuePct ?? 0)) / 100);
      }
      bomEstimate = Math.max(0, est);
    }
    totals.consumed += res.consumed;
    totals.additional += res.additional;
    totals.byProducts += res.byProducts;
    totals.productValue += productValue;
    return {
      voucherId: d.voucher_id,
      date: d.date,
      number: d.number,
      typeName: d.type_name,
      class: d.class,
      itemId: d.item_id,
      itemName: d.item_name,
      unit: d.unit,
      qty,
      bomName: d.bom_name,
      partyName: d.party_name,
      consumed: res.consumed,
      additional: res.additional,
      byProducts: res.byProducts,
      productValue,
      productRate: qty > 0 ? roundTo(productValue / qty / 100, 4) : 0,
      bomEstimate,
    };
  });
  return { from: input.from, to: input.to, rows, totals };
}
