/**
 * Voucher entry form state + reducer (pure; tested in formState.test.ts).
 *
 * Rows are identified by stable string keys (never by index) so server error paths, focus and React
 * memoisation survive inserts and deletes. Grids always end with one blank row (the cursor
 * waits on an empty line; Enter on it leaves the grid).
 */
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { lineAmount, roundPaise } from '../../../../shared/money.ts';
import type { Paise } from '../../../../shared/money.ts';
import type {
  BillAllocationInput,
  ConsigneeInput,
  CostAllocationInput,
  DispatchDetailsInput,
  ExportDetailsInput,
  InstrumentInput,
  LedgerLineGstInput,
  OrderDetailsInput,
  PartySnapshotInput,
  VoucherMode,
} from '../../../../shared/types/vouchers.ts';
import type { VoucherTdsInput } from '../../../../shared/types/tds.ts';
import type { VoucherGstDetailsInput } from '../../../../shared/types/gst-plus.ts';
import type { VoucherForexInput } from '../../../../shared/types/forex.ts';
import { singleEntryAccountSide } from './kinds.ts';

export type Side = 'dr' | 'cr';
export type LedgerLayout = 'single' | 'double';

export interface ItemRow {
  key: string;
  itemId: number | null;
  godownId: number | null;
  batchName: string;
  mfgDate: string | null;
  expiryDate: string | null;
  /** Actual quantity (physical stock: the counted quantity). */
  qty: number | null;
  /** Billed quantity (Actual & Billed Qty feature); null = same as qty. */
  billedQty: number | null;
  /** Quantity in the alternate unit (no column; kept so an alteration round-trips). */
  altQty: number | null;
  /** Rupees per unit. */
  rate: number | null;
  /**
   * The rate the screen filled in from the masters (price level slab / item price); null when none.
   * While `rate === autoRate` the screen may re-read the price-list slab when the quantity changes.
   */
  autoRate: number | null;
  discountPct: number | null;
  /** Line value typed by the user (paise); null = qty × rate × (1 − disc%). */
  amount: Paise | null;
  gstRateOverride: number | null;
  /** Sales/purchase ledger of the line; null = the voucher type default. */
  ledgerId: number | null;
  description: string;
  trackingRef: string;
  orderRef: string;
  /** Stock journal: source (consumption) side. */
  isConsumption: boolean;
  /** null = the item master's setting. */
  rateInclusiveOfTax: boolean | null;
}

export interface LedgerRow {
  key: string;
  ledgerId: number | null;
  /**
   * Double-entry layout: SIGNED (Dr +, Cr −).
   * Single-entry particulars: magnitude (the side is fixed by the voucher type).
   * Invoice modes: + adds to the invoice (freight, the income line), − reduces it (discount).
   */
  amount: Paise | null;
  /** Side shown while the amount is empty (double-entry only). */
  side: Side;
  narration: string;
  bills: BillAllocationInput[] | null;
  costs: CostAllocationInput[] | null;
  instrument: InstrumentInput | null;
  /** Invoice modes: GST rate / HSN override of this line (shown in accounting invoices). */
  gstRate: number | null;
  hsnSac: string;
  /** Other GST override fields of a saved line (taxability, cess, supply kind) — no column; kept for alteration. */
  gstExtra: Omit<LedgerLineGstInput, 'rate' | 'hsnSac'> | null;
  /**
   * (forex module) Ledger mode, ledger kept in a foreign currency: the amount in that currency (same sign
   * convention as `amount`; 0 = an exchange adjustment in rupees only) and its rate of exchange. `amount`
   * then holds the rupees (forex × rate), set by the forex dialog (Alt+Y).
   */
  forexAmount?: number | null;
  exchangeRate?: number | null;
}

/** Links a new voucher carries from a documents-module draft (conversion of a quotation, a recurring occurrence). */
export interface DocLinks {
  convertedFromId?: number;
  recurring?: { templateId: number; periodKey: string };
}

export interface VoucherForm {
  /** Present when altering. */
  id: number | null;
  expectedUpdatedAt: string | null;
  voucherTypeId: number;
  baseType: VoucherBaseType;
  mode: VoucherMode;
  layout: LedgerLayout;
  date: string;
  effectiveDate: string | null;
  /** Typed number ('' = automatic / keep the saved number). */
  number: string;
  referenceNo: string;
  referenceDate: string | null;
  partyLedgerId: number | null;
  /** Single-entry layout: the cash/bank "Account" line. */
  accountLedgerId: number | null;
  accountInstrument: InstrumentInput | null;
  /** '' = automatic. */
  placeOfSupply: string;
  priceLevelId: number | null;
  reverseCharge: boolean;
  isOptional: boolean;
  isPostDated: boolean;
  narration: string;
  items: ItemRow[];
  ledgers: LedgerRow[];
  /** Invoice modes: bill-wise split of the party amount (null = server default: new ref). */
  partyBills: BillAllocationInput[] | null;
  party: PartySnapshotInput | null;
  consignee: ConsigneeInput | null;
  dispatch: DispatchDetailsInput | null;
  orderDetails: OrderDetailsInput | null;
  exportDetails: ExportDetailsInput | null;
  originalInvoiceNo: string;
  originalInvoiceDate: string | null;
  noteReason: string;
  /** Documents module: quotation / proforma "valid until", reversing journal "applicable up to". */
  validUntil: string | null;
  applicableUpto: string | null;
  /** Create only: the conversion / recurring link a draft carries (documents module); kept as given. */
  docLinks: DocLinks | null;
  /** TDS/TCS (tds module): nature for an advance, overrides with reasons, challan details; null = automatic. */
  tds: VoucherTdsInput | null;
  /** GST details (gst module, Alt+J): advance, advance adjustment / refund, bill of entry, stat adjustment, challan; null = none. */
  gstDetails: VoucherGstDetailsInput | null;
  /**
   * (forex module) Invoice in a foreign currency (party kept in that currency): document currency + rate.
   * While set, the item rates, line amounts and party bill amounts on the form are in that currency
   * (amount fields hold the foreign amount × 100, like paise); the server converts to rupees.
   */
  forex?: VoucherForexInput | null;
  /**
   * (forex module) Decimal places of the amount fields of an invoice in a foreign currency: they hold the
   * foreign amount × 10^forexDecimals (absent = 2, like paise). Follows the currency's decimal places
   * (0, 2, 3 or 4) — the 'forexUnit' action rescales the typed amounts when it changes.
   */
  forexDecimals?: number;
  /** Anything typed since load / reset (Esc asks before discarding). */
  touched: boolean;
  /** Key counter. */
  seq: number;
}

// ───────────────────────────── Rows ─────────────────────────────

export function blankItem(key: string, isConsumption = false): ItemRow {
  return {
    key,
    itemId: null,
    godownId: null,
    batchName: '',
    mfgDate: null,
    expiryDate: null,
    qty: null,
    billedQty: null,
    altQty: null,
    rate: null,
    autoRate: null,
    discountPct: null,
    amount: null,
    gstRateOverride: null,
    ledgerId: null,
    description: '',
    trackingRef: '',
    orderRef: '',
    isConsumption,
    rateInclusiveOfTax: null,
  };
}

export function blankLedger(key: string, side: Side = 'dr'): LedgerRow {
  return { key, ledgerId: null, amount: null, side, narration: '', bills: null, costs: null, instrument: null, gstRate: null, hsnSac: '', gstExtra: null };
}

export const isBlankItem = (r: ItemRow): boolean => r.itemId === null;
export const isBlankLedger = (r: LedgerRow): boolean => r.ledgerId === null;

/**
 * Value of an item line in paise: typed amount, else round(qty × rate × (1 − disc%)) on the billed qty.
 * `decimals` (forex invoice: VoucherForm.forexDecimals) gives the value in 10^-decimals units instead.
 */
export function itemLineValue(r: ItemRow, decimals = 2): Paise {
  if (r.amount !== null) return r.amount;
  const q = r.billedQty ?? r.qty ?? 0;
  const rate = r.rate ?? 0;
  if (q === 0 || rate === 0) return 0;
  if (decimals === 2) return lineAmount(q, rate, r.discountPct ?? 0);
  return roundPaise(q * rate * 10 ** decimals * (1 - (r.discountPct ?? 0) / 100));
}

/** Decimal places of the amount fields of the form (forex invoice: the currency's; else 2 = paise). */
export const amountDecimals = (f: Pick<VoucherForm, 'forexDecimals'>): number => f.forexDecimals ?? 2;

/**
 * Rescale the typed amounts of the form (item amounts, invoice ledger lines, party bills) from the
 * form's current unit to 10^-`decimals` (forex invoice whose currency has 0, 3 or 4 decimals).
 */
export function rescaleAmounts(f: VoucherForm, decimals: number): VoucherForm {
  const from = amountDecimals(f);
  if (from === decimals) return f;
  const k = 10 ** (decimals - from);
  const scale = (a: Paise): Paise => {
    const v = roundPaise(a * k);
    return v === 0 ? 0 : v;
  };
  return {
    ...f,
    items: f.items.map((r) => (r.amount === null ? r : { ...r, amount: scale(r.amount) })),
    ledgers: f.ledgers.map((r) => (r.amount === null ? r : { ...r, amount: scale(r.amount) })),
    partyBills: f.partyBills ? f.partyBills.map((b) => ({ ...b, amount: scale(b.amount) })) : f.partyBills,
    forexDecimals: decimals === 2 ? undefined : decimals,
  };
}

/** Signed Dr+/Cr− amount of a double-entry row (0 when empty). */
export const signedOf = (r: LedgerRow): Paise => r.amount ?? 0;

// ───────────────────────────── Initial state ─────────────────────────────

export interface NewFormOptions {
  voucherTypeId: number;
  baseType: VoucherBaseType;
  mode: VoucherMode;
  date: string;
  layout?: LedgerLayout;
  isOptional?: boolean;
  partyLedgerId?: number | null;
  accountLedgerId?: number | null;
}

export function newForm(o: NewFormOptions): VoucherForm {
  const layout: LedgerLayout = o.layout ?? (singleEntryAccountSide(o.baseType) ? 'single' : 'double');
  const base: VoucherForm = {
    id: null,
    expectedUpdatedAt: null,
    voucherTypeId: o.voucherTypeId,
    baseType: o.baseType,
    mode: o.mode,
    layout: singleEntryAccountSide(o.baseType) ? layout : 'double',
    date: o.date,
    effectiveDate: null,
    number: '',
    referenceNo: '',
    referenceDate: null,
    partyLedgerId: o.partyLedgerId ?? null,
    accountLedgerId: o.accountLedgerId ?? null,
    accountInstrument: null,
    placeOfSupply: '',
    priceLevelId: null,
    reverseCharge: false,
    isOptional: o.isOptional ?? false,
    isPostDated: false,
    narration: '',
    items: [],
    ledgers: [],
    partyBills: null,
    party: null,
    consignee: null,
    dispatch: null,
    orderDetails: null,
    exportDetails: null,
    originalInvoiceNo: '',
    originalInvoiceDate: null,
    noteReason: '',
    validUntil: null,
    applicableUpto: null,
    docLinks: null,
    tds: null,
    gstDetails: null,
    touched: false,
    seq: 0,
  };
  return normalize(base);
}

// ───────────────────────────── Normalisation ─────────────────────────────

function nextKey(f: VoucherForm, prefix: string): [string, number] {
  const seq = f.seq + 1;
  return [`${prefix}${seq}`, seq];
}

/** Ensure one trailing blank row per grid (stock journal: one per side). */
export function normalize(f: VoucherForm): VoucherForm {
  let out = f;
  const needsItems = f.mode === 'item_invoice' || f.mode === 'inventory';
  if (needsItems) {
    const groups: boolean[] = f.baseType === 'stock_journal' ? [true, false] : [false];
    for (const consumption of groups) {
      const rows = out.items.filter((r) => (f.baseType === 'stock_journal' ? r.isConsumption === consumption : true));
      const last = rows[rows.length - 1];
      if (!last || !isBlankItem(last)) {
        const [key, seq] = nextKey(out, 'i');
        out = { ...out, seq, items: [...out.items, blankItem(key, f.baseType === 'stock_journal' ? consumption : false)] };
      }
    }
  }
  if (f.mode !== 'inventory') {
    const last = out.ledgers[out.ledgers.length - 1];
    if (!last || !isBlankLedger(last)) {
      const [key, seq] = nextKey(out, 'l');
      out = { ...out, seq, ledgers: [...out.ledgers, blankLedger(key, nextDefaultSide(out))] };
    }
  }
  return out;
}

/** Double-entry: a new row defaults to the side that balances the voucher. */
export function nextDefaultSide(f: VoucherForm): Side {
  const filled = f.ledgers.filter((r) => !isBlankLedger(r));
  const diff = filled.reduce((a, r) => a + signedOf(r), 0);
  if (diff > 0) return 'cr';
  if (diff < 0) return 'dr';
  if (filled.length === 0) return f.baseType === 'receipt' ? 'cr' : 'dr';
  const last = filled[filled.length - 1];
  return last.side === 'dr' ? 'cr' : 'dr';
}

/** Σ signed amounts of the double-entry rows other than `exceptKey`. */
export function ledgerDifference(f: VoucherForm, exceptKey?: string): Paise {
  return f.ledgers.reduce((a, r) => (r.key === exceptKey ? a : a + signedOf(r)), 0);
}

// ───────────────────────────── Actions ─────────────────────────────

type Header = Omit<VoucherForm, 'items' | 'ledgers' | 'seq' | 'touched'>;

export type FormAction =
  | { type: 'load'; form: VoucherForm }
  | { type: 'patch'; patch: Partial<Header> }
  | { type: 'item'; key: string; patch: Partial<Omit<ItemRow, 'key'>> }
  | { type: 'itemInsert'; beforeKey: string | null; isConsumption?: boolean }
  | { type: 'itemDelete'; key: string }
  | { type: 'itemsAppend'; rows: Array<Partial<Omit<ItemRow, 'key'>>> }
  | { type: 'ledger'; key: string; patch: Partial<Omit<LedgerRow, 'key'>> }
  | { type: 'ledgerInsert'; beforeKey: string | null }
  | { type: 'ledgerDelete'; key: string }
  | { type: 'balanceLast' }
  | { type: 'setMode'; mode: VoucherMode }
  | { type: 'setLayout'; layout: LedgerLayout }
  | { type: 'next'; date?: string; isOptional?: boolean; partyLedgerId?: number | null }
  /** (forex) The amount fields' decimal places follow the invoice currency (not a user edit: `touched` kept). */
  | { type: 'forexUnit'; decimals: number };

export function formReducer(f: VoucherForm, a: FormAction): VoucherForm {
  switch (a.type) {
    case 'load':
      return normalize(a.form);
    case 'patch':
      return { ...f, ...a.patch, touched: true };
    case 'item': {
      const items = f.items.map((r) => (r.key === a.key ? { ...r, ...a.patch } : r));
      return normalize({ ...f, items, touched: true });
    }
    case 'itemInsert': {
      const [key, seq] = nextKey(f, 'i');
      const at = a.beforeKey === null ? f.items.length : f.items.findIndex((r) => r.key === a.beforeKey);
      const ref = f.items[at];
      const row = blankItem(key, a.isConsumption ?? ref?.isConsumption ?? false);
      const items = [...f.items];
      items.splice(at < 0 ? items.length : at, 0, row);
      return normalize({ ...f, items, seq, touched: true });
    }
    case 'itemDelete': {
      const items = f.items.filter((r) => r.key !== a.key);
      return normalize({ ...f, items, touched: true });
    }
    case 'itemsAppend': {
      let seq = f.seq;
      const rows = a.rows.map((p) => {
        seq += 1;
        return { ...blankItem(`i${seq}`), ...p };
      });
      // New rows go before the trailing blank row.
      const blanks = f.items.filter(isBlankItem);
      const filled = f.items.filter((r) => !isBlankItem(r));
      return normalize({ ...f, items: [...filled, ...rows, ...blanks], seq, touched: true });
    }
    case 'ledger': {
      const items = f.ledgers.map((r) => {
        if (r.key !== a.key) return r;
        const next = { ...r, ...a.patch };
        // Double entry: picking a ledger on an empty line pre-fills the amount that balances the voucher.
        if (f.mode === 'ledger' && f.layout === 'double' && a.patch.ledgerId != null && r.ledgerId === null && r.amount === null && a.patch.amount === undefined) {
          const diff = ledgerDifference(f, r.key);
          if (diff !== 0) {
            next.amount = -diff;
            next.side = -diff > 0 ? 'dr' : 'cr';
          }
        }
        if (a.patch.amount !== undefined && a.patch.amount !== null && a.patch.amount !== 0 && f.mode === 'ledger' && f.layout === 'double') {
          next.side = a.patch.amount > 0 ? 'dr' : 'cr';
        }
        return next;
      });
      return normalize({ ...f, ledgers: items, touched: true });
    }
    case 'ledgerInsert': {
      const [key, seq] = nextKey(f, 'l');
      const at = a.beforeKey === null ? f.ledgers.length : f.ledgers.findIndex((r) => r.key === a.beforeKey);
      const rows = [...f.ledgers];
      rows.splice(at < 0 ? rows.length : at, 0, blankLedger(key, nextDefaultSide(f)));
      return normalize({ ...f, ledgers: rows, seq, touched: true });
    }
    case 'ledgerDelete':
      return normalize({ ...f, ledgers: f.ledgers.filter((r) => r.key !== a.key), touched: true });
    case 'forexUnit':
      return rescaleAmounts(f, a.decimals);
    case 'balanceLast':
      return balanceLast(f);
    case 'setMode': {
      if (a.mode === f.mode) return f;
      // Item ↔ accounting invoice: the additional ledgers stay; item lines are kept for a switch back.
      return normalize({ ...f, mode: a.mode, touched: true });
    }
    case 'setLayout':
      return setLayout(f, a.layout);
    case 'next':
      return newForm({
        voucherTypeId: f.voucherTypeId,
        baseType: f.baseType,
        mode: f.mode,
        date: a.date ?? f.date,
        layout: f.layout,
        isOptional: a.isOptional ?? false,
        partyLedgerId: a.partyLedgerId ?? null,
        accountLedgerId: f.layout === 'single' ? f.accountLedgerId : null,
      });
    default:
      return f;
  }
}

/**
 * "Balance it": put the amount that makes Dr = Cr on the last filled double-entry line (or, in the
 * single-entry layout, nothing to do — the Account line always balances). Returns the form unchanged
 * when already balanced or there is no line to put it on.
 */
export function balanceLast(f: VoucherForm): VoucherForm {
  if (f.mode !== 'ledger' || f.layout !== 'double') return f;
  const filled = f.ledgers.filter((r) => !isBlankLedger(r));
  if (filled.length === 0) return f;
  const total = ledgerDifference(f);
  if (total === 0) return f;
  const last = filled[filled.length - 1];
  const others = ledgerDifference(f, last.key);
  const amount = -others;
  if (amount === 0) return f;
  return {
    ...f,
    touched: true,
    ledgers: f.ledgers.map((r) => (r.key === last.key ? { ...r, amount, side: amount > 0 ? 'dr' : 'cr' } : r)),
  };
}

/**
 * Switch between the single-entry layout (Account + particulars) and the Dr/Cr layout.
 * single → double: the Account becomes the first line with the balancing amount.
 * double → single: possible when one cash/bank line (the caller marks it as the first line on the
 * account side) carries the account side and every other line the opposite side; otherwise unchanged.
 */
function setLayout(f: VoucherForm, layout: LedgerLayout): VoucherForm {
  const side = singleEntryAccountSide(f.baseType);
  if (layout === f.layout || f.mode !== 'ledger' || side === null) return f;
  const accSign = side === 'dr' ? 1 : -1;
  if (layout === 'double') {
    const parts = f.ledgers.filter((r) => !isBlankLedger(r));
    const total = parts.reduce((a, r) => a + (r.amount ?? 0), 0);
    let seq = f.seq;
    const rows: LedgerRow[] = [];
    if (f.accountLedgerId !== null) {
      seq += 1;
      rows.push({ ...blankLedger(`l${seq}`, side), ledgerId: f.accountLedgerId, amount: total === 0 ? null : accSign * total, instrument: f.accountInstrument });
    }
    for (const r of parts) {
      const amount = r.amount === null ? null : -accSign * r.amount;
      rows.push({ ...r, amount, side: side === 'dr' ? 'cr' : 'dr' });
    }
    return normalize({ ...f, layout, ledgers: rows, accountLedgerId: null, accountInstrument: null, seq, touched: true });
  }
  const split = splitForSingle(f.ledgers.filter((r) => !isBlankLedger(r)), side);
  if (!split) return f;
  return normalize({
    ...f,
    layout,
    accountLedgerId: split.account?.ledgerId ?? null,
    accountInstrument: split.account?.instrument ?? null,
    ledgers: split.particulars.map((r) => ({ ...r, amount: r.amount === null ? null : Math.abs(r.amount) })),
    touched: true,
  });
}

/** Can these double-entry lines be shown in the single-entry layout? Exactly one line on the account side. */
export function splitForSingle(rows: readonly LedgerRow[], side: Side): { account: LedgerRow | null; particulars: LedgerRow[] } | null {
  const onAccountSide = rows.filter((r) => (r.amount ?? 0) !== 0 && (side === 'dr' ? (r.amount ?? 0) > 0 : (r.amount ?? 0) < 0));
  if (rows.length === 0) return { account: null, particulars: [] };
  if (onAccountSide.length !== 1) return null;
  const account = onAccountSide[0];
  // The Account line has no bill-wise, cost-centre or narration cell in the single-entry layout:
  // keep such a voucher in Dr/Cr so nothing is lost on alteration.
  if (account.bills && account.bills.length > 0) return null;
  if (account.costs && account.costs.length > 0) return null;
  if (account.narration.trim() !== '') return null;
  return { account, particulars: rows.filter((r) => r !== account) };
}

/** Rows of one stock-journal side, or all rows. */
export function itemsOf(f: VoucherForm, consumption?: boolean): ItemRow[] {
  if (consumption === undefined) return f.items;
  return f.items.filter((r) => r.isConsumption === consumption);
}
