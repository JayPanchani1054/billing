/**
 * "More details" auto-reveal (2.1, SPEC-21 D23 / R11). A collapsed disclosure must never hide data:
 * the section opens by itself when any field inside it holds a value or an error, or when the caller
 * forces it (Alteration of a master that already uses the section, a deep link to a field). Pure, so
 * every form kind can share it and the rule is unit-tested once (disclosure.test.ts).
 */

/** Values/errors keyed by field name (a form's draft, a validation result). */
export type FieldMap = Readonly<Record<string, unknown>>;

export interface RevealOptions {
  /**
   * A field's default value counts as "empty": a select that starts at 'inherit', a currency that
   * starts at the base currency. Compared with `sameValue` (strings trimmed, numbers by value).
   */
  defaults?: FieldMap;
  /** Always reveal (the caller knows better: alteration of a record that uses the section…). */
  forced?: boolean;
}

/**
 * Whether a value is "something the user would miss": not null/undefined, not a blank string, not 0,
 * not false, not an empty array or an object whose own values are all empty (a nested address).
 */
export function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.some(hasValue);
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasValue);
  return true;
}

/** Equality used for defaults: strings compare trimmed, everything else with Object.is (arrays/objects by JSON). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (Object.is(a, b)) return true;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/** The fields (in the order given) that keep the section open: an error, or a non-default value. */
export function revealingFields(fields: readonly string[], values: FieldMap, errors?: FieldMap | null, options: RevealOptions = {}): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const err = errors ? errors[f] : undefined;
    if (hasValue(err)) {
      out.push(f);
      continue;
    }
    const v = values[f];
    if (!hasValue(v)) continue;
    if (options.defaults && Object.prototype.hasOwnProperty.call(options.defaults, f) && sameValue(v, options.defaults[f])) continue;
    out.push(f);
  }
  return out;
}

/**
 * True when a collapsed section holding `fields` must show itself: forced, or any of its fields has
 * an error or a value other than its default. False means it may stay collapsed (every field empty).
 */
export function shouldReveal(fields: readonly string[], values: FieldMap, errors?: FieldMap | null, options: RevealOptions = {}): boolean {
  if (options.forced) return true;
  return revealingFields(fields, values, errors, options).length > 0;
}
