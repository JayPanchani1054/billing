/**
 * Invoice tax engine — the single implementation of GST arithmetic. The renderer calls it on every
 * keystroke for live totals; the backend calls it again on save and stores its output (gst_lines,
 * voucher totals). Pure and deterministic: same input → same paise, everywhere.
 *
 * Pipeline
 *  1. Sanitise lines (never NaN: bad numbers become 0 with a warning).
 *  2. Line value: gross = qty × rate (or amount); net = gross after discount, rounded once.
 *  3. Place of supply → inter/intra-state → tax mode (IGST | CGST+SGST | CGST+UTGST | none).
 *  4. Tax regime per line: is GST charged (company registered, not LUT, supplier can charge …),
 *     is it reverse charge, is it part of the amount payable to the party.
 *  5. Tax-inclusive lines are back-calculated: taxable = round(net × 100 / (100 + rate + cess%)).
 *  6. Additional charges marked `apportion` are absorbed into the goods lines' taxable value
 *     (shared over lines with a positive quantity/value only).
 *  7. Tax per bucket (taxability + rate + cess% + charged + reverse charge) on the bucket's total
 *     taxable value, then allocated back to lines by largest remainder → line taxes sum exactly to
 *     bucket tax, and every line stays within one paise of its own exact share.
 *  8. Inclusive lines keep their entered value exactly: the bucket-rounding residual (±1–2 paise)
 *     stays in the line's taxable value, so taxable + tax = net and CGST always equals SGST.
 *  9. Totals, round-off on the amount payable to the party, classification, HSN summary.
 */
import { allocate, lineAmount, roundPaise, roundToUnit, type Paise } from '../money.ts';
import type {
  ComputedLine,
  DocumentKind,
  GstNature,
  HsnRow,
  InvoiceComputation,
  InvoiceContext,
  InvoiceLineInput,
  RegistrationType,
  SupplyKind,
  Taxability,
  TaxBucket,
  TaxMode,
} from '../types/gst.ts';
import { REGISTRATION_TYPES, TAXABILITIES } from '../types/gst.ts';
import { b2clThresholdOn, classifySupply, isRegisteredParty } from './classify.ts';
import { gstinStateCode, validateGstin } from './gstin.ts';
import { determinePlaceOfSupply, isInterState, taxModeFor } from './pos.ts';
import { isRetiredSlabOn, isStandardRate, isValidCessRate, isValidRate, splitRate } from './rates.ts';
import { getState, isUtgstState, normalizeStateCode, POS_OTHER_COUNTRIES, stateLabel } from './states.ts';
import { DEFAULT_GOODS_UQC, isValidUqc, SERVICES_UQC, suggestUqc } from './uqc.ts';

export { isUtgstState, splitRate, taxModeFor };

/** Largest absolute paise value the engine accepts for a single line (₹9,000 crore). */
export const MAX_LINE_PAISE = 9e14;
/**
 * Largest Σ|line value| + Σ|per-unit cess| the engine accepts for a whole invoice. With tax at most
 * 500% (GST 100% + cess 400%) every total stays below 6.3e15 < 2^53, i.e. a safe integer.
 */
export const MAX_INVOICE_PAISE = 9e14;
const MAX_QTY_OR_RATE = 1e12;

// ───────────────────────────── Exact arithmetic helpers ─────────────────────────────

/** Rates are handled as integers scaled by 10^4 (4 decimal places is plenty for GST/cess rates). */
const RATE_SCALE = 10_000;

const normRate = (rate: number): number => Math.round(rate * RATE_SCALE) / RATE_SCALE;

function scaled(rate: number): number | null {
  const s = Math.round(rate * RATE_SCALE);
  return Math.abs(s - rate * RATE_SCALE) < 1e-6 ? s : null;
}

/** round(num / den) half away from zero, exact (BigInt), den > 0. */
function divRound(num: bigint, den: bigint): bigint {
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return neg ? -q : q;
}

/** round(amount × ratePct / divisor) without binary floating-point error. */
function mulRate(amount: Paise, ratePct: number, divisor: number): Paise {
  if (amount === 0 || ratePct === 0) return 0;
  const s = scaled(ratePct);
  if (s === null || !Number.isSafeInteger(amount)) return roundPaise((amount * ratePct) / divisor);
  const r = Number(divRound(BigInt(amount) * BigInt(s), BigInt(divisor * RATE_SCALE)));
  return r === 0 ? 0 : r;
}

/** Tax at `ratePct` percent on `amount` paise, rounded half away from zero: taxAt(1010, 5) = 51 (50.5). */
export function taxAt(amount: Paise, ratePct: number): Paise {
  return mulRate(amount, ratePct, 100);
}

/** Taxable value inside a tax-inclusive amount: round(amount × 100 / (100 + totalRatePct)). */
export function taxableFromInclusive(amount: Paise, totalRatePct: number): Paise {
  if (amount === 0 || totalRatePct === 0) return amount;
  const s = scaled(100 + totalRatePct);
  if (s === null || !Number.isSafeInteger(amount)) return roundPaise((amount * 100) / (100 + totalRatePct));
  const r = Number(divRound(BigInt(amount) * BigInt(100 * RATE_SCALE), BigInt(s)));
  return r === 0 ? 0 : r;
}

/** Largest-remainder rounding of real quotas so the integer parts sum exactly to `total`. */
function hamilton(total: Paise, quotas: readonly number[]): Paise[] {
  const n = quotas.length;
  const out = quotas.map((q) => Math.floor(q + 1e-9));
  let remainder = total - out.reduce((a, b) => a + b, 0);
  const order = quotas
    .map((q, i) => ({ i, frac: q - out[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  // With quotas summing to ≈ total the remainder is within [0, n]; loops also absorb any drift.
  for (let k = 0; remainder > 0; k++, remainder--) out[order[k % n].i] += 1;
  for (let k = 0; remainder < 0; k++, remainder++) out[order[n - 1 - (k % n)].i] -= 1;
  return out.map((v) => (v === 0 ? 0 : v));
}

/**
 * Split a bucket head `total` across its lines so the parts sum exactly to `total`.
 *  - Same-sign weights: money.ts allocate() (largest remainder on the weights).
 *  - Mixed signs (a negative discount/return line in the bucket) or all-zero weights: start from each
 *    line's own exact share (`quotas`, e.g. base × rate / 100) and settle the sum by largest remainder.
 *    Scaling `total × w / Σw` instead would amplify the bucket's ±0.5 paise rounding by w / Σw when
 *    the signs nearly cancel — bases +100001 / −99000 at 18% would get 17982 / −17802 instead of
 *    18000 / −17820, and +100000 / −99999 would get 0 / 0.
 */
function distribute(total: Paise, weights: readonly number[], quotas: readonly number[]): Paise[] {
  if (weights.length === 0) return [];
  const hasPos = weights.some((w) => w > 0);
  const hasNeg = weights.some((w) => w < 0);
  if (hasPos !== hasNeg) return allocate(total, weights);
  return hamilton(total, quotas);
}

// ───────────────────────────── Working line ─────────────────────────────

interface WorkLine {
  input: InvoiceLineInput;
  label: string;
  qty: number;
  gross: Paise;
  discount: Paise;
  net: Paise;
  taxability: Taxability;
  rate: number;
  cessRate: number;
  cessPerUnit: Paise;
  supplyKind: SupplyKind;
  hsnSac: string;
  uqc: string;
  wantsInclusive: boolean;
  apportion: 'none' | 'value' | 'quantity';
  /** Absorbed into goods lines (taxable 0 of its own). */
  absorbed: boolean;
  rc: boolean;
  taxCharged: boolean;
  payable: boolean;
  inclusive: boolean;
  base: Paise;
  apportioned: Paise;
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
}

type Warn = (message: string) => void;

/**
 * GST UQC for a line. Services default to 'NA'; goods to 'OTH'. A unit symbol passed instead of a UQC
 * ('Kg', 'pcs') is mapped with suggestUqc(); an unrecognised unit is reported as 'OTH' with a warning.
 */
function lineUqc(value: unknown, supplyKind: SupplyKind, label: string, warn: Warn): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return supplyKind === 'services' ? SERVICES_UQC : DEFAULT_GOODS_UQC;
  const upper = raw.toUpperCase();
  if (isValidUqc(upper)) return upper;
  if (upper === SERVICES_UQC) return supplyKind === 'services' ? SERVICES_UQC : DEFAULT_GOODS_UQC;
  const mapped = suggestUqc(raw);
  if (mapped === DEFAULT_GOODS_UQC) warn(`${label}: unit '${raw}' is not a GST UQC and is reported as ${DEFAULT_GOODS_UQC}`);
  return mapped;
}

function finiteOr(value: unknown, fallback: number, label: string, field: string, warn: Warn): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warn(`${label}: ${field} is not a valid number and was treated as ${fallback}`);
    return fallback;
  }
  return value;
}

function prepareLine(raw: InvoiceLineInput, index: number, ctxReverseCharge: boolean, warn: Warn): WorkLine {
  // Defensive: a hole or non-object in the array becomes an empty line, so output lines stay 1:1 with input.
  let input = raw;
  if (input === null || typeof input !== 'object') {
    warn(`Line ${index + 1}: line data is missing and was treated as a blank line`);
    input = { key: String(index), kind: 'ledger', taxability: 'taxable', gstRate: 0, supplyKind: 'goods' };
  }
  const desc = typeof input.description === 'string' ? input.description.trim() : '';
  const label = desc ? `Line ${index + 1} (${desc})` : `Line ${index + 1}`;

  let qty = finiteOr(input.qty, 0, label, 'quantity', warn);
  if (Math.abs(qty) > MAX_QTY_OR_RATE) {
    warn(`${label}: quantity is too large and was treated as 0`);
    qty = 0;
  }
  if (qty < 0) warn(`${label}: quantity is negative`);

  let rate = finiteOr(input.rate, 0, label, 'rate', warn);
  if (Math.abs(rate) > MAX_QTY_OR_RATE) {
    warn(`${label}: rate is too large and was treated as 0`);
    rate = 0;
  }
  if (rate < 0) warn(`${label}: rate is negative`);

  let discountPct = finiteOr(input.discountPct, 0, label, 'discount %', warn);
  if (discountPct < 0 || discountPct > 100) {
    warn(`${label}: discount must be between 0% and 100%`);
    discountPct = Math.min(100, Math.max(0, discountPct));
  }

  let amount: Paise | undefined;
  if (input.amount !== undefined && input.amount !== null) {
    const a = finiteOr(input.amount, 0, label, 'amount', warn);
    amount = Number.isInteger(a) ? a : roundPaise(a);
    if (!Number.isInteger(a)) warn(`${label}: amount was not in whole paise and has been rounded`);
  }

  // gross = value before discount; net = value after discount, rounded once (money.ts convention).
  let gross: Paise;
  let net: Paise;
  if (amount !== undefined) {
    gross = amount;
    net = discountPct ? mulRate(amount, 100 - discountPct, 100) : amount;
  } else {
    gross = lineAmount(qty, rate, 0);
    net = discountPct ? lineAmount(qty, rate, discountPct) : gross;
  }
  if (Math.abs(gross) > MAX_LINE_PAISE || Math.abs(net) > MAX_LINE_PAISE) {
    warn(`${label}: amount is too large and was treated as 0`);
    gross = 0;
    net = 0;
  }

  let taxability: Taxability = input.taxability;
  if (!TAXABILITIES.includes(taxability)) {
    warn(`${label}: unknown taxability; treated as taxable`);
    taxability = 'taxable';
  }

  // Rates are normalised to 4 decimals so float noise from REAL columns never splits a bucket.
  let gstRate = normRate(finiteOr(input.gstRate, 0, label, 'GST rate', warn));
  if (!isValidRate(gstRate)) {
    warn(`${label}: GST rate ${gstRate}% is not valid and was treated as 0%`);
    gstRate = 0;
  }
  let cessRate = normRate(finiteOr(input.cessRate, 0, label, 'cess rate', warn));
  if (!isValidCessRate(cessRate)) {
    warn(`${label}: cess rate ${cessRate}% is not valid and was treated as 0%`);
    cessRate = 0;
  }
  let cessPerUnit = finiteOr(input.cessPerUnit, 0, label, 'cess per unit', warn);
  if (cessPerUnit < 0) {
    warn(`${label}: cess per unit cannot be negative and was treated as 0`);
    cessPerUnit = 0;
  }
  cessPerUnit = roundPaise(cessPerUnit);
  // Keep qty × per-unit cess inside the safe range as well (it is not bounded by the line value).
  if (cessPerUnit !== 0 && Math.abs(cessPerUnit * qty) > MAX_LINE_PAISE) {
    warn(`${label}: cess per unit × quantity is too large; the per-unit cess was treated as 0`);
    cessPerUnit = 0;
  }

  const hsnSac = typeof input.hsnSac === 'string' ? input.hsnSac.replace(/\s+/g, '') : '';
  let supplyKind: SupplyKind = input.supplyKind;
  if (supplyKind !== 'goods' && supplyKind !== 'services') {
    supplyKind = hsnSac.startsWith('99') ? 'services' : 'goods';
    warn(`${label}: supply type not set; treated as ${supplyKind}`);
  }
  const uqc = lineUqc(input.uqc, supplyKind, label, warn);

  const taxable = taxability === 'taxable';
  const apportion = input.apportion === 'value' || input.apportion === 'quantity' ? input.apportion : 'none';

  return {
    input,
    label,
    qty,
    gross,
    discount: gross - net,
    net,
    taxability,
    rate: taxable ? gstRate : 0,
    cessRate: taxable ? cessRate : 0,
    cessPerUnit: taxable ? cessPerUnit : 0,
    supplyKind,
    hsnSac,
    uqc,
    wantsInclusive: input.rateInclusiveOfTax === true,
    apportion,
    absorbed: false,
    rc: ctxReverseCharge || input.reverseCharge === true,
    taxCharged: false,
    payable: true,
    inclusive: false,
    base: net,
    apportioned: 0,
    taxable: net,
    igst: 0,
    cgst: 0,
    sgst: 0,
    cess: 0,
  };
}

const hasText = (v: unknown): boolean => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number';

/**
 * Keep the whole invoice inside MAX_INVOICE_PAISE so every total is a safe integer: lines beyond
 * the limit are treated as 0, like an over-limit single line.
 */
function capInvoiceSize(work: WorkLine[], warn: Warn): void {
  let running = 0;
  for (const l of work) {
    const size = Math.abs(l.net) + Math.abs(l.cessPerUnit * l.qty);
    if (running + size <= MAX_INVOICE_PAISE) {
      running += size;
      continue;
    }
    warn(`${l.label}: the invoice total is too large; this line was treated as 0`);
    l.gross = 0;
    l.net = 0;
    l.discount = 0;
    l.base = 0;
    l.taxable = 0;
    l.cessPerUnit = 0;
  }
}

// ───────────────────────────── Apportionment of additional charges ─────────────────────────────

function apportionCharges(work: WorkLine[], warn: Warn): void {
  const charges = work.filter((l) => l.apportion !== 'none');
  if (charges.length === 0) return;
  const plain = work.filter((l) => l.apportion === 'none' && l.supplyKind === 'goods');
  // Item lines absorb charges; accounting-mode invoices (no item lines) use goods ledger lines.
  const items = plain.filter((l) => l.input.kind === 'item');
  const targets = items.length > 0 ? items : plain;

  for (const charge of charges) {
    if (targets.length === 0) {
      warn(`${charge.label}: there are no goods lines to absorb this charge; it is taxed as a separate line`);
      continue;
    }
    let weights = targets.map((t) => (charge.apportion === 'quantity' ? t.qty : t.base));
    if (charge.apportion === 'quantity' && weights.every((w) => w === 0)) {
      warn(`${charge.label}: goods lines have no quantity; the charge was apportioned by value`);
      weights = targets.map((t) => t.base);
    }
    // Only lines with a positive quantity/value share the charge. Signed weights would amplify it:
    // ₹30 freight over quantities 2 and −1 used to become +₹60 and −₹30.
    let shareWeights = weights.map((w) => (w > 0 ? w : 0));
    if (shareWeights.every((w) => w === 0)) shareWeights = weights.map((w) => Math.abs(w));
    else if (weights.some((w) => w < 0)) {
      warn(`${charge.label}: lines with a negative quantity or value do not share this charge`);
    }
    const shares = allocate(charge.net, shareWeights);
    targets.forEach((t, i) => {
      t.apportioned += shares[i];
    });
    charge.apportioned -= charge.net;
    charge.absorbed = true;
  }
  for (const l of work) l.base += l.apportioned;
}

// ───────────────────────────── Buckets ─────────────────────────────

const TAXABILITY_ORDER: Record<Taxability, number> = { taxable: 0, nil_rated: 1, exempt: 2, non_gst: 3 };

function computeBuckets(work: WorkLine[], taxMode: TaxMode): TaxBucket[] {
  const groups = new Map<string, WorkLine[]>();
  for (const l of work) {
    if (l.absorbed) continue;
    // Reverse-charge lines get their own bucket: the recipient's RCM liability is computed on the RCM
    // value alone, independent of the rounding of forward-charge lines on the same document.
    const key = `${l.taxability}|${l.rate}|${l.cessRate}|${l.taxCharged ? 1 : 0}|${l.taxCharged && l.rc ? 1 : 0}`;
    const g = groups.get(key);
    if (g) g.push(l);
    else groups.set(key, [l]);
  }

  const buckets: TaxBucket[] = [];
  for (const lines of groups.values()) {
    const first = lines[0];
    if (first.taxCharged) {
      const bases = lines.map((l) => l.base);
      const base = bases.reduce((a, b) => a + b, 0);
      const rate = first.rate;
      // Bucket heads on the bucket's total taxable value; then largest-remainder back to lines.
      if (taxMode === 'igst') {
        const igst = mulRate(base, rate, 100);
        const parts = distribute(igst, bases, bases.map((b) => (b * rate) / 100));
        lines.forEach((l, i) => (l.igst = parts[i]));
      } else if (taxMode === 'cgst_sgst' || taxMode === 'cgst_utgst') {
        const half = mulRate(base, rate, 200);
        const parts = distribute(half, bases, bases.map((b) => (b * rate) / 200));
        lines.forEach((l, i) => {
          l.cgst = parts[i];
          l.sgst = parts[i];
        });
      }
      const cessAdValorem = mulRate(base, first.cessRate, 100);
      const cessParts = distribute(cessAdValorem, bases, bases.map((b) => (b * first.cessRate) / 100));
      const perUnit = lines.map((l) => l.cessPerUnit * l.qty);
      const perUnitParts = distribute(roundPaise(perUnit.reduce((a, b) => a + b, 0)), perUnit, perUnit);
      lines.forEach((l, i) => (l.cess = cessParts[i] + perUnitParts[i]));
    }

    // Tax-inclusive lines keep their entered value: the rounding residual stays in taxable value.
    for (const l of lines) {
      const tax = l.igst + l.cgst + l.sgst + l.cess;
      l.taxable = l.inclusive && l.apportioned === 0 ? l.net - tax : l.base;
    }

    const sum = (f: (l: WorkLine) => number): Paise => lines.reduce((a, l) => a + f(l), 0);
    const b: TaxBucket = {
      taxability: first.taxability,
      rate: first.rate,
      cessRate: first.cessRate,
      taxCharged: first.taxCharged,
      reverseCharge: first.taxCharged && first.rc,
      taxableValue: sum((l) => l.taxable),
      igst: sum((l) => l.igst),
      cgst: sum((l) => l.cgst),
      sgst: sum((l) => l.sgst),
      cess: sum((l) => l.cess),
      tax: 0,
    };
    b.tax = b.igst + b.cgst + b.sgst + b.cess;
    buckets.push(b);
  }

  return buckets.sort(
    (a, b) =>
      TAXABILITY_ORDER[a.taxability] - TAXABILITY_ORDER[b.taxability] ||
      a.rate - b.rate ||
      a.cessRate - b.cessRate ||
      Number(b.taxCharged) - Number(a.taxCharged) ||
      Number(a.reverseCharge) - Number(b.reverseCharge),
  );
}

function hsnSummary(lines: readonly ComputedLine[]): HsnRow[] {
  const rows = new Map<string, HsnRow>();
  for (const l of lines) {
    if (l.absorbed) continue;
    if (l.taxableValue === 0 && l.qty === 0 && l.tax === 0) continue; // blank row
    // GSTR-1 Table 12: services (SAC) are reported with UQC 'NA' and no quantity.
    const uqc = l.supplyKind === 'services' ? SERVICES_UQC : l.uqc;
    const key = `${l.hsnSac}|${uqc}|${l.rate}`;
    let row = rows.get(key);
    if (!row) {
      row = { hsnSac: l.hsnSac, uqc, qty: 0, rate: l.rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
      rows.set(key, row);
    }
    if (!row.description && l.description) row.description = l.description;
    if (l.supplyKind === 'goods') row.qty += l.qty;
    row.taxableValue += l.taxableValue;
    row.igst += l.igst;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.cess += l.cess;
    row.total += l.total;
  }
  return [...rows.values()]
    .map((r) => ({ ...r, qty: Math.round(r.qty * 1e6) / 1e6 }))
    .sort((a, b) => a.hsnSac.localeCompare(b.hsnSac) || a.uqc.localeCompare(b.uqc) || a.rate - b.rate);
}

/** Natures where HSN/SAC is mandatory on every line (B2B-type and zero-rated documents). */
const HSN_REQUIRED: ReadonlySet<GstNature> = new Set<GstNature>([
  'b2b',
  'sez_wpay',
  'sez_lut',
  'export_wpay',
  'export_lut',
  'deemed_export',
]);

function documentKindFor(nature: GstNature, direction: 'outward' | 'inward', allNonTaxable: boolean): DocumentKind {
  if (nature === 'no_gst' || nature === 'inward_unregistered') return 'invoice';
  if (nature === 'composition_outward' || nature === 'inward_composition') return 'bill_of_supply';
  if (allNonTaxable && direction === 'outward') return 'bill_of_supply';
  return 'tax_invoice';
}

// ───────────────────────────── Main entry ─────────────────────────────

/** Compute GST, totals and classification for an invoice. Never throws on bad input; see `warnings`. */
export function computeInvoice(lines: readonly InvoiceLineInput[], ctx: InvoiceContext): InvoiceComputation {
  const warnings: string[] = [];
  const warn: Warn = (m) => {
    if (!warnings.includes(m)) warnings.push(m);
  };

  const direction = ctx.direction === 'inward' ? 'inward' : 'outward';
  const companyRegistration =
    ctx.companyRegistration === 'composition' || ctx.companyRegistration === 'unregistered' ? ctx.companyRegistration : 'regular';
  let partyRegistration: RegistrationType = ctx.partyRegistration;
  if (!REGISTRATION_TYPES.includes(partyRegistration)) {
    warn('Party GST registration type is not set; treated as unregistered');
    partyRegistration = 'unregistered';
  }

  const companyState = normalizeStateCode(ctx.companyStateCode);
  if (!getState(companyState)) warn('Company state is not set; place of supply and tax split may be wrong');

  // Party state: as entered, else from the party's GSTIN.
  const gstin = typeof ctx.partyGstin === 'string' ? ctx.partyGstin.trim() : '';
  let partyState = normalizeStateCode(ctx.partyStateCode);
  if (!getState(partyState)) {
    if (hasText(ctx.partyStateCode)) warn(`Party state '${String(ctx.partyStateCode)}' is not a valid GST state code`);
    partyState = '';
  }
  if (hasText(ctx.consigneeStateCode) && !getState(ctx.consigneeStateCode)) {
    warn(`Consignee state '${String(ctx.consigneeStateCode)}' is not a valid GST state code`);
  }
  if (gstin) {
    const g = validateGstin(gstin);
    if (!g.valid) warn(`Party GSTIN ${g.gstin ?? gstin}: ${g.error ?? 'invalid'}`);
    const gState = gstinStateCode(gstin);
    if (g.valid && partyState && gState !== partyState) {
      warn(`Party GSTIN is registered in ${stateLabel(gState)} but the party state is ${stateLabel(partyState)}`);
    }
    if (g.valid && (partyRegistration === 'unregistered' || partyRegistration === 'consumer')) {
      warn('Party has a GSTIN but is marked as unregistered; check the GST registration type in the party ledger');
    }
    if (!partyState && getState(gState)) partyState = gState;
  } else if (ctx.partyGstin !== undefined && isRegisteredParty(partyRegistration) && partyRegistration !== 'deemed_export') {
    warn('Party is registered under GST but has no GSTIN');
  }

  const lineList: readonly InvoiceLineInput[] = Array.isArray(lines) ? lines : [];
  const work = lineList.map((l, i) => prepareLine(l, i, ctx.reverseCharge === true, warn));
  if (work.length === 0) warn('Invoice has no lines');
  capInvoiceSize(work, warn);

  // Invoice supply kind by value (decides POS rule for goods vs services; goods on a tie).
  // Charges that will be absorbed into goods lines count as goods.
  const hasGoodsTarget = work.some((l) => l.apportion === 'none' && l.supplyKind === 'goods');
  const kindOf = (l: WorkLine): SupplyKind => (l.apportion !== 'none' && hasGoodsTarget ? 'goods' : l.supplyKind);
  const goodsNet = work.filter((l) => kindOf(l) === 'goods').reduce((a, l) => a + Math.abs(l.net), 0);
  const servicesNet = work.filter((l) => kindOf(l) === 'services').reduce((a, l) => a + Math.abs(l.net), 0);
  const invoiceKind: SupplyKind = servicesNet > goodsNet ? 'services' : 'goods';

  const explicitPos = normalizeStateCode(ctx.placeOfSupply);
  if (ctx.placeOfSupply && !getState(explicitPos)) warn(`Place of supply '${ctx.placeOfSupply}' is not a valid state code; it was derived instead`);
  const pos = determinePlaceOfSupply({
    direction,
    supplyKind: invoiceKind,
    companyStateCode: companyState,
    partyStateCode: partyState,
    partyRegistration,
    consigneeStateCode: ctx.consigneeStateCode,
    explicit: ctx.placeOfSupply,
  });
  if (!pos.code) warn(pos.reason);

  // An overseas recipient with a place of supply in India (entered on the voucher, e.g. services on
  // goods or property in India — IGST Act s.13(3)–(5)) is not an export (s.2(6)(iv)): it is taxed
  // like any domestic supply to an unregistered person, intra- or inter-state by the place of supply.
  if (direction === 'outward' && partyRegistration === 'overseas' && pos.code && pos.code !== POS_OTHER_COUNTRIES) {
    warn(`Place of supply is ${stateLabel(pos.code)}, so this is not an export: GST is charged as on a domestic supply`);
    partyRegistration = 'unregistered';
  }

  // Supplier's state: ours for sales; the party's for purchases (assumed local when unknown).
  let supplierState = direction === 'outward' ? companyState : partyState;
  if (direction === 'inward' && !supplierState && partyRegistration !== 'overseas') {
    supplierState = companyState;
    if (isRegisteredParty(partyRegistration)) warn("Supplier's state is not set; treated as a supply from within our state");
  }
  const interState = isInterState(supplierState, pos.code, partyRegistration, { companyIsSez: ctx.companyIsSez === true });

  // ── Tax regime ──
  const chargesGst = companyRegistration !== 'unregistered' && !(direction === 'outward' && companyRegistration === 'composition');
  const zeroRatedUnderLut =
    direction === 'outward' && (partyRegistration === 'overseas' || partyRegistration === 'sez') && ctx.exportWithPayment !== true;
  const supplierCannotCharge =
    direction === 'inward' &&
    (partyRegistration === 'unregistered' || partyRegistration === 'consumer' || partyRegistration === 'composition');
  const isImport = direction === 'inward' && partyRegistration === 'overseas';
  // Goods from an SEZ unit cleared into the DTA are treated as imports (SEZ Act s.30, SEZ Rules r.47–48):
  // the buyer files a bill of entry and pays IGST at customs, so the SEZ supplier does not collect it —
  // exactly like import of goods. Services from an SEZ unit are an ordinary inter-state B2B supply
  // with IGST charged on the invoice.
  const fromSez = direction === 'inward' && partyRegistration === 'sez';
  const taxMode = taxModeFor(interState, pos.code, chargesGst);

  if (direction === 'outward' && companyRegistration === 'composition' && interState && goodsNet > 0) {
    warn('Composition dealers cannot make inter-state supplies of goods');
  }

  for (const l of work) {
    // Import of services is always under reverse charge (IGST Notification 10/2017).
    if (isImport && l.supplyKind === 'services') l.rc = true;
    l.taxCharged = chargesGst && l.taxability === 'taxable' && !zeroRatedUnderLut && !(supplierCannotCharge && !l.rc);
    // Import of goods (and goods from an SEZ unit): IGST is computed (it is the ITC of 4(A)(1)) but paid
    // at customs on the bill of entry, not to the supplier.
    const atCustoms = isImport || (fromSez && l.supplyKind === 'goods');
    l.payable = l.taxCharged && !l.rc && !atCustoms;
    if (l.wantsInclusive && l.apportion !== 'none' && hasGoodsTarget) {
      // The charge becomes part of the goods lines' value at their rates; its own rate is irrelevant.
      warn(`${l.label}: tax-inclusive rate ignored because the charge is apportioned into the goods lines`);
    } else if (l.wantsInclusive && l.taxCharged && l.rc) {
      warn(`${l.label}: tax-inclusive rate ignored because the line is under reverse charge`);
    } else if (l.wantsInclusive && l.taxCharged && !l.payable) {
      // Import of goods (or goods from an SEZ unit): IGST is paid at customs, so the supplier's price cannot include it.
      warn(`${l.label}: tax-inclusive rate ignored because the tax is not paid to the supplier (IGST is paid at customs on the bill of entry)`);
    } else if (l.wantsInclusive && l.taxCharged) {
      const perUnitCess = roundPaise(l.cessPerUnit * l.qty);
      l.inclusive = true;
      l.base = taxableFromInclusive(l.net - perUnitCess, l.rate + l.cessRate);
    }
    if (l.taxCharged && l.rate === 0 && taxMode !== 'none') {
      warn(`${l.label}: GST rate is 0% on a taxable line; mark it nil-rated/exempt or set the rate`);
    }
    if (l.taxability === 'taxable' && l.rate > 0 && !isStandardRate(l.rate)) {
      warn(`${l.label}: ${l.rate}% is not a standard GST rate`);
    }
    if (l.taxability === 'taxable' && isRetiredSlabOn(l.rate, ctx.invoiceDate ?? '')) {
      warn(`${l.label}: the ${l.rate}% slab was largely merged into 5%/18% from 22-Sep-2025; check the item's GST rate`);
    }
  }

  apportionCharges(work, warn);
  const buckets = computeBuckets(work, taxMode);
  for (const b of buckets) {
    if (b.taxableValue < 0) warn(`Taxable value at ${b.rate}% is negative`);
  }

  // ── Lines out ──
  const computed: ComputedLine[] = work.map((l) => {
    const tax = l.igst + l.cgst + l.sgst + l.cess;
    const taxable = l.absorbed ? 0 : l.taxable;
    const out: ComputedLine = {
      key: l.input.key,
      kind: l.input.kind === 'ledger' ? 'ledger' : 'item',
      gross: l.gross,
      discount: l.discount,
      apportioned: l.apportioned,
      taxableValue: taxable,
      postingAmount: taxable - l.apportioned,
      rate: l.rate,
      cessRate: l.cessRate,
      cessPerUnit: l.cessPerUnit,
      igst: l.igst,
      cgst: l.cgst,
      sgst: l.sgst,
      cess: l.cess,
      tax,
      taxability: l.taxability,
      hsnSac: l.hsnSac,
      supplyKind: l.supplyKind,
      qty: l.qty,
      uqc: l.uqc,
      inclusive: l.inclusive,
      taxCharged: l.taxCharged,
      reverseCharge: l.taxCharged && l.rc,
      taxPayableToParty: l.payable,
      absorbed: l.absorbed,
      total: taxable + tax,
    };
    const desc = typeof l.input.description === 'string' ? l.input.description.trim() : '';
    if (desc) out.description = desc;
    return out;
  });

  // ── Totals ──
  const sum = (f: (l: ComputedLine) => number): Paise => computed.reduce((a, l) => a + f(l), 0);
  const igst = sum((l) => l.igst);
  const cgst = sum((l) => l.cgst);
  const sgst = sum((l) => l.sgst);
  const cess = sum((l) => l.cess);
  const tax = igst + cgst + sgst + cess;
  const taxable = sum((l) => l.taxableValue);
  const reverseChargeTax = sum((l) => (l.taxCharged && !l.taxPayableToParty ? l.tax : 0));
  const invoiceValueBeforeRound = taxable + tax - reverseChargeTax;

  let grandTotal = invoiceValueBeforeRound;
  const ro = ctx.roundOff;
  if (ro?.enabled) {
    const unit = Number.isSafeInteger(ro.unit) ? ro.unit : 0;
    const method = ro.method === 'up' || ro.method === 'down' ? ro.method : 'nearest';
    if (unit < 1) warn('Round-off unit is not valid; the total was not rounded');
    else grandTotal = roundToUnit(invoiceValueBeforeRound, unit, method);
  }

  // ── Classification ──
  // Zero-value rows (e.g. the blank row the user is typing into) do not decide the document's nature.
  const kept = work.filter((l) => !l.absorbed);
  const withValue = kept.filter((l) => l.base !== 0 || l.net !== 0);
  const valued = withValue.length > 0 ? withValue : kept;
  const allNonTaxable = valued.length > 0 && valued.every((l) => l.taxability !== 'taxable');
  const goodsValue = computed.filter((l) => l.supplyKind === 'goods').reduce((a, l) => a + Math.abs(l.taxableValue), 0);
  const servicesValue = computed.filter((l) => l.supplyKind === 'services').reduce((a, l) => a + Math.abs(l.taxableValue), 0);
  const reverseCharge = chargesGst && (ctx.reverseCharge === true || computed.some((l) => l.reverseCharge));
  // A configured threshold wins; otherwise the statutory one for the invoice date (₹2.5 lakh before 1-Aug-2024).
  const threshold =
    typeof ctx.b2clThresholdPaise === 'number' && Number.isFinite(ctx.b2clThresholdPaise) ? ctx.b2clThresholdPaise : b2clThresholdOn(ctx.invoiceDate);
  const nature = classifySupply(
    {
      direction,
      companyRegistration,
      partyRegistration,
      interState,
      reverseCharge,
      exportWithPayment: ctx.exportWithPayment === true,
      b2clThresholdPaise: threshold,
    },
    { invoiceValue: grandTotal, allNonTaxable, goodsValue, servicesValue },
  );

  if (HSN_REQUIRED.has(nature)) {
    for (const l of work) {
      if (!l.absorbed && !l.hsnSac && l.taxable !== 0) warn(`${l.label}: HSN/SAC code is required on this invoice`);
    }
  }

  return {
    placeOfSupply: pos.code,
    posReason: pos.reason,
    supplierStateCode: isImport ? '96' : supplierState,
    interState,
    taxMode,
    nature,
    documentKind: documentKindFor(nature, direction, allNonTaxable),
    reverseCharge,
    lines: computed,
    buckets,
    hsnSummary: hsnSummary(computed),
    totals: {
      lineGross: sum((l) => l.gross),
      discount: sum((l) => l.discount),
      taxable,
      igst,
      cgst,
      sgst,
      cess,
      tax,
      reverseChargeTax,
      invoiceValueBeforeRound,
      roundOff: grandTotal - invoiceValueBeforeRound,
      grandTotal,
      payableToParty: grandTotal,
    },
    warnings,
  };
}
