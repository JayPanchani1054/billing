/**
 * Security module: users & roles, security settings (on/off, password policy, lockout, idle
 * timeout), the Edit Log (audit trail viewer with field-level diffs, record history, verification
 * and export) and My Session.
 *
 * Screens: 'security.users' { tab? } · 'security.user.form' (dialog) { id? } · 'security.role.form'
 * { id?, copyFrom? } · 'security.settings' · 'security.audit' { entityType?, entityId?, entityGuid?,
 * label?, userId? } · 'security.session'.
 */
import type { ModuleDef } from '../../app/registry.ts';
import { AuditScreen } from './AuditScreen.tsx';
import { RoleFormScreen } from './RoleFormScreen.tsx';
import { SecuritySettingsScreen } from './SecuritySettingsScreen.tsx';
import { SessionScreen } from './SessionScreen.tsx';
import { UserFormScreen } from './UserFormScreen.tsx';
import { UsersRolesScreen } from './UsersRolesScreen.tsx';
import './security.css';

export { auditHistoryParams } from './lib/auditQuery.ts';

export const securityModule: ModuleDef = {
  id: 'security',
  screens: [
    { id: 'security.users', title: 'Users & Roles', component: UsersRolesScreen, access: 'security.manage', keywords: ['users', 'roles', 'permissions', 'access', 'password', 'unlock'] },
    { id: 'security.user.form', title: 'User', component: UserFormScreen, access: 'security.manage', presentation: 'dialog' },
    { id: 'security.role.form', title: 'Role', component: RoleFormScreen, access: 'security.manage' },
    { id: 'security.settings', title: 'Security Settings', component: SecuritySettingsScreen, access: 'security.manage', keywords: ['security', 'password policy', 'lockout', 'idle timeout', 'auto logout', 'login'] },
    { id: 'security.audit', title: 'Edit Log', component: AuditScreen, access: 'audit.view', keywords: ['audit trail', 'audit log', 'edit log', 'history', 'who changed', 'tampering'] },
    { id: 'security.session', title: 'My Session', component: SessionScreen, keywords: ['session', 'logged in', 'my permissions', 'logout', 'password expiry'] },
  ],
  menu: [
    { section: 'security', label: 'Users & Roles', screen: 'security.users', order: 10, keywords: ['users', 'roles', 'password', 'permissions'], description: 'Who can log in and what each person may do' },
    { section: 'security', label: 'Security Settings', screen: 'security.settings', order: 20, keywords: ['password', 'lockout', 'idle timeout', 'turn on security'], description: 'Turn passwords on or off, password rules, automatic logout' },
    { section: 'security', label: 'Edit Log', screen: 'security.audit', order: 30, keywords: ['audit trail', 'audit log', 'history', 'verify'], description: 'Every change, login and export — who, what and when' },
    { section: 'security', label: 'My Session', screen: 'security.session', order: 40, keywords: ['logged in', 'password', 'my permissions', 'logout'], description: 'Your login, permissions and automatic-logout timer' },
  ],
};
