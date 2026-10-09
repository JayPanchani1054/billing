/** Input schemas of the mfg module (also the `stockJournal` block of VoucherInput, see vouchers/routes.ts). */
import { ADDITIONAL_COST_BASES } from '../../../shared/mfg/costing.ts';
import { JOB_WORK_GOODS_TYPES } from '../../../shared/mfg/jobwork.ts';
import { BOM_LINE_KINDS, BOM_VALUE_BASES, STOCK_JOURNAL_CLASSES, STOCK_JOURNAL_ROLES, type BomSaveInput, type JobWorkOrderSaveInput, type StockJournalExtInput } from '../../../shared/types/mfg.ts';
import { v, type Schema } from '../../lib/validate.ts';

const optText = (max: number): Schema<string | undefined> => v.string({ max }).optional();
const QTY = { min: 0, max: 1e12 };

export const StockJournalLineSchema = v.object({
  role: v.enum(STOCK_JOURNAL_ROLES),
  itemId: v.id(),
  qty: v.number(QTY),
  godownId: v.id().optional(),
  batchName: optText(100),
  mfgDate: v.date().optional(),
  expiryDate: v.date().optional(),
  valueBasis: v.enum(BOM_VALUE_BASES).optional(),
  valueRate: v.number({ min: 0, max: 1e12 }).optional(),
  valuePct: v.number({ min: 0, max: 100 }).optional(),
  goodsType: v.enum(JOB_WORK_GOODS_TYPES).optional(),
  rate: v.number({ min: 0, max: 1e12 }).optional(),
  extendedTo: v.date().optional(),
  description: optText(1000),
});

export const AdditionalCostSchema = v.object({
  ledgerId: v.id().optional(),
  label: optText(100),
  basis: v.enum(ADDITIONAL_COST_BASES),
  value: v.number({ min: 0, max: 9e14 }),
});

export const StockJournalExtSchema = v.object({
  bomId: v.id().optional(),
  thirdPartyGodownId: v.id().optional(),
  jobWorkOrderId: v.id().optional(),
  process: optText(200),
  lines: v.array(StockJournalLineSchema, { max: 2000 }),
  additionalCosts: v.array(AdditionalCostSchema, { max: 50 }).optional(),
}) as unknown as Schema<StockJournalExtInput>;

export const BomLineSchema = v.object({
  kind: v.enum(BOM_LINE_KINDS),
  itemId: v.id(),
  qty: v.number(QTY),
  godownId: v.id().nullable().optional(),
  valueBasis: v.enum(BOM_VALUE_BASES).nullable().optional(),
  valueRate: v.number({ min: 0, max: 1e12 }).nullable().optional(),
  valuePct: v.number({ min: 0, max: 100 }).nullable().optional(),
  notes: v.string({ max: 500 }).nullable().optional(),
});

export const BomSaveSchema = v.object({
  id: v.id().optional(),
  itemId: v.id(),
  name: v.string({ max: 100 }),
  outputQty: v.number(QTY),
  isDefault: v.boolean().optional(),
  isActive: v.boolean().optional(),
  notes: v.string({ max: 2000 }).nullable().optional(),
  lines: v.array(BomLineSchema, { max: 1000 }),
  expectedUpdatedAt: optText(40),
}) as unknown as Schema<BomSaveInput>;

export const JobWorkOrderSaveSchema = v.object({
  id: v.id().optional(),
  direction: v.enum(['out', 'in'] as const),
  number: optText(30),
  date: v.date(),
  partyLedgerId: v.id(),
  godownId: v.id().nullable().optional(),
  itemId: v.id().nullable().optional(),
  qty: v.number(QTY).nullable().optional(),
  bomId: v.id().nullable().optional(),
  dueDate: v.date().nullable().optional(),
  process: v.string({ max: 200 }).nullable().optional(),
  rate: v.number({ min: 0, max: 1e12 }).nullable().optional(),
  status: v.enum(['open', 'closed'] as const).optional(),
  narration: v.string({ max: 2000 }).nullable().optional(),
  lines: v.array(v.object({ itemId: v.id(), qty: v.number(QTY), goodsType: v.enum(JOB_WORK_GOODS_TYPES).optional() }), { max: 500 }),
  expectedUpdatedAt: optText(40),
}) as unknown as Schema<JobWorkOrderSaveInput>;

export const StockJournalClassSchema = v.enum(STOCK_JOURNAL_CLASSES);
