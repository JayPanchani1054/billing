/**
 * Route contract. Every backend capability is a named route with a validated input schema,
 * an access rule and a handler. Modules export a RouteMap; src/core/api/routes.ts aggregates them.
 *
 * Naming: '<module>.<entity>.<action>' e.g. 'accounts.ledger.list', 'vouchers.save', 'gst.gstr1.summary'.
 *
 *   export const accountsRoutes = {
 *     'accounts.ledger.get': companyRoute({
 *       access: 'masters.view',
 *       input: v.object({ id: v.id() }),
 *       handler: (ctx, { id }) => getLedger(ctx.db, id),
 *     }),
 *   } satisfies RouteMap;
 */
import type { Permission } from '../../shared/constants.ts';
import type { Schema } from '../lib/validate.ts';
import type { AppCtx, CompanyCtx } from './context.ts';

/**
 * - a Permission: the session must hold it (Owner holds all).
 * - 'authenticated': any logged-in session (or implicit session when security is off).
 * - 'public': no session needed (app-scope only: list companies, login, app config).
 */
export type RouteAccess = Permission | 'authenticated' | 'public';

export interface CompanyRoute<I, O> {
  scope: 'company';
  access: Exclude<RouteAccess, 'public'>;
  input: Schema<I>;
  /**
   * Company routes run inside one DB transaction unless this is `false` (default: true for every
   * company route). A transactional handler MUST be synchronous: if it returns a Promise the
   * dispatcher rolls back and fails the call with INTERNAL. Set `transactional: false` for async
   * handlers (they wrap their own writes in ctx.db.transaction(...)) and for heavy read-only reports.
   */
  transactional?: boolean;
  handler: (ctx: CompanyCtx, input: I) => O | Promise<O>;
}

export interface AppRoute<I, O> {
  scope: 'app';
  access: RouteAccess;
  input: Schema<I>;
  handler: (ctx: AppCtx, input: I) => O | Promise<O>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = CompanyRoute<any, any> | AppRoute<any, any>;
export type RouteMap = Record<string, AnyRoute>;

export function companyRoute<I, O>(def: Omit<CompanyRoute<I, O>, 'scope'>): CompanyRoute<I, O> {
  return { ...def, scope: 'company' };
}

export function appRoute<I, O>(def: Omit<AppRoute<I, O>, 'scope'>): AppRoute<I, O> {
  return { ...def, scope: 'app' };
}

export type RouteInput<R> = R extends { input: Schema<infer I> } ? I : never;
export type RouteOutput<R> = R extends { handler: (...args: never[]) => infer O } ? Awaited<O> : never;
