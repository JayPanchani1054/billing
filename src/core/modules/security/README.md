# Security module (core)

Users, roles and permissions, turning company security on and off, the security settings (password
policy, lockout, idle timeout, password expiry), the edit-log viewer (list, field-level diff, record
history, chain verification, export) and the current-session view.

DTOs and the route table: `src/shared/types/security.ts`. Migration: `src/core/db/migrations/020_security.ts`.

| File | Responsibility |
|---|---|
| `routes.ts` | Route map + input schemas |
| `users.ts` | User list/get/save, password reset, unlock, delete refusal |
| `roles.ts` | Role list/get/save/delete |
| `catalog.ts` | Human-readable permission catalogue |
| `toggle.ts` | `security.enable` / `security.disable` |
| `settings.ts` | Security settings (settings key `security`) |
| `policy.ts` | Password policy, history, expiry, lockout policy (also meant for `core/app/auth.ts`) |
| `auditlog.ts` | Edit log list, facets, detail, record history, verification, export |
| `diff.ts` | Pure JSON field-level diff |
| `session.ts` | `security.mySession` |
| `common.ts` | Owner/role helpers, anti-escalation check |

## Threat model (this module)

| Threat | Control |
|---|---|
| A user gives themselves (or a friend) more power | Only an Owner can create, change, reset or grant the Owner role. Anyone else with `security.manage` can only hand out permissions they hold themselves (role save, role assignment), and can only manage users whose permissions they hold (no password reset → account takeover of a stronger user). Nobody can change their own role. |
| Lock-out of the whole company | There is always an active Owner: the last one cannot be deactivated or moved to another role. You cannot deactivate yourself. Security can only be turned off by an Owner re-entering their password. |
| Walk-up at an unlocked PC | Idle timeout (enforced by the dispatcher/controller); turning security off and enabling with an existing Owner need the password; resetting your *own* password here is refused (use Change password, which asks for the current one). |
| Password guessing | Configurable lockout (3–10 failures, 1–60 min). Wrong passwords on `security.enable` / `security.disable` count as failed logins on that account (and are logged as `login_failed`). Once the requested auth change is applied, the login screen uses the same settings. |
| Weak / recycled passwords | Configurable policy (8–64 chars, mixed case, symbol; letters + digits always), password ≠ username, no reuse of the last 3 passwords, optional expiry. |
| Covering tracks | Users are never deleted (the edit log refers to them) — deactivate instead. Every mutation here is written to the edit log in the same transaction. Exporting the edit log is itself logged. Verification reports altered, inserted or removed entries in plain language. |
| Secrets in logs | Audit payloads never contain password hashes or passwords (audit views exclude them; `sanitizeForAudit` is a second line of defence). |
| Spreadsheet formula injection via exported labels | XLSX writes text only as shared strings (never formulas); CSV prefixes `'` to text starting with `= + - @ TAB CR`. |
| Offline cracking of a stolen file | Only the 2 previous hashes per user are kept in `password_history` (scrypt, salted). Use BitLocker for data at rest (docs/SECURITY.md §5). |

Out of scope here: removal of the *newest* edit-log entries (undetectable from the chain alone — the
verify report says so and shows the latest fingerprint to keep), and anyone with raw file access
replacing the whole database.

## Routes

All company scope. "SM" = `security.manage`.

| Route | Input | Output | Access |
|---|---|---|---|
| `security.user.list` | `{ search?, roleId?, activeOnly? }` | `{ rows: SecurityUser[], total }` | SM |
| `security.user.get` | `{ id }` | `SecurityUser` | SM |
| `security.user.save` | `{ id?, username, displayName, roleId, isActive, password?, mustChangePassword? }` | `SecurityUser` | SM |
| `security.user.resetPassword` | `{ id, newPassword, mustChange = true }` | `SecurityUser` | SM |
| `security.user.unlock` | `{ id }` | `SecurityUser` | SM |
| `security.user.delete` | `{ id }` | always `BUSINESS_RULE`, details `UserDeleteRefusal` (`suggestion: 'deactivate'`) | SM |
| `security.role.list` | none | `{ rows: SecurityRole[], total }` (with `userCount`, `activeUserCount`, `isSystem`, `isOwner`) | SM |
| `security.role.get` | `{ id }` | `SecurityRole` | SM |
| `security.role.save` | `{ id?, name, description?, permissions: Permission[] }` | `SecurityRole` | SM |
| `security.role.delete` | `{ id }` | `{ deleted: true, id }` | SM |
| `security.permissions.catalog` | none | `PermissionCatalog` (groups → items with `label`, `fullLabel` e.g. "Vouchers › Create vouchers", `description`) | authenticated |
| `security.enable` | `{ username, displayName?, password }` | `SecurityEnableResult` | `company.manage`, security must be off |
| `security.disable` | `{ password }` | `SecurityDisableResult` | SM + Owner + own password |
| `security.settings.get` | none | `SecuritySettings` | SM |
| `security.settings.save` | `Partial<SecuritySettings>` | `SecuritySettings` | SM |
| `security.passwordPolicy` | none | `PasswordPolicyInfo` (rules as text, for any password form) | authenticated |
| `security.audit.list` | `{ from?, to?, userId?, actions?, entityType?, entityId?, search?, limit ≤ 500, offset, order? }` — strict: any other key is a VALIDATION error ("Unknown field \"action\" — did you mean \"actions\"?"), so a misspelt filter never returns the unfiltered log | `{ rows: AuditListRow[], total }` | `audit.view` |
| `security.audit.facets` | none | `AuditFacets` (record types, users, actions with counts; first/last timestamp) | `audit.view` |
| `security.audit.get` | `{ id }` | `AuditEntryDetail` (before/after parsed, `changes: { path, kind, before, after }[]`) | `audit.view` |
| `security.audit.entityHistory` | `{ entityType, entityId, entityGuid? }` | `AuditEntityHistory` (versions oldest first, each with its changes) | `audit.view` |
| `security.audit.verify` | none | `AuditVerifyReport` (`ok`, `message`, `detail`, `brokenAtId`, `reason`, `lastHash`) | `audit.view` |
| `security.audit.export` | `{ format: 'xlsx' \| 'csv', from?, to?, …same filters }` (strict, like the list) | `{ fileName, mimeType, bytes, rowCount }` | `audit.view` + `data.export` (checked in the service) |
| `security.mySession` | none | `MySession` | authenticated |

`enable`, `disable` and every `audit.*` route are `transactional: false` (async scrypt / heavy reads);
`enable`/`disable` do all their writes in one transaction that re-checks the state after the await.

Audit actions written: user create/alter → `create`/`alter` (`entityType 'user'`); password reset and
unlock → `security`; role create/alter/delete → `create`/`alter`/`delete` (`'role'`); settings →
`security` (`'security_settings'`); on/off → `security` (`'company_security'`) plus the company
service's own `settings` entry for features; wrong confirmation passwords → `login_failed` with
`context`; edit-log export → `export` (`'audit_log'`).

## Permission catalogue

| Group | Permission | Label |
|---|---|---|
| Company | `company.view` | View company details |
| Company | `company.manage` | Change company settings |
| Company | `period.lock` | Lock and unlock books |
| Masters | `masters.view` / `.create` / `.alter` / `.delete` | View / Create / Alter / Delete masters |
| Vouchers | `vouchers.view` / `.create` / `.alter` / `.delete` | View / Create / Alter / Delete vouchers |
| Vouchers | `vouchers.backdate` | Back-date vouchers |
| Reports | `reports.view` | View reports |
| Reports | `reports.financial` | View financial statements |
| GST | `gst.view` | View GST reports |
| GST | `gst.file` | Prepare GST filings |
| Banking | `banking.reconcile` | Reconcile bank accounts |
| Data | `data.export` / `data.import` / `data.backup` / `data.restore` | Export data / Import data / Back up / Restore backups |
| Security | `security.manage` | Manage users and security |
| Security | `audit.view` | View the edit log |

A permission added to `PERMISSIONS` later without a catalogue entry is still listed (group "Other").

## Turning security on and off

- **Enable** creates the Owner (or reuses an existing Owner user after verifying its password, reactivating
  it if needed), then sets `features.security = true` through `saveFeatures` (company service).
  **The AppController drops the implicit owner session on its next call** (`effectiveSession()` in
  `core/app/controller.ts`): `app.state` then returns `session: null` and `pendingLogin`, and company
  routes answer `UNAUTHENTICATED` until someone logs in. The UI should call `app.state` after a
  successful enable and show the login screen (`SecurityEnableResult.loginRequired` is always `true`).
- **Disable** keeps users, roles and the edit log. The Owner's current session continues; after logout
  the controller brings back the implicit owner session (no login prompt).

## Settings storage (compatibility)

Key `settings['security']`, a JSON object. The controller reads only `idleTimeoutMinutes` (number ≥ 0,
0 = never) on every call; this module merges its fields into the same object and keeps any other keys.
Defaults: idle 30 min (= `DEFAULT_IDLE_TIMEOUT_MS`), min length 8, no mixed case/symbol, no expiry,
lockout 5 failures / 5 min (= `MAX_FAILED_ATTEMPTS` / `LOCKOUT_MS` in auth.ts). Invalid stored values fall
back to the default field by field.

## Password history

`password_history` is filled by the trigger `users_password_history` on every change of
`users.password_hash` — so the login screen's own "Change password" (auth.ts) and transparent rehashes
are recorded too. `replaced_at` is the `updated_at` of that UPDATE (the app clock), so the newest row
tells when the current password was set (expiry). Only the 2 previous hashes are kept (current + 2 =
the last 3 passwords).

## Edit-log viewer notes

- Stored payloads are canonical JSON (sorted keys), so diff paths come in alphabetical key order;
  arrays are compared by index (`lines[2].amount`); `updated_at`/`updatedAt` are ignored; created and
  deleted records list every leaf as added/removed.
- `from`/`to` are local calendar dates (inclusive), converted to UTC instants at local midnight.
- Search matches record label, username, record type and action — not the payloads.
- `entityHistory` with only `entityId` can mix two records when an id was reused after a delete; pass
  `entityGuid` (shown on every row) to separate them.

## Requested change in auth/controller (not applied — `core/app/auth.ts` is not this module's file)

Without it the login screen keeps its fixed policy (5 failures → 5 minutes, base password rules) and
password expiry is only *reported* (user list, `mySession`), not enforced. Validated in a scratch copy:
typecheck clean, all app + company + security tests pass with it applied.

```diff
--- a/src/core/app/auth.ts
+++ b/src/core/app/auth.ts
@@ -13,9 +13,11 @@
 import type { Session } from '../api/context.ts';
 import type { Db } from '../db/db.ts';
 import { appendAudit } from '../lib/audit.ts';
-import { dummyPasswordHash, hashPassword, needsRehash, passwordPolicy, verifyPassword } from '../lib/crypto.ts';
+import { dummyPasswordHash, hashPassword, needsRehash, verifyPassword } from '../lib/crypto.ts';
 import { AppError, rule } from '../lib/errors.ts';
+import { getLockoutPolicy, isPasswordExpired, isPasswordReused, PASSWORD_REUSED_MESSAGE, passwordProblemFor } from '../modules/security/policy.ts';
 
+/** Defaults; the effective values come from the company's security settings (getLockoutPolicy). */
 export const MAX_FAILED_ATTEMPTS = 5;
 export const LOCKOUT_MS = 5 * 60_000;
 export const OWNER_ROLE = 'Owner';
@@ -150,13 +152,14 @@
       appendAudit(db, { action: 'login_failed', entityType: 'user', entityLabel: maskLoginName(name), after: { reason: 'unknown_user' } }, null, now);
       throw new AppError('UNAUTHENTICATED', 'Incorrect username or password');
     }
-    const lockedUntil = new Date(now.getTime() + LOCKOUT_MS).toISOString();
+    const { maxFailedAttempts, lockoutMs } = getLockoutPolicy(db);
+    const lockedUntil = new Date(now.getTime() + lockoutMs).toISOString();
     const after = db.transaction(() => {
       db.run(
         `UPDATE users SET failed_attempts = failed_attempts + 1,
                 locked_until = CASE WHEN failed_attempts + 1 >= :max THEN :lockedUntil ELSE locked_until END
           WHERE id = :id`,
-        { max: MAX_FAILED_ATTEMPTS, lockedUntil, id: user.id },
+        { max: maxFailedAttempts, lockedUntil, id: user.id },
       );
       const attempts = db.value<number>('SELECT failed_attempts FROM users WHERE id = :id', { id: user.id }) ?? 0;
       appendAudit(
@@ -167,8 +170,8 @@
       );
       return attempts;
     });
-    if (after >= MAX_FAILED_ATTEMPTS) throw new AppError('LOCKED', lockedMessage(Math.round(LOCKOUT_MS / 60_000)), { lockedUntil });
-    const left = MAX_FAILED_ATTEMPTS - after;
+    if (after >= maxFailedAttempts) throw new AppError('LOCKED', lockedMessage(Math.round(lockoutMs / 60_000)), { lockedUntil });
+    const left = maxFailedAttempts - after;
     throw new AppError(
       'UNAUTHENTICATED',
       left <= 2 ? `Incorrect username or password. ${left} attempt${left === 1 ? '' : 's'} left before the account is locked.` : 'Incorrect username or password',
@@ -181,7 +184,7 @@
   }
 
   const userId = user.id;
-  const mustChange = user.must_change_password === 1;
+  const mustChange = user.must_change_password === 1 || isPasswordExpired(db, userId, now);
   // Transparently upgrade hashes made with weaker parameters (only if nobody changed it meanwhile).
   const oldHash = user.password_hash;
   const upgraded = needsRehash(oldHash) ? await hashPassword(password) : null;
@@ -209,12 +212,14 @@
 
   if (!(await verifyPassword(input.currentPassword, user.password_hash)))
     throw new AppError('VALIDATION', 'Current password is incorrect', [{ path: 'currentPassword', message: 'Current password is incorrect' }]);
-  const policy = passwordPolicy(input.newPassword);
+  const policy = passwordProblemFor(db, input.newPassword, user.username);
   if (policy) throw new AppError('VALIDATION', policy, [{ path: 'newPassword', message: policy }]);
   if (input.newPassword === input.currentPassword) {
     const msg = 'The new password must be different from the current one';
     throw new AppError('VALIDATION', msg, [{ path: 'newPassword', message: msg }]);
   }
+  if (await isPasswordReused(db, userId, input.newPassword))
+    throw new AppError('VALIDATION', PASSWORD_REUSED_MESSAGE, [{ path: 'newPassword', message: PASSWORD_REUSED_MESSAGE }]);
   const hash = await hashPassword(input.newPassword);
   db.transaction(() => {
     const changed = db.run(
```

No controller change is needed for the idle timeout (it already reads `settings['security'].idleTimeoutMinutes`).
Optional: the controller's company-delete throttle still uses the fixed 5 / 5 min.

## Edit Log in the UI (`src/renderer/modules/security`)

- Record history (`security.audit { entityType, entityId, entityGuid?, label? }`) is opened with **Alt+H "Edit
  history"** from voucher entry / view, users and roles, and the master forms: ledger (also the ledger list),
  group (also the group list), voucher type, stock item and company details (`entityType` = the type the
  core audits: `ledger`, `group`, `voucher_type`, `stock_item`, `company` #1). Hidden without `audit.view`.
- The other way, **Alt+A "Open record"** in the history (and on a selected Edit Log row) opens the voucher view
  or the master's form (`lib/recordLinks.ts`); hidden when the record was deleted or has no screen.

## Limitations

- Permissions are captured at login: role changes, deactivation and lockout settings affect a user from
  their next login (the app has one live session per window).
- A transparent rehash at login (old, weaker hash parameters) is recorded as a history entry and takes
  `replaced_at` from the user's last `updated_at`, so the password-age clock may restart slightly late for
  such accounts.
- The idle-timeout remaining time is computed from "now" (every call restarts the countdown); the
  dispatcher's own last-activity timestamp is not visible to company routes.
- The edit log search does not look inside before/after payloads; exports are capped at 100 000 entries
  per file and the "Changes" text per cell at 4 000 characters.
