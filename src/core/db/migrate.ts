/**
 * Schema migrations driven by PRAGMA user_version.
 *
 *  - Migrations (src/core/db/migrations/index.ts) are applied in ascending version order.
 *  - Each migration runs in its own transaction together with the user_version bump, so a failure
 *    leaves the database at the previous version (SQLite DDL is transactional).
 *  - Migrations with empty SQL still advance the version (module ranges are pre-allocated).
 *  - A database stamped with a version newer than this app supports is refused (CONFLICT), so an
 *    old installation never writes into a newer schema.
 *  - Foreign-key enforcement is switched OFF while migrations run (SQLite's documented procedure for
 *    table rebuilds: CREATE new → copy → DROP old → RENAME, which would otherwise cascade or fail),
 *    and every non-empty migration must leave `PRAGMA foreign_key_check` clean before it commits.
 *    Consequence for migration authors: ON DELETE CASCADE does not fire inside a migration — delete
 *    dependent rows explicitly.
 */
import { AppError } from '../lib/errors.ts';
import type { Db } from './db.ts';
import { migrations as registered, type Migration } from './migrations/index.ts';

function sortedChecked(list: readonly Migration[]): Migration[] {
  const sorted = [...list].sort((a, b) => a.version - b.version);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (!Number.isSafeInteger(m.version) || m.version <= 0) throw new Error(`Invalid migration version: ${m.version} (${m.name})`);
    if (i > 0 && sorted[i - 1].version === m.version)
      throw new Error(`Duplicate migration version ${m.version}: ${sorted[i - 1].name} / ${m.name}`);
  }
  return sorted;
}

/** Highest schema version this build of the app understands. */
export const SCHEMA_VERSION: number = registered.reduce((max, m) => Math.max(max, m.version), 0);

export function getSchemaVersion(db: Db): number {
  return Number(db.value('PRAGMA user_version') ?? 0);
}

export interface MigrateResult {
  from: number;
  to: number;
  /** Versions applied in this run, ascending. */
  applied: number[];
}

/** Throws CONFLICT when the database was created by a newer app version. */
export function assertSupportedVersion(current: number, supported: number = SCHEMA_VERSION): void {
  if (current > supported) {
    throw new AppError(
      'CONFLICT',
      `This company was created by a newer version of Pevqori (data version ${current}; this app supports up to ${supported}). ` +
        'Please update Pevqori to open it.',
      { schemaVersion: current, supportedVersion: supported },
    );
  }
}

/**
 * Bring `db` up to date. Idempotent: running it on an up-to-date database is a no-op.
 * `list` is injectable for tests; production uses the registered migrations.
 */
export function migrate(db: Db, list: readonly Migration[] = registered): MigrateResult {
  const ordered = sortedChecked(list);
  const target = ordered.length ? ordered[ordered.length - 1].version : 0;
  const from = getSchemaVersion(db);
  assertSupportedVersion(from, target);

  const applied: number[] = [];
  if (!ordered.some((m) => m.version > from)) return { from, to: from, applied };

  // PRAGMA foreign_keys is a no-op inside a transaction, so it can only be toggled at the top level.
  const toggleFks = !db.inTransaction && Number(db.value('PRAGMA foreign_keys')) === 1;
  if (toggleFks) db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const m of ordered) {
      if (m.version <= getSchemaVersion(db)) continue;
      db.transaction(() => {
        if (m.sql.trim() !== '') {
          db.exec(m.sql);
          const broken = db.all<{ table: string; parent: string }>('PRAGMA foreign_key_check');
          if (broken.length > 0) {
            const sample = [...new Set(broken.map((b) => `${b.table} → ${b.parent}`))].slice(0, 5).join(', ');
            throw new Error(`Migration ${m.version} (${m.name}) left ${broken.length} broken foreign key reference(s): ${sample}`);
          }
        }
        // PRAGMA cannot take bound parameters; version is a validated safe integer.
        db.exec(`PRAGMA user_version = ${m.version}`);
      });
      applied.push(m.version);
    }
  } finally {
    if (toggleFks) db.exec('PRAGMA foreign_keys = ON');
  }
  return { from, to: getSchemaVersion(db), applied };
}
