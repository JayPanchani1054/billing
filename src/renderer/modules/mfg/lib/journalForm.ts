/**
 * Manufacturing Journal / Material Out / Material In entry form — pure state and mapping (tested in
 * journalForm.test.ts). The screen keeps a JournalForm; `toVoucherInput` builds the VoucherInput with
 * the `stockJournal` block the core composes into stock journal lines (mfg/journal.ts).
 */
import { explodeBom } from '../../../../shared/mfg/bom.ts';
import type { JobWorkGoodsType } from '../../../../shared/mfg/jobwork.ts';
import type { Paise } from '../../../../shared/money.ts';
import type {
  BomDetail,
  BomValueBasis,
  MfgJournalDetail,
  StockJournalClass,
  StockJournalExtInput,
  StockJournalLineInput,
  StockJournalRole,
  ThirdPartyKind,
} from '../../../../shared/types/mfg.ts';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';

export interface JournalRow {
  key: string;
  role: StockJournalRole;
  itemId: number | null;
  itemName: string;
  unit: string;
  decimals: number;
  qty: number | null;
  godownId: number | null;
  batchName: string;
  valueBasis: BomValueBasis;
  valueRate: number | null;
  valuePct: number | null;
  goodsType: JobWorkGoodsType;
  /** Job work challan rate (₹/unit); null = estimated cost. */
  rate: number | null;
  extendedTo: string | null;
}

export interface CostRow {
  key: string;
  ledgerId: number | null;
  label: string;
  basis: 'amount' | 'percent';
  amount: Paise | null;
  pct: number | null;
}

export interface JournalForm {
  cls: StockJournalClass;
  voucherTypeId: number;
  date: string;
  number: string;
  partyLedgerId: number | null;
  thirdPartyGodownId: number | null;
  jobWorkOrderId: number | null;
  bomId: number | null;
  process: string;
  narration: string;
  /** The job worker's / principal's own challan number (Material In / Out; ITC-04 table 5A). */
  referenceNo: string;
  /** Optional voucher (Ctrl+L): kept on alteration, never silently made regular. */
  isOptional: boolean;
  /** Post-dated (Ctrl+T). */
  isPostDated: boolean;
  rows: JournalRow[];
  costs: CostRow[];
}

/** Which parts of the form a journal shows, by class and the kind of the job work godown. */
export interface JournalSections {
  /** Finished goods, by-products and scrap. */
  products: boolean;
  components: boolean;
  /** Role of the plain material lines, or null. */
  material: 'transfer' | 'receipt' | 'issue' | null;
  costs: boolean;
  /** A job work godown must be chosen first (Material In / Out). */
  needsGodown: boolean;
}

export function sectionsFor(cls: StockJournalClass, kind: ThirdPartyKind | null): JournalSections {
  if (cls === 'manufacturing') return { products: true, components: true, material: null, costs: true, needsGodown: false };
  if (kind === null || kind === 'none') return { products: false, components: false, material: null, costs: false, needsGodown: true };
  if (cls === 'material_out') return { products: false, components: false, material: kind === 'ours_with_party' ? 'transfer' : 'issue', costs: false, needsGodown: false };
  return kind === 'ours_with_party'
    ? { products: true, components: true, material: 'transfer', costs: true, needsGodown: false }
    : { products: false, components: false, material: 'receipt', costs: false, needsGodown: false };
}

let seq = 0;
export const newKey = (prefix = 'r'): string => `${prefix}${++seq}`;

export function blankRow(role: StockJournalRole, over: Partial<JournalRow> = {}): JournalRow {
  return {
    key: newKey(),
    role,
    itemId: null,
    itemName: '',
    unit: '',
    decimals: 0,
    qty: null,
    godownId: null,
    batchName: '',
    valueBasis: role === 'scrap' || role === 'by_product' ? 'rate' : 'nil',
    valueRate: null,
    valuePct: null,
    goodsType: 'inputs',
    rate: null,
    extendedTo: null,
    ...over,
  };
}

export function blankCost(over: Partial<CostRow> = {}): CostRow {
  return { key: newKey('c'), ledgerId: null, label: '', basis: 'amount', amount: null, pct: null, ...over };
}

export function emptyForm(cls: StockJournalClass, voucherTypeId: number, date: string): JournalForm {
  return {
    cls,
    voucherTypeId,
    date,
    number: '',
    partyLedgerId: null,
    thirdPartyGodownId: null,
    jobWorkOrderId: null,
    bomId: null,
    process: '',
    narration: '',
    referenceNo: '',
    isOptional: false,
    isPostDated: false,
    rows: cls === 'manufacturing' ? [blankRow('product'), blankRow('component')] : [],
    costs: [],
  };
}

/** Rows of one section, in order. */
export function rowsOf(form: JournalForm, roles: readonly StockJournalRole[]): JournalRow[] {
  return form.rows.filter((r) => roles.includes(r.role));
}

export const PRODUCT_ROLES: readonly StockJournalRole[] = ['product', 'by_product', 'scrap'];
export const MATERIAL_ROLES: readonly StockJournalRole[] = ['transfer', 'receipt', 'issue'];

/** A row worth sending (an item and a quantity). */
export const isFilled = (r: JournalRow): boolean => r.itemId !== null && r.qty !== null && r.qty > 0;

/**
 * Replace the components / by-products / scrap with the BOM's lines for `qty` of the product, keeping
 * the product row (its quantity) and any material rows. Component godowns: the BOM's, else `componentGodownId`
 * (Material In: none — consumed at the job worker's godown).
 */
export function applyBom(form: JournalForm, bom: BomDetail, qty: number, componentGodownId: number | null): JournalForm {
  const product = form.rows.find((r) => r.role === 'product') ?? blankRow('product');
  const kept = form.rows.filter((r) => MATERIAL_ROLES.includes(r.role));
  const exploded = explodeBom(bom.lines, bom.outputQty, qty);
  const lines: JournalRow[] = exploded.map((e) =>
    blankRow(e.line.kind === 'component' ? 'component' : e.line.kind, {
      itemId: e.line.itemId,
      itemName: e.line.itemName,
      unit: e.line.unit,
      decimals: e.line.unitDecimals,
      qty: e.qty,
      // Material In: components are consumed at the job worker's godown (the core's default), never at
      // the BOM's own default godown.
      godownId: e.line.kind === 'component' && form.cls === 'material_in' ? null : (e.line.godownId ?? (e.line.kind === 'component' ? componentGodownId : null)),
      valueBasis: e.line.valueBasis ?? 'nil',
      valueRate: e.line.valueRate,
      valuePct: e.line.valuePct,
    }),
  );
  const productRow: JournalRow = { ...product, itemId: bom.itemId, itemName: bom.itemName, unit: bom.unit, decimals: bom.unitDecimals, qty };
  return {
    ...form,
    bomId: bom.id,
    rows: [productRow, ...lines.filter((l) => l.role !== 'component'), ...lines.filter((l) => l.role === 'component'), ...kept],
  };
}

export interface BuiltInput {
  input: VoucherInput;
  /** Row key of each `stockJournal.lines[i]` (to show server errors next to the row). */
  lineKeys: string[];
  costKeys: string[];
}

export function toBlock(form: JournalForm): { block: StockJournalExtInput; lineKeys: string[]; costKeys: string[] } {
  const filled = form.rows.filter(isFilled);
  const thirdParty = form.cls !== 'manufacturing';
  const lines: StockJournalLineInput[] = filled.map((r) => {
    const l: StockJournalLineInput = { role: r.role, itemId: r.itemId as number, qty: r.qty as number };
    if (r.godownId !== null) l.godownId = r.godownId;
    if (r.batchName.trim()) l.batchName = r.batchName.trim();
    if (r.role === 'by_product' || r.role === 'scrap') {
      l.valueBasis = r.valueBasis;
      if (r.valueBasis === 'rate') l.valueRate = r.valueRate ?? 0;
      if (r.valueBasis === 'percent') l.valuePct = r.valuePct ?? 0;
    }
    if (thirdParty && r.role !== 'product' && r.role !== 'by_product' && r.role !== 'scrap') {
      l.goodsType = r.goodsType;
      if (r.rate !== null) l.rate = r.rate;
      if (r.extendedTo) l.extendedTo = r.extendedTo;
    }
    return l;
  });
  const costs = form.costs.filter((c) => (c.ledgerId !== null || c.label.trim() !== '') && (c.basis === 'amount' ? (c.amount ?? 0) > 0 : (c.pct ?? 0) > 0));
  const block: StockJournalExtInput = { lines };
  if (form.bomId !== null) block.bomId = form.bomId;
  if (thirdParty && form.thirdPartyGodownId !== null) block.thirdPartyGodownId = form.thirdPartyGodownId;
  if (thirdParty && form.jobWorkOrderId !== null) block.jobWorkOrderId = form.jobWorkOrderId;
  if (form.process.trim()) block.process = form.process.trim();
  if (costs.length > 0) {
    block.additionalCosts = costs.map((c) => {
      const out: NonNullable<StockJournalExtInput['additionalCosts']>[number] = { basis: c.basis, value: c.basis === 'amount' ? (c.amount ?? 0) : (c.pct ?? 0) };
      if (c.ledgerId !== null) out.ledgerId = c.ledgerId;
      if (c.label.trim()) out.label = c.label.trim();
      return out;
    });
  }
  return { block, lineKeys: filled.map((r) => r.key), costKeys: costs.map((c) => c.key) };
}

export function toVoucherInput(form: JournalForm, alter?: { id: number; updatedAt: string | null; number: string | null }): BuiltInput {
  const { block, lineKeys, costKeys } = toBlock(form);
  const input: VoucherInput = { voucherTypeId: form.voucherTypeId, date: form.date, mode: 'inventory', stockJournal: block };
  if (form.partyLedgerId !== null) input.partyLedgerId = form.partyLedgerId;
  if (form.narration.trim()) input.narration = form.narration.trim();
  if (form.number.trim()) input.number = form.number.trim();
  if (form.cls !== 'manufacturing' && form.referenceNo.trim()) input.referenceNo = form.referenceNo.trim();
  // Sent on alteration (and when set): a missing flag falls back to the voucher type's default, which
  // would turn an optional journal into a regular one when it is altered.
  if (form.isOptional || alter) input.isOptional = form.isOptional;
  if (form.isPostDated) input.isPostDated = true;
  if (alter) {
    input.id = alter.id;
    if (alter.updatedAt) input.expectedUpdatedAt = alter.updatedAt;
  }
  return { input, lineKeys, costKeys };
}

/** The form of a saved (or duplicated) journal. */
export function fromDetail(d: MfgJournalDetail): JournalForm {
  const items = new Map(d.items.map((i) => [i.id, i]));
  return {
    cls: d.class,
    voucherTypeId: d.voucherTypeId,
    date: d.date,
    number: d.number ?? '',
    partyLedgerId: d.partyLedgerId,
    thirdPartyGodownId: d.block.thirdPartyGodownId ?? null,
    jobWorkOrderId: d.block.jobWorkOrderId ?? null,
    bomId: d.block.bomId ?? null,
    process: d.block.process ?? '',
    narration: d.narration ?? '',
    referenceNo: d.referenceNo ?? '',
    isOptional: d.isOptional,
    isPostDated: d.isPostDated === true,
    rows: d.block.lines.map((l) => {
      const it = items.get(l.itemId);
      return blankRow(l.role, {
        itemId: l.itemId,
        itemName: it?.name ?? `Item ${l.itemId}`,
        unit: it?.unit ?? '',
        decimals: it?.decimals ?? 0,
        qty: l.qty,
        godownId: l.godownId ?? null,
        batchName: l.batchName ?? '',
        valueBasis: l.valueBasis ?? 'nil',
        valueRate: l.valueRate ?? null,
        valuePct: l.valuePct ?? null,
        goodsType: l.goodsType ?? 'inputs',
        rate: l.rate ?? null,
        extendedTo: l.extendedTo ?? null,
      });
    }),
    costs: (d.block.additionalCosts ?? []).map((c) =>
      blankCost({
        ledgerId: c.ledgerId ?? null,
        label: c.label ?? '',
        basis: c.basis,
        amount: c.basis === 'amount' ? c.value : null,
        pct: c.basis === 'percent' ? c.value : null,
      }),
    ),
  };
}

/**
 * Server field errors → per-row messages. `stockJournal.lines[3].qty` → the 4th sent line's row key;
 * other paths are returned as general messages (shown in a banner) or header fields.
 */
export function mapErrors(
  errors: Readonly<Record<string, string>>,
  built: Pick<BuiltInput, 'lineKeys' | 'costKeys'>,
): { rows: Map<string, string>; costs: Map<string, string>; fields: Record<string, string>; general: string[] } {
  const rows = new Map<string, string>();
  const costs = new Map<string, string>();
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const [path, msg] of Object.entries(errors)) {
    const line = /^stockJournal\.lines\[(\d+)\]/.exec(path) ?? /^stockJournal\.lines\.(\d+)/.exec(path);
    const cost = /^stockJournal\.additionalCosts\[(\d+)\]/.exec(path) ?? /^stockJournal\.additionalCosts\.(\d+)/.exec(path);
    if (line && built.lineKeys[Number(line[1])]) rows.set(built.lineKeys[Number(line[1])], msg);
    else if (cost && built.costKeys[Number(cost[1])]) costs.set(built.costKeys[Number(cost[1])], msg);
    else if (/^(partyLedgerId|date|number|voucherTypeId|referenceNo)$/.test(path)) fields[path] = msg;
    else if (/^stockJournal\.(thirdPartyGodownId|jobWorkOrderId|bomId)$/.test(path)) fields[path.slice('stockJournal.'.length)] = msg;
    else general.push(msg);
  }
  return { rows, costs, fields, general };
}

/** Header text of the screen and its class. */
export const CLASS_TITLES: Readonly<Record<StockJournalClass, string>> = {
  manufacturing: 'Manufacturing Journal',
  material_out: 'Material Out',
  material_in: 'Material In',
};

/** The voucher type to open: the one asked for, else the first active type of the class, else the first one. */
export function pickType<T extends { id: number; class: StockJournalClass; isActive: boolean }>(types: readonly T[], want: { voucherTypeId?: number; cls?: StockJournalClass }): T | null {
  if (want.voucherTypeId !== undefined) return types.find((t) => t.id === want.voucherTypeId) ?? null;
  const cls = want.cls ?? 'manufacturing';
  return types.find((t) => t.class === cls && t.isActive) ?? types.find((t) => t.class === cls) ?? null;
}

/** Roles of the editable sections of a journal, in screen order (one trailing blank row each). */
export function sectionRoles(sections: JournalSections): Array<{ id: 'outputs' | 'components' | 'material'; roles: readonly StockJournalRole[]; newRole: StockJournalRole }> {
  const out: Array<{ id: 'outputs' | 'components' | 'material'; roles: readonly StockJournalRole[]; newRole: StockJournalRole }> = [];
  if (sections.products) out.push({ id: 'outputs', roles: ['by_product', 'scrap'], newRole: 'scrap' });
  if (sections.components) out.push({ id: 'components', roles: ['component'], newRole: 'component' });
  if (sections.material) out.push({ id: 'material', roles: [sections.material], newRole: sections.material });
  return out;
}

const isBlank = (r: JournalRow): boolean => r.itemId === null && (r.qty === null || r.qty === 0);

/**
 * Keep exactly one blank row at the end of every section (Tally-style: type on the empty line to add
 * one), one product row for journals that make goods, and drop rows of roles the journal no longer has.
 */
export function withTrailingBlanks(form: JournalForm, sections: JournalSections): JournalForm {
  const groups = sectionRoles(sections);
  const product = sections.products ? (form.rows.find((r) => r.role === 'product') ?? blankRow('product')) : null;
  const rows: JournalRow[] = product ? [product] : [];
  for (const g of groups) {
    const filled = form.rows.filter((r) => g.roles.includes(r.role) && !isBlank(r));
    const blanks = form.rows.filter((r) => g.roles.includes(r.role) && isBlank(r));
    rows.push(...filled, blanks[blanks.length - 1] ?? blankRow(g.newRole));
  }
  const sameRows = rows.length === form.rows.length && rows.every((r, i) => r === form.rows[i]);
  let costs: CostRow[] = [];
  if (sections.costs) {
    const filled = form.costs.filter((c) => !isBlankCost(c));
    costs = [...filled, form.costs.filter(isBlankCost).pop() ?? blankCost()];
  }
  const sameCosts = costs.length === form.costs.length && costs.every((c, i) => c === form.costs[i]);
  if (sameRows && sameCosts) return form;
  return { ...form, rows: sameRows ? form.rows : rows, costs: sameCosts ? form.costs : costs };
}

const isBlankCost = (c: CostRow): boolean => c.ledgerId === null && c.label.trim() === '' && !(c.amount ?? 0) && !(c.pct ?? 0);

/** Estimated value per row key from a preview (`lineValues[i]` belongs to `lineKeys[i]`). */
export function lineValuesByKey(lineValues: ReadonlyArray<Paise | null> | undefined, lineKeys: readonly string[]): Map<string, Paise> {
  const out = new Map<string, Paise>();
  if (!lineValues) return out;
  lineKeys.forEach((k, i) => {
    const v = lineValues[i];
    if (typeof v === 'number') out.set(k, v);
  });
  return out;
}
