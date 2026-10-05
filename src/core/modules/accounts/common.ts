/** Small helpers shared by the accounts services (permissions, text normalisation, search). */
import type { FieldIssue } from '../../../shared/api.ts';
import type { Permission } from '../../../shared/constants.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { forbidden, validation } from '../../lib/errors.ts';

const PERMISSION_WORDS: Partial<Record<Permission, string>> = {
  'masters.view': 'view masters',
  'masters.create': 'create masters',
  'masters.alter': 'alter masters',
  'masters.delete': 'delete masters',
};

/** Throw FORBIDDEN unless the session is the Owner or holds `perm`. */
export function requirePermission(ctx: CompanyCtx, perm: Permission): void {
  if (ctx.session.isOwner || ctx.session.permissions.has(perm)) return;
  const what = PERMISSION_WORDS[perm] ?? perm;
  throw forbidden(`You do not have permission to ${what}. Ask the company owner to give your role the '${perm}' right.`);
}

/** Permission needed by a save: create when there is no id, alter otherwise. */
export function requireSavePermission(ctx: CompanyCtx, id: number | undefined): void {
  requirePermission(ctx, id === undefined ? 'masters.create' : 'masters.alter');
}

/** Trimmed text, or null for null/undefined/blank. */
export function cleanText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

/** Upper-case without inner spaces, or null when blank (PAN, GSTIN, IFSC). */
export function cleanCode(s: string | null | undefined): string | null {
  const t = cleanText(s);
  return t === null ? null : t.replace(/\s+/g, '').toUpperCase();
}

/** `%term%` LIKE pattern with \ escaping (use with ESCAPE '\'). */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Collects field issues and throws one VALIDATION error with all of them. */
export class Issues {
  readonly list: FieldIssue[] = [];

  add(path: string, message: string): void {
    this.list.push({ path, message });
  }

  get empty(): boolean {
    return this.list.length === 0;
  }

  has(path: string): boolean {
    return this.list.some((i) => i.path === path);
  }

  throwIfAny(): void {
    if (this.list.length > 0) throw validation(this.list);
  }
}

/** 'a', 'a and b', 'a, b and c' */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** '1 voucher' / '3 vouchers' */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}


/** VALIDATION when a from/to range is reversed. */
export function assertRange(from: string | undefined, to: string | undefined): void {
  if (from && to && from > to) throw validation([{ path: 'from', message: 'The period starts after it ends. Check the From and To dates.' }]);
}
