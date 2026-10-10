/**
 * Security module routes. DTOs and the route table: src/shared/types/security.ts.
 * Access: security.manage unless noted. Every mutation is audited by its service.
 */
import { PERMISSIONS } from '../../../shared/constants.ts';
import {
  AUDIT_ACTIONS,
  AUDIT_LIST_MAX_LIMIT,
  DISPLAY_NAME_MAX_LENGTH,
  ROLE_DESCRIPTION_MAX_LENGTH,
  ROLE_NAME_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  type AuditEntityHistoryInput,
  type AuditExportInput,
  type AuditListInput,
  type SecurityDisableInput,
  type SecurityEnableInput,
  type SecurityResetPasswordInput,
  type SecurityRoleSaveInput,
  type SecuritySettingsInput,
  type SecurityUserListInput,
  type SecurityUserSaveInput,
} from '../../../shared/types/security.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { PASSWORD_MAX_LENGTH } from '../../lib/crypto.ts';
import { v, type Schema } from '../../lib/validate.ts';
import { anchorCheckFor, auditFacets, entityHistory, exportAuditLog, getAuditEntry, listAudit, resetAuditAnchor, verifyAuditLog } from './auditlog.ts';
import { permissionCatalog } from './catalog.ts';
import { describePasswordPolicy } from './policy.ts';
import { deleteRole, getRole, listRoles, saveRole } from './roles.ts';
import { mySession } from './session.ts';
import { getSecuritySettings, saveSecuritySettings } from './settings.ts';
import { disableSecurity, enableSecurity } from './toggle.ts';
import { getUser, listUsers, refuseUserDelete, resetUserPassword, saveUser, unlockUser } from './users.ts';

/** Passwords are never trimmed (spaces are significant; the policy rejects leading/trailing ones). */
const password = () => v.string({ min: 1, max: PASSWORD_MAX_LENGTH, trim: false });

const username = () =>
  v.string({
    min: USERNAME_MIN_LENGTH,
    max: USERNAME_MAX_LENGTH,
    pattern: USERNAME_PATTERN,
    patternMessage: 'Username may contain only letters, digits, dot, dash and underscore, and must start with a letter or digit',
  });

const idInput = v.object({ id: v.id() });

export const SecurityUserListInputSchema = v.object({
  search: v.string({ max: 100 }).optional(),
  roleId: v.id().optional(),
  activeOnly: v.boolean().optional(),
}) as Schema<SecurityUserListInput>;

export const SecurityUserSaveInputSchema = v.object({
  id: v.id().optional(),
  username: username(),
  displayName: v.string({ max: DISPLAY_NAME_MAX_LENGTH }).default(''),
  roleId: v.id(),
  isActive: v.boolean().default(true),
  password: v.string({ max: PASSWORD_MAX_LENGTH, trim: false }).optional(),
  mustChangePassword: v.boolean().optional(),
}) as Schema<SecurityUserSaveInput>;

export const SecurityResetPasswordInputSchema = v.object({
  id: v.id(),
  newPassword: password(),
  mustChange: v.boolean().default(true),
}) as Schema<SecurityResetPasswordInput>;

export const SecurityRoleSaveInputSchema = v.object({
  id: v.id().optional(),
  name: v.string({ min: 1, max: ROLE_NAME_MAX_LENGTH }),
  description: v.string({ max: ROLE_DESCRIPTION_MAX_LENGTH }).nullable().optional(),
  permissions: v.array(v.enum(PERMISSIONS), { max: PERMISSIONS.length * 2 }),
}) as Schema<SecurityRoleSaveInput>;

export const SecurityEnableInputSchema = v.object({
  username: username(),
  displayName: v.string({ max: DISPLAY_NAME_MAX_LENGTH }).optional(),
  password: password(),
}) as Schema<SecurityEnableInput>;

export const SecurityDisableInputSchema = v.object({ password: password() }) as Schema<SecurityDisableInput>;

/** Ranges are checked by the service (settings.ts) with accountant-friendly messages. */
export const SecuritySettingsInputSchema = v.object({
  idleTimeoutMinutes: v.int().optional(),
  passwordMinLength: v.int().optional(),
  requireMixedCase: v.boolean().optional(),
  requireSymbol: v.boolean().optional(),
  passwordExpiryDays: v.int().optional(),
  lockoutThreshold: v.int().optional(),
  lockoutMinutes: v.int().optional(),
}) as Schema<SecuritySettingsInput>;

const auditFilterShape = {
  from: v.date().optional(),
  to: v.date().optional(),
  userId: v.id().optional(),
  actions: v.array(v.enum(AUDIT_ACTIONS), { max: 50 }).optional(),
  entityType: v.string({ max: 100 }).optional(),
  entityId: v.int({ min: 0 }).optional(),
  search: v.string({ max: 200 }).optional(),
};

// Filters reject unknown keys (VALIDATION "Unknown field …") even in production: a misspelt filter such as
// `action` for `actions` must not silently return the unfiltered edit log.
export const AuditListInputSchema = v.strictObject({
  ...auditFilterShape,
  limit: v.int({ min: 1, max: AUDIT_LIST_MAX_LIMIT }).default(100),
  offset: v.int({ min: 0 }).default(0),
  order: v.enum(['asc', 'desc'] as const).default('desc'),
}) as Schema<AuditListInput>;

export const AuditEntityHistoryInputSchema = v.object({
  entityType: v.string({ min: 1, max: 100 }),
  entityId: v.int({ min: 0 }),
  entityGuid: v.string({ max: 100 }).optional(),
  currentOnly: v.boolean().optional(),
}) as Schema<AuditEntityHistoryInput>;

export const AuditExportInputSchema = v.strictObject({
  ...auditFilterShape,
  format: v.enum(['xlsx', 'csv'] as const),
}) as Schema<AuditExportInput>;

export const securityRoutes = {
  // ── Users
  'security.user.list': companyRoute({
    access: 'security.manage',
    input: SecurityUserListInputSchema,
    handler: (ctx, input) => listUsers(ctx, input),
  }),
  'security.user.get': companyRoute({
    access: 'security.manage',
    input: idInput,
    handler: (ctx, { id }) => getUser(ctx, id),
  }),
  'security.user.save': companyRoute({
    access: 'security.manage',
    input: SecurityUserSaveInputSchema,
    handler: (ctx, input) => saveUser(ctx, input),
  }),
  'security.user.resetPassword': companyRoute({
    access: 'security.manage',
    input: SecurityResetPasswordInputSchema,
    handler: (ctx, input) => resetUserPassword(ctx, input),
  }),
  'security.user.unlock': companyRoute({
    access: 'security.manage',
    input: idInput,
    handler: (ctx, { id }) => unlockUser(ctx, id),
  }),
  'security.user.delete': companyRoute({
    access: 'security.manage',
    input: idInput,
    handler: (ctx, { id }) => refuseUserDelete(ctx, id),
  }),

  // ── Roles & permissions
  'security.role.list': companyRoute({
    access: 'security.manage',
    input: v.none(),
    handler: (ctx) => listRoles(ctx.db),
  }),
  'security.role.get': companyRoute({
    access: 'security.manage',
    input: idInput,
    handler: (ctx, { id }) => getRole(ctx.db, id),
  }),
  'security.role.save': companyRoute({
    access: 'security.manage',
    input: SecurityRoleSaveInputSchema,
    handler: (ctx, input) => saveRole(ctx, input),
  }),
  'security.role.delete': companyRoute({
    access: 'security.manage',
    input: idInput,
    handler: (ctx, { id }) => deleteRole(ctx, id),
  }),
  'security.permissions.catalog': companyRoute({
    access: 'authenticated',
    input: v.none(),
    transactional: false,
    handler: () => permissionCatalog(),
  }),

  // ── Security on / off (async: scrypt runs off the main thread; services manage their own transaction)
  'security.enable': companyRoute({
    access: 'company.manage',
    input: SecurityEnableInputSchema,
    transactional: false,
    handler: (ctx, input) => enableSecurity(ctx, input),
  }),
  'security.disable': companyRoute({
    access: 'security.manage',
    input: SecurityDisableInputSchema,
    transactional: false,
    handler: (ctx, input) => disableSecurity(ctx, input),
  }),

  // ── Settings
  'security.settings.get': companyRoute({
    access: 'security.manage',
    input: v.none(),
    handler: (ctx) => getSecuritySettings(ctx.db),
  }),
  'security.settings.save': companyRoute({
    access: 'security.manage',
    input: SecuritySettingsInputSchema,
    handler: (ctx, input) => saveSecuritySettings(ctx, input),
  }),
  'security.passwordPolicy': companyRoute({
    access: 'authenticated',
    input: v.none(),
    handler: (ctx) => describePasswordPolicy(getSecuritySettings(ctx.db)),
  }),

  // ── Edit log (read-only, heavy → not wrapped in a transaction)
  'security.audit.list': companyRoute({
    access: 'audit.view',
    input: AuditListInputSchema,
    transactional: false,
    handler: (ctx, input) => listAudit(ctx.db, input),
  }),
  'security.audit.facets': companyRoute({
    access: 'audit.view',
    input: v.none(),
    transactional: false,
    handler: (ctx) => auditFacets(ctx.db),
  }),
  'security.audit.get': companyRoute({
    access: 'audit.view',
    input: idInput,
    transactional: false,
    handler: (ctx, { id }) => getAuditEntry(ctx.db, id),
  }),
  'security.audit.entityHistory': companyRoute({
    access: 'audit.view',
    input: AuditEntityHistoryInputSchema,
    transactional: false,
    handler: (ctx, input) => entityHistory(ctx.db, input),
  }),
  'security.audit.verify': companyRoute({
    access: 'audit.view',
    input: v.none(),
    transactional: false,
    handler: (ctx) => verifyAuditLog(ctx.db, ctx.clock.now(), anchorCheckFor(ctx)),
  }),
  'security.audit.resetAnchor': companyRoute({
    access: 'audit.view', // and Owner only (service)
    input: v.none(),
    transactional: false,
    handler: (ctx) => resetAuditAnchor(ctx),
  }),
  'security.audit.export': companyRoute({
    access: 'audit.view', // data.export is checked by the service as well
    input: AuditExportInputSchema,
    transactional: false,
    handler: (ctx, input) => exportAuditLog(ctx, input),
  }),

  // ── Session
  'security.mySession': companyRoute({
    access: 'authenticated',
    input: v.none(),
    handler: (ctx) => mySession(ctx),
  }),
} satisfies RouteMap;
