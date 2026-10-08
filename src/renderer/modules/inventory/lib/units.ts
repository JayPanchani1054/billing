/**
 * Unit helpers for the inventory screens (pure, tested in units.test.ts): conversion text such as
 * "1 Box = 12 Nos", the compound unit symbol the core generates ("Box of 12 Nos"), and GST UQC
 * suggestions for the unit form.
 */
import { DEFAULT_GOODS_UQC, isValidUqc, suggestUqc, UQC_LIST, uqcDescription } from '../../../../shared/gst/index.ts';
import { formatIndianNumber } from '../../../../shared/format.ts';

/** Most decimal places a conversion factor is shown with (the core stores a REAL). */
const MAX_CONVERSION_DECIMALS = 6;

/**
 * A conversion factor for display: Indian grouping, trailing zeros trimmed, at most 6 decimals.
 * 12 → '12', 2.5 → '2.5', 1000 → '1,000', 0.3333333 → '0.333333'. Non-finite or ≤ 0 → ''.
 */
export function formatConversion(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '';
  const fixed = n.toFixed(MAX_CONVERSION_DECIMALS);
  const frac = (fixed.split('.')[1] ?? '').replace(/0+$/, '');
  return formatIndianNumber(n, frac.length);
}

/**
 * "1 Box = 12 Nos" — how a compound unit (first, conversion, second) or an item's alternate unit
 * reads to a shopkeeper. Returns '' until all three parts are known.
 */
export function conversionText(first: string | null | undefined, conversion: number | null | undefined, second: string | null | undefined): string {
  const f = (first ?? '').trim();
  const s = (second ?? '').trim();
  const c = formatConversion(conversion);
  if (!f || !s || !c) return '';
  return `1 ${f} = ${c} ${s}`;
}

/**
 * An item's alternate unit: `altConversion` base units make 1 alternate unit
 * (StockItemDetail.altConversion). → "1 Box = 12 Nos".
 */
export function altUnitText(baseSymbol: string | null | undefined, altSymbol: string | null | undefined, altConversion: number | null | undefined): string {
  return conversionText(altSymbol, altConversion, baseSymbol);
}

/**
 * The symbol the core generates for a compound unit (mirror of core `compoundSymbol`):
 * ('Box', 12, 'Nos') → 'Box of 12 Nos'. Returns '' until all parts are known.
 */
export function compoundSymbolPreview(first: string | null | undefined, conversion: number | null | undefined, second: string | null | undefined): string {
  const f = (first ?? '').trim();
  const s = (second ?? '').trim();
  if (!f || !s || conversion === null || conversion === undefined || !Number.isFinite(conversion) || conversion <= 0) return '';
  return `${f} of ${Number(conversion.toPrecision(12))} ${s}`;
}

/**
 * Convert a quantity typed in the alternate unit to base units: 3 Box × 12 = 36 Nos.
 * Rounded to the base unit's decimal places (half away from zero).
 */
export function altToBase(altQty: number, altConversion: number, baseDecimals: number): number {
  const f = 10 ** Math.max(0, Math.min(6, Math.floor(baseDecimals)));
  const raw = altQty * altConversion;
  const r = (Math.sign(raw) * Math.round(Math.abs(raw) * f + 1e-9)) / f;
  return r === 0 ? 0 : r;
}

export interface UqcSuggestion {
  /** The suggested code ('KGS'). */
  code: string;
  /** 'KGS – Kilograms'. */
  label: string;
  /** True when nothing matched and the fallback 'OTH' (Others) is suggested. */
  isFallback: boolean;
  /** One plain-language line for the form hint. */
  hint: string;
}

/**
 * Suggest the GST UQC for a unit from its symbol, then its formal name ('Kg' → KGS; 'Bx' with formal
 * name 'Boxes' → BOX). Same rule as the core default when no UQC is given.
 */
export function uqcSuggestion(symbol: string | null | undefined, formalName?: string | null): UqcSuggestion {
  const bySymbol = suggestUqc(symbol);
  const code = bySymbol !== DEFAULT_GOODS_UQC || !(formalName ?? '').trim() ? bySymbol : suggestUqc(formalName);
  const isFallback = code === DEFAULT_GOODS_UQC;
  const label = `${code} – ${uqcDescription(code) || code}`;
  const hint = !(symbol ?? '').trim()
    ? 'The GST quantity code used in GSTR-1 and e-way bills. Type the symbol first to get a suggestion.'
    : isFallback
      ? `No standard GST code matches '${(symbol ?? '').trim()}', so OTH (Others) is suggested. Pick a closer code if there is one.`
      : `Suggested from '${(symbol ?? '').trim()}': ${label}.`;
  return { code, label, isFallback, hint };
}

export interface UqcOption {
  value: string;
  label: string;
}

/**
 * Options for the UQC select: the suggested code first (marked "suggested"), then every code in
 * alphabetical order. The suggestion is not repeated.
 */
export function uqcSelectOptions(suggested: string | null | undefined): UqcOption[] {
  const s = (suggested ?? '').trim().toUpperCase();
  const all = UQC_LIST.map((u) => ({ value: u.code, label: `${u.code} – ${u.description}` }));
  if (!isValidUqc(s)) return all;
  const first = all.find((o) => o.value === s);
  return first ? [{ value: first.value, label: `${first.label} (suggested)` }, ...all.filter((o) => o.value !== s)] : all;
}

/** Validate a simple unit draft. Returns field → message. */
export function validateSimpleUnit(d: { symbol: string; decimalPlaces: number | null }): { symbol?: string; decimalPlaces?: string } {
  const out: { symbol?: string; decimalPlaces?: string } = {};
  const sym = d.symbol.trim();
  if (!sym) out.symbol = 'Enter the unit symbol, e.g. Nos, Kg or Box';
  else if (sym.length > 30) out.symbol = 'Keep the symbol short (30 characters at most)';
  const dp = d.decimalPlaces;
  if (dp !== null && (!Number.isInteger(dp) || dp < 0 || dp > 4)) out.decimalPlaces = 'Decimal places must be a whole number from 0 to 4';
  return out;
}

/** Validate a compound unit draft. Returns field → message. */
export function validateCompoundUnit(d: { firstUnitId: number | null; conversion: number | null; secondUnitId: number | null }): {
  firstUnitId?: string;
  conversion?: string;
  secondUnitId?: string;
} {
  const out: { firstUnitId?: string; conversion?: string; secondUnitId?: string } = {};
  if (d.firstUnitId === null) out.firstUnitId = 'Choose the bigger unit, e.g. Box';
  if (d.secondUnitId === null) out.secondUnitId = 'Choose the smaller unit, e.g. Nos';
  if (d.firstUnitId !== null && d.firstUnitId === d.secondUnitId) out.secondUnitId = 'The two units must be different';
  if (d.conversion === null || !Number.isFinite(d.conversion) || d.conversion <= 0) out.conversion = 'Enter how many of the smaller unit make one bigger unit (more than 0)';
  return out;
}
