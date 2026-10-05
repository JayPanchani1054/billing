/**
 * Module-owned migration for 'data' (additive only).
 *
 *  - backup_history: one row per backup written from this company (manual or automatic). Drives the
 *    "last backup" shown to the user and the 24-hour rule of automatic backups. The backup file itself
 *    never contains its own history row (the snapshot is taken before the row is written).
 *    `IF NOT EXISTS` because databases created while this migration was still empty already carry
 *    version 120; the data module also creates the table on demand (see backup.ts).
 */
export const BACKUP_HISTORY_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS backup_history (
  id             INTEGER PRIMARY KEY,
  created_at     TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  folder         TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  encrypted      INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','auto')),
  payload_sha256 TEXT NOT NULL,
  note           TEXT,
  user_id        INTEGER,
  username       TEXT
);
CREATE INDEX IF NOT EXISTS idx_backup_history_created ON backup_history(created_at);
`;

export const migration120 = {
  version: 120,
  name: 'data',
  sql: BACKUP_HISTORY_DDL,
} as const;
