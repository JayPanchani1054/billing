/**
 * 2.0 (block 250–299), WP-04: the permission `vouchers.renumber` ("Change voucher numbers and the next
 * number") for the Accountant system role of existing companies. New companies get it from
 * SYSTEM_ROLES (the Accountant holds every permission but security.manage / data.restore); the Owner
 * holds everything ('all'). Data Entry, Auditor and custom roles are not changed — an administrator
 * grants it in Users & Roles. Idempotent: the permission is added once.
 *
 * Depends only on the roles table (020).
 */
export const migration250 = {
  version: 250,
  name: 'renumber',
  sql: /* sql */ `
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'vouchers.renumber')
 WHERE is_system = 1 AND name = 'Accountant'
   AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'vouchers.renumber');
`,
} as const;
