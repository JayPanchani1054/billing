/**
 * Extra schema combinators on top of validate.ts for partial-update ("patch") inputs, where the
 * difference between an omitted key and an explicit null matters:
 *
 *   v.x().optional()        omitted → undefined, null → undefined   (validate.ts)
 *   v.x().nullable()        omitted → null,      null → null        (validate.ts)
 *   patchNullable(v.x())    omitted → undefined, null → null        (keep vs clear)
 *   requiredNullable(v.x()) omitted → error,     null → null        (explicit clear required)
 */
import type { FieldIssue } from '../../shared/api.ts';
import type { Schema } from './validate.ts';

/** Build a Schema from a check function with the same combinator semantics as validate.ts. */
export function customSchema<T>(check: Schema<T>['check']): Schema<T> {
  const self: Schema<T> = {
    check,
    optional: () => customSchema<T | undefined>((value, path, issues) => (value === undefined || value === null ? undefined : check(value, path, issues))),
    nullable: () => customSchema<T | null>((value, path, issues) => (value === null || value === undefined ? null : check(value, path, issues))),
    default: (def: T) => customSchema<T>((value, path, issues) => (value === undefined || value === null ? def : check(value, path, issues))),
    refine: (fn) =>
      customSchema<T>((value, path, issues) => {
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

/** Omitted → undefined (keep current), null → null (clear), otherwise validated by `inner`. */
export function patchNullable<T>(inner: Schema<T>): Schema<T | null | undefined> {
  return customSchema<T | null | undefined>((value, path, issues: FieldIssue[]) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return inner.check(value, path, issues);
  });
}

/** Must be present: null is accepted as an explicit "none", undefined is an error. */
export function requiredNullable<T>(inner: Schema<T>, message?: string): Schema<T | null> {
  return customSchema<T | null>((value, path, issues: FieldIssue[]) => {
    if (value === undefined) {
      issues.push({ path: path || '(root)', message: message ?? `${path || 'Value'} is required` });
      return undefined;
    }
    if (value === null) return null;
    return inner.check(value, path, issues);
  });
}
