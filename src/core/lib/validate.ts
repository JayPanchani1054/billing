/**
 * Minimal, dependency-free runtime validator with static type inference (zod-like).
 * Every API route declares its input with this; the dispatcher validates before the handler runs.
 *
 *   const Input = v.object({ name: v.string({ min: 1, max: 100 }), rate: v.number({ min: 0 }).optional() });
 *   type Input = Infer<typeof Input>;
 */
import type { FieldIssue } from '../../shared/api.ts';
import { validation } from './errors.ts';

export interface Schema<T> {
  /** Phantom field for type inference only. */
  readonly _type?: T;
  /** Returns the parsed (possibly coerced/trimmed) value or pushes issues and returns undefined. */
  check(value: unknown, path: string, issues: FieldIssue[]): T | undefined;
  optional(): Schema<T | undefined>;
  nullable(): Schema<T | null>;
  default(value: T): Schema<T>;
  /** Extra validation; return an error message to fail. */
  refine(fn: (value: T) => string | null | undefined): Schema<T>;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function make<T>(check: Schema<T>['check']): Schema<T> {
  const self: Schema<T> = {
    check,
    optional: () =>
      make<T | undefined>((value, path, issues) => (value === undefined || value === null ? undefined : check(value, path, issues))),
    nullable: () => make<T | null>((value, path, issues) => (value === null || value === undefined ? null : check(value, path, issues))),
    default: (def: T) => make<T>((value, path, issues) => (value === undefined || value === null ? def : check(value, path, issues))),
    refine: (fn) =>
      make<T>((value, path, issues) => {
        const before = issues.length;
        const out = check(value, path, issues);
        if (issues.length > before || out === undefined) return out;
        const msg = fn(out);
        if (msg) {
          issues.push({ path, message: msg });
          return undefined;
        }
        return out;
      }),
  };
  return self;
}

const fail = (issues: FieldIssue[], path: string, message: string): undefined => {
  issues.push({ path: path || '(root)', message });
  return undefined;
};

const label = (path: string): string => (path ? path : 'Value');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

type Shape = Record<string, Schema<unknown>>;

/** What `v.object` does with keys outside its shape (see `v.object`). */
export type UnknownKeys = 'strip' | 'reject';

/** Policy of the `parse()` call in progress, for objects that do not choose one. */
let activeUnknownKeys: UnknownKeys = 'strip';

/** ' — did you mean "actions"?' when a declared key is a near miss (case, plural, one edit or swap). */
function unknownHint(key: string, keys: readonly string[]): string {
  const k = key.toLowerCase();
  const near = keys.find((c) => {
    const x = c.toLowerCase();
    return x === k || x === `${k}s` || `${x}s` === k || editDistanceAtMostOne(x, k);
  });
  return near ? ` — did you mean "${near}"?` : '';
}

/** One insertion, deletion, substitution or swap of two neighbouring letters apart ('qyt' ~ 'qty'). */
function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return a === b;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length && diff.length <= 2; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp; patternMessage?: string; trim?: boolean } = {}): Schema<string> {
    const { min, max = 10_000, pattern, patternMessage, trim = true } = opts;
    return make<string>((value, path, issues) => {
      if (typeof value !== 'string') return fail(issues, path, `${label(path)} must be text`);
      const s = trim ? value.trim() : value;
      if (min !== undefined && s.length < min)
        return fail(issues, path, min === 1 ? `${label(path)} is required` : `${label(path)} must be at least ${min} characters`);
      if (s.length > max) return fail(issues, path, `${label(path)} must be at most ${max} characters`);
      if (pattern && !pattern.test(s)) return fail(issues, path, patternMessage ?? `${label(path)} has an invalid format`);
      return s;
    });
  },

  number(opts: { min?: number; max?: number } = {}): Schema<number> {
    return make<number>((value, path, issues) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(issues, path, `${label(path)} must be a number`);
      if (opts.min !== undefined && value < opts.min) return fail(issues, path, `${label(path)} must be ≥ ${opts.min}`);
      if (opts.max !== undefined && value > opts.max) return fail(issues, path, `${label(path)} must be ≤ ${opts.max}`);
      return value;
    });
  },

  int(opts: { min?: number; max?: number } = {}): Schema<number> {
    return make<number>((value, path, issues) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail(issues, path, `${label(path)} must be a whole number`);
      if (opts.min !== undefined && value < opts.min) return fail(issues, path, `${label(path)} must be ≥ ${opts.min}`);
      if (opts.max !== undefined && value > opts.max) return fail(issues, path, `${label(path)} must be ≤ ${opts.max}`);
      return value;
    });
  },

  /** Positive integer primary key. */
  id(): Schema<number> {
    return v.int({ min: 1 });
  },

  /** Money in integer paise (may be negative unless min given). */
  paise(opts: { min?: number; max?: number } = {}): Schema<number> {
    return v.int({ min: opts.min ?? -9e14, max: opts.max ?? 9e14 });
  },

  boolean(): Schema<boolean> {
    return make<boolean>((value, path, issues) =>
      typeof value === 'boolean' ? value : fail(issues, path, `${label(path)} must be true or false`),
    );
  },

  /** ISO calendar date 'YYYY-MM-DD'. */
  date(): Schema<string> {
    return make<string>((value, path, issues) =>
      typeof value === 'string' && isValidIsoDate(value) ? value : fail(issues, path, `${label(path)} must be a valid date`),
    );
  },

  literal<const L extends string | number | boolean>(lit: L): Schema<L> {
    return make<L>((value, path, issues) => (value === lit ? lit : fail(issues, path, `${label(path)} must be ${String(lit)}`)));
  },

  enum<const E extends readonly string[]>(values: E): Schema<E[number]> {
    return make<E[number]>((value, path, issues) =>
      typeof value === 'string' && (values as readonly string[]).includes(value)
        ? (value as E[number])
        : fail(issues, path, `${label(path)} must be one of: ${values.join(', ')}`),
    );
  },

  array<T>(item: Schema<T>, opts: { min?: number; max?: number } = {}): Schema<T[]> {
    const { min, max = 100_000 } = opts;
    return make<T[]>((value, path, issues) => {
      if (!Array.isArray(value)) return fail(issues, path, `${label(path)} must be a list`);
      if (min !== undefined && value.length < min) return fail(issues, path, `${label(path)} needs at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
      if (value.length > max) return fail(issues, path, `${label(path)} has too many entries (max ${max})`);
      const out: T[] = [];
      const before = issues.length;
      value.forEach((el, i) => {
        const r = item.check(el, `${path}[${i}]`, issues);
        out.push(r as T);
      });
      return issues.length > before ? undefined : out;
    });
  },

  /**
   * An object with exactly these keys. Keys outside the shape are never passed on; whether they are an
   * error depends on `opts.unknownKeys`:
   *   'reject' — always a VALIDATION issue naming the key (`strictObject`; use it for filters, where a
   *              misspelt key would silently widen the result);
   *   'strip'  — always dropped silently (inputs that legitimately carry extra keys, e.g. a DTO sent back);
   *   omitted  — the policy of the current `parse()` call: dropped by default, rejected when the
   *              dispatcher runs in strict mode (the test suite and development builds; see
   *              `setStrictRouteInput` in api/dispatch.ts).
   */
  object<S extends Shape>(shape: S, opts: { unknownKeys?: UnknownKeys } = {}): Schema<InferShape<S>> {
    const keys = Object.keys(shape);
    const known = new Set(keys);
    return make<InferShape<S>>((value, path, issues) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(issues, path, `${label(path)} must be an object`);
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const before = issues.length;
      for (const key of keys) {
        const r = shape[key].check(src[key], path ? `${path}.${key}` : key, issues);
        if (r !== undefined) out[key] = r;
      }
      if ((opts.unknownKeys ?? activeUnknownKeys) === 'reject') {
        for (const key of Object.keys(src)) {
          // An undefined value is how JavaScript callers leave an optional field out; it carries nothing.
          if (known.has(key) || src[key] === undefined) continue;
          const at = path ? `${path}.${key}` : key;
          issues.push({ path: at, message: `Unknown field "${key}"${unknownHint(key, keys)}` });
        }
      }
      return issues.length > before ? undefined : (out as InferShape<S>);
    });
  },

  /** `object` that always rejects keys outside the shape (filters, list and report inputs). */
  strictObject<S extends Shape>(shape: S): Schema<InferShape<S>> {
    return v.object(shape, { unknownKeys: 'reject' });
  },

  record<T>(valueSchema: Schema<T>): Schema<Record<string, T>> {
    return make<Record<string, T>>((value, path, issues) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(issues, path, `${label(path)} must be an object`);
      const out: Record<string, T> = {};
      const before = issues.length;
      for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
        const r = valueSchema.check(val, path ? `${path}.${k}` : k, issues);
        if (r !== undefined) out[k] = r;
      }
      return issues.length > before ? undefined : out;
    });
  },

  /** Raw bytes (Uint8Array) — e.g. a logo or an imported file. */
  bytes(opts: { max?: number } = {}): Schema<Uint8Array> {
    const max = opts.max ?? 50 * 1024 * 1024;
    return make<Uint8Array>((value, path, issues) => {
      if (!(value instanceof Uint8Array)) return fail(issues, path, `${label(path)} must be binary data`);
      if (value.byteLength > max) return fail(issues, path, `${label(path)} is too large`);
      return value;
    });
  },

  /** Accepts anything (use sparingly; prefer a precise schema). */
  unknown(): Schema<unknown> {
    return make<unknown>((value) => value);
  },

  /** Empty input for routes that take no parameters. */
  none(): Schema<Record<string, never>> {
    return make<Record<string, never>>(() => ({}));
  },
};

/**
 * Validate or throw AppError('VALIDATION') with all field issues. `opts.unknownKeys` sets what objects
 * without their own policy do with keys outside their shape (default: drop them).
 */
export function parse<T>(schema: Schema<T>, value: unknown, opts: { unknownKeys?: UnknownKeys } = {}): T {
  const issues: FieldIssue[] = [];
  const previous = activeUnknownKeys;
  activeUnknownKeys = opts.unknownKeys ?? 'strip';
  let out: T | undefined;
  try {
    out = schema.check(value, '', issues);
  } finally {
    activeUnknownKeys = previous;
  }
  if (issues.length > 0 || out === undefined) {
    throw validation(issues.length ? issues : [{ path: '(root)', message: 'Invalid input' }]);
  }
  return out;
}
