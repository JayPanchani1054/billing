/**
 * GST rate slabs (IGST rate; CGST and SGST/UTGST are half each).
 *
 * Notes on the slab list:
 *  - From 22-Sep-2025 (GST 2.0 rationalisation, 56th GST Council) most goods and services moved to
 *    the 5% / 18% slabs, with 40% for sin/luxury goods; the 12% and 28% slabs were largely retired
 *    (28% + compensation cess survives only for tobacco products until the cess ends).
 *  - Historical rates remain valid for supplies made before that date, for credit/debit notes against
 *    older invoices and for amendments — so the engine never rejects them.
 *  - Special rates: 0.1% (supplies to merchant exporters), 0.25% (rough precious stones),
 *    1% / 1.5% (affordable housing, cut diamonds), 3% (gold, silver, jewellery),
 *    6% (some job work / handicrafts), 7.5% (hotel/restaurant and real-estate schemes).
 */

export const GST_RATES: readonly number[] = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

/** Slabs commonly offered in rate pickers for invoices dated on/after the rationalisation date. */
export const GST_CORE_RATES_2025: readonly number[] = [0, 5, 18, 40];

/** Effective date of the Sept-2025 rate rationalisation. */
export const GST_RATIONALISATION_DATE = '2025-09-22';

/** Slabs retired for (almost) all supplies by the rationalisation. */
export const GST_RETIRED_SLABS_2025: readonly number[] = [12, 28];

const EPS = 1e-9;

/** True when `rate` is one of the notified GST slabs (0.1 ≠ 0.11). */
export function isStandardRate(rate: number): boolean {
  return Number.isFinite(rate) && GST_RATES.some((r) => Math.abs(r - rate) < EPS);
}

/** A rate the engine can compute with: finite, 0 ≤ rate ≤ 100. */
export function isValidRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 0 && rate <= 100;
}

/** A cess rate the engine can compute with: finite, 0 ≤ rate ≤ 400. */
export function isValidCessRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= 0 && rate <= 400;
}

/** CGST and SGST/UTGST rates for an IGST rate: 18 → { cgst: 9, sgst: 9 }; 0.25 → 0.125 each. */
export function splitRate(rate: number): { cgst: number; sgst: number } {
  const half = rate / 2;
  return { cgst: half, sgst: half };
}

/** Picker options: '18%' labels, ordered by rate. */
export function rateOptions(rates: readonly number[] = GST_RATES): Array<{ value: number; label: string }> {
  return [...rates].sort((a, b) => a - b).map((r) => ({ value: r, label: `${r}%` }));
}

/**
 * True when a slab was retired by the 2025 rationalisation and the document is dated on/after it
 * (used for a soft warning only — the rate may still be right, e.g. tobacco at 28%).
 */
export function isRetiredSlabOn(rate: number, isoDate: string): boolean {
  return isoDate >= GST_RATIONALISATION_DATE && GST_RETIRED_SLABS_2025.some((r) => Math.abs(r - rate) < EPS);
}
