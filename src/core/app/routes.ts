/**
 * App-scope routes: data directory, company registry (list/create/open/close/delete), login.
 * Contract and DTOs: src/shared/types/app.ts. Handlers delegate to the AppController that owns
 * the runtime state (resolved from ctx.app).
 */
import type {
  AppState,
  ChangePasswordInput,
  CompanyListItem,
  CreateCompanyInput,
  DataDirChangeInput,
  DeleteCompanyInput,
  LoginInput,
  OpenResult,
  SessionInfo,
} from '../../shared/types/app.ts';
import { appRoute, type RouteMap } from '../api/route.ts';
import { passwordPolicy } from '../lib/crypto.ts';
import { v, type Schema } from '../lib/validate.ts';
import { CompanyFeaturesInputSchema } from '../modules/company/routes.ts';
import { companyFieldShape } from '../modules/company/validation.ts';
import { controllerFor } from './controller.ts';

const secret = (max = 256) => v.string({ min: 1, max, trim: false });

export const OwnerInputSchema = v.object({
  username: v.string({
    min: 3,
    max: 32,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    patternMessage: 'Username may contain letters, digits, dot, dash and underscore',
  }),
  displayName: v.string({ max: 80 }).optional(),
  password: secret().refine((pw) => passwordPolicy(pw)),
});

export const CreateCompanyInputSchema = v.object({
  ...companyFieldShape,
  features: CompanyFeaturesInputSchema.optional(),
  owner: OwnerInputSchema.optional(),
}) as unknown as Schema<CreateCompanyInput>;

export const LoginInputSchema = v.object({
  username: v.string({ min: 1, max: 64 }),
  password: secret(),
}) as Schema<LoginInput>;

export const ChangePasswordInputSchema = v.object({
  currentPassword: secret(),
  newPassword: secret(),
}) as Schema<ChangePasswordInput>;

export const DataDirChangeInputSchema = v.object({
  path: v.string({ min: 1, max: 1000 }),
  mode: v.enum(['use', 'move', 'copy'] as const),
}) as Schema<DataDirChangeInput>;

export const DeleteCompanyInputSchema = v.object({
  id: v.string({ min: 1, max: 80 }),
  confirmName: v.string({ min: 1, max: 200 }),
  username: v.string({ max: 64 }).optional(),
  password: v.string({ max: 256, trim: false }).optional(),
}) as Schema<DeleteCompanyInput>;

export const appRoutes = {
  'app.state': appRoute({
    access: 'public',
    input: v.none(),
    handler: (ctx): AppState => controllerFor(ctx.app).state(),
  }),
  'app.dataDir.set': appRoute({
    access: 'public', // refused while a company is open
    input: DataDirChangeInputSchema,
    handler: (ctx, input): Promise<AppState> => controllerFor(ctx.app).setDataDir(input),
  }),
  'app.company.list': appRoute({
    access: 'public',
    input: v.none(),
    handler: (ctx): CompanyListItem[] => controllerFor(ctx.app).listCompanies(),
  }),
  'app.company.create': appRoute({
    access: 'public',
    input: CreateCompanyInputSchema,
    handler: (ctx, input): Promise<OpenResult> => controllerFor(ctx.app).createCompany(input),
  }),
  'app.company.open': appRoute({
    access: 'public',
    input: v.object({ id: v.string({ min: 1, max: 80 }) }),
    handler: (ctx, input): Promise<OpenResult> => controllerFor(ctx.app).openCompany(input.id),
  }),
  'app.auth.login': appRoute({
    access: 'public',
    input: LoginInputSchema,
    handler: (ctx, input): Promise<OpenResult> => controllerFor(ctx.app).loginUser(input),
  }),
  'app.auth.logout': appRoute({
    access: 'public',
    input: v.none(),
    handler: (ctx): Promise<AppState> => controllerFor(ctx.app).logout(),
  }),
  'app.auth.changePassword': appRoute({
    access: 'authenticated',
    input: ChangePasswordInputSchema,
    handler: (ctx, input): Promise<{ ok: true }> => controllerFor(ctx.app).changeOwnPassword(input),
  }),
  'app.company.close': appRoute({
    access: 'public',
    input: v.none(),
    handler: (ctx): Promise<AppState> => controllerFor(ctx.app).closeCompany(),
  }),
  'app.company.delete': appRoute({
    access: 'public', // destructive: requires typed name, company closed, and Owner password when secured
    input: DeleteCompanyInputSchema,
    handler: (ctx, input): Promise<CompanyListItem[]> => controllerFor(ctx.app).deleteCompany(input),
  }),
  'app.session.touch': appRoute({
    access: 'public',
    input: v.none(),
    handler: (ctx): SessionInfo | null => controllerFor(ctx.app).touchSession(),
  }),
} satisfies RouteMap;
