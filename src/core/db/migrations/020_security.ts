/**
 * Module-owned migration for 'security': password history.
 *
 * password_history keeps the hashes of a user's PREVIOUS passwords (the current one lives in
 * users.password_hash), so a password cannot be reused (see PASSWORD_HISTORY_DEPTH in
 * shared/types/security.ts). It is filled by a trigger, so every code path that changes a password —
 * the security module, the login screen's "change password" (core/app/auth.ts), a transparent rehash —
 * is covered without having to remember to call anything.
 *
 *  - replaced_at = users.updated_at written by the same UPDATE (the app clock's time of the change),
 *    so the newest row's replaced_at is when the CURRENT password was set (password expiry).
 *  - Only the newest 2 rows per user are kept (current + 2 previous = last 3 passwords): fewer stored
 *    hashes means less material for offline guessing if the file is stolen.
 *  - Users are never deleted (the edit log refers to them), so no ON DELETE handling is needed.
 */
export const migration020 = {
  version: 20,
  name: 'security',
  sql: /* sql */ `
CREATE TABLE password_history (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  password_hash TEXT NOT NULL,
  replaced_at   TEXT NOT NULL
);
CREATE INDEX idx_password_history_user ON password_history(user_id, id);

CREATE TRIGGER users_password_history AFTER UPDATE OF password_hash ON users
WHEN NEW.password_hash IS NOT OLD.password_hash
BEGIN
  INSERT INTO password_history (user_id, password_hash, replaced_at)
  VALUES (OLD.id, OLD.password_hash, COALESCE(NEW.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  DELETE FROM password_history
   WHERE user_id = OLD.id
     AND id NOT IN (SELECT id FROM password_history WHERE user_id = OLD.id ORDER BY id DESC LIMIT 2);
END;
`,
} as const;
