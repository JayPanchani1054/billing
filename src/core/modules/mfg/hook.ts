/**
 * The mfg module's voucher hook (vouchers/hooks.ts): Manufacturing Journal / Material Out / Material In.
 *
 *   compose  a stock journal type with a class (voucher_types.config.stockJournalClass) and a
 *            `stockJournal` block → the item lines are derived from the block (journal.ts); the cost
 *            estimate is kept for adjust() / preview(). A plain stock journal is left alone.
 *   adjust   confirm-level warnings (party ≠ the godown's party, closed order, by-products worth more
 *            than the cost) and the data for write().
 *   write    stock_journal_details / stock_journal_lines / stock_journal_costs, in the save transaction;
 *            the valuation engine reads the costing basis from stock_journal_lines.
 *   clear    removes those rows (alter, cancel, delete).
 *   preview  VoucherPreview.stockJournal = the costing estimate.
 * A cheap no-op for every other voucher.
 */
import type { StockJournalCostPreview } from '../../../shared/types/mfg.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import type { VoucherHook } from '../vouchers/hooks.ts';
import { composeJournal, type ComposedJournal } from './journal.ts';
import { stockJournalClassOf } from './voucherTypes.ts';

/** Composed journals by the input object compose() returned (what posting and adjust() receive). */
const composed = new WeakMap<VoucherInput, ComposedJournal>();

interface WriteData {
  journal: ComposedJournal;
  input: VoucherInput;
}

export function clearJournalRows(db: Db, voucherId: number): void {
  db.run('DELETE FROM stock_journal_lines WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM stock_journal_costs WHERE voucher_id = :id', { id: voucherId });
  db.run('DELETE FROM stock_journal_details WHERE voucher_id = :id', { id: voucherId });
}

export const mfgVoucherHook: VoucherHook = {
  name: 'mfg',

  compose(env, input, vt, voucherId) {
    const cls = vt.baseType === 'stock_journal' ? stockJournalClassOf(vt.config) : null;
    if (!input.stockJournal) return undefined;
    if (!cls) {
      throw validation([
        { path: 'stockJournal', message: `${vt.name} is not a Manufacturing Journal, Material In or Material Out voucher type; enter its item lines directly.` },
      ]);
    }
    const journal = composeJournal(
      env.db,
      { today: env.today, batches: env.features.batches, manufacturing: env.features.manufacturing, jobWork: env.features.jobWork },
      cls,
      input,
      input.stockJournal,
      voucherId,
    );
    const out: VoucherInput = { ...input, mode: 'inventory', items: journal.items };
    delete out.ledgers;
    composed.set(out, journal);
    return out;
  },

  adjust(ctx) {
    const journal = composed.get(ctx.input);
    if (!journal) return;
    const { db } = ctx.env;
    const block = ctx.input.stockJournal;
    const third = journal.thirdParty;
    if (third && third.partyLedgerId !== null && ctx.party && third.partyLedgerId !== ctx.party.id) {
      const owner = db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id: third.partyLedgerId }) ?? 'another party';
      ctx.warn('mfg', `${third.name} is the godown of ${owner}, not of ${ctx.party.name}. Check the party or the godown.`, 'confirm', 'stockJournal.thirdPartyGodownId');
    }
    if (block?.jobWorkOrderId !== undefined) {
      const o = db.get<{ number: string; status: string }>('SELECT number, status FROM job_work_orders WHERE id = :id', { id: block.jobWorkOrderId });
      if (o?.status === 'closed') ctx.warn('mfg', `Job work order ${o.number} is closed.`, 'confirm', 'stockJournal.jobWorkOrderId');
    }
    if (journal.cost.shortfall > 0) {
      ctx.warn(
        'mfg',
        `By-products and scrap are valued at ${formatMoney(journal.cost.byProducts, { symbol: true })}, more than the cost of production (${formatMoney(journal.cost.pool, { symbol: true })}); the finished goods would be valued at nil. Reduce their value.`,
        'confirm',
        'stockJournal.lines',
      );
    }
    for (const l of block?.lines ?? []) {
      if (l.extendedTo && l.extendedTo <= ctx.date) {
        ctx.warn('mfg', `The extended return date ${formatDate(l.extendedTo)} is not after the challan date.`, 'confirm', 'stockJournal.lines');
        break;
      }
    }
    ctx.setData({ journal, input: ctx.input } satisfies WriteData);
  },

  write({ db, voucherId, plan, date, isPostDated, data }) {
    // Rows of an altered voucher were removed by clear() with its other child rows.
    const d = data as WriteData | undefined;
    if (!d) return;
    const { journal, input } = d;
    const block = input.stockJournal;
    if (!block) return;
    const affectsStock = plan.header.affectsStock && !plan.header.isOptional;
    db.run(
      `INSERT INTO stock_journal_details (voucher_id, class, item_id, qty, bom_id, bom_revision, party_ledger_id, job_work_order_id,
              third_party_godown_id, job_work_direction, process, date, affects_stock, is_post_dated)
       VALUES (:id, :cls, :itemId, :qty, :bomId, :bomRevision, :party, :order, :godown, :direction, :process, :date, :stock, :pdc)`,
      {
        id: voucherId,
        cls: journal.cls,
        itemId: journal.productItemId,
        qty: journal.productQty,
        bomId: block.bomId ?? null,
        bomRevision: journal.bomRevision,
        party: plan.header.partyLedgerId,
        order: block.jobWorkOrderId ?? null,
        godown: journal.thirdParty?.id ?? null,
        direction: journal.direction,
        process: block.process?.trim() || null,
        date,
        stock: affectsStock,
        pdc: isPostDated,
      },
    );
    for (const l of journal.derived) {
      db.run(
        `INSERT INTO stock_journal_lines (voucher_id, line_no, role, basis, pct, source_line_no, goods_type, challan_value, extended_to)
         VALUES (:id, :lineNo, :role, :basis, :pct, :src, :goods, :challan, :ext)`,
        {
          id: voucherId,
          lineNo: l.lineNo,
          role: l.role,
          basis: l.basis,
          pct: l.pct,
          src: l.sourceLineNo,
          goods: l.goodsType,
          challan: l.challanValue,
          ext: l.extendedTo,
        },
      );
    }
    (block.additionalCosts ?? []).forEach((a, i) => {
      db.run(
        `INSERT INTO stock_journal_costs (voucher_id, line_no, ledger_id, label, basis, value)
         VALUES (:id, :lineNo, :ledgerId, :label, :basis, :value)`,
        { id: voucherId, lineNo: i + 1, ledgerId: a.ledgerId ?? null, label: a.label?.trim() || null, basis: a.basis, value: a.value },
      );
    });
  },

  clear(db, voucherId) {
    clearJournalRows(db, voucherId);
  },

  preview(data) {
    const d = data as WriteData | undefined;
    if (!d) return {};
    const estimate: StockJournalCostPreview = d.journal.estimate;
    return { stockJournal: estimate };
  },
};
