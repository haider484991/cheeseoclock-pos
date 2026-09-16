import { Umzug } from 'umzug';
import { app } from 'electron';
import path from 'node:path';
import log from 'electron-log/main';
import type { AppDatabase } from './connection.js';
import { ensureBackupDir, snapshotDatabaseTo } from '../services/backup-service.js';

/**
 * Migrations are loaded via Vite's import.meta.glob with ?raw, so the SQL is
 * inlined into the built main-process bundle. No filesystem access needed at
 * runtime — works in dev, packaged builds, and asar archives identically.
 */
const sqlModules = import.meta.glob<string>('./migrations/*.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
});

interface MigrationContext {
  db: AppDatabase;
}

/**
 * Thrown when a pending migration fails. Carries the path of the copy taken
 * before any migration ran so the boot code can put it in front of the
 * operator — that copy is the database as it was before this app version
 * touched it.
 */
export class MigrationFailedError extends Error {
  readonly preMigrateCopyPath: string | null;
  constructor(message: string, preMigrateCopyPath: string | null, cause: unknown) {
    super(message, { cause });
    this.name = 'MigrationFailedError';
    this.preMigrateCopyPath = preMigrateCopyPath;
  }
}

function ensureMigrationsTable(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      ran_at TEXT NOT NULL
    )
  `);
}

function loadMigrations(): Array<{ name: string; sql: string }> {
  const entries = Object.entries(sqlModules)
    .map(([path, sql]) => ({
      name: path.split('/').pop()!,
      sql,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  log.info('Loaded migrations', { count: entries.length, names: entries.map((e) => e.name) });
  return entries;
}

/**
 * 0014/0015 wrap their own BEGIN … COMMIT (they toggle `PRAGMA foreign_keys`,
 * which is only legal outside a transaction). Nesting them inside ours would
 * fail with "cannot start a transaction within a transaction".
 */
function managesOwnTransaction(sql: string): boolean {
  return /\bBEGIN\b/i.test(sql);
}

function insertMigrationRow(db: AppDatabase, name: string): void {
  db.prepare('INSERT OR IGNORE INTO _migrations (name, ran_at) VALUES (?, ?)').run(
    name,
    new Date().toISOString(),
  );
}

/**
 * Copy the live database to `<userData>/backups/pre-migrate-<version>-<stamp>.sqlite`
 * before touching it. The `.sqlite` extension keeps it out of the backup
 * list and its 14-copy rotation; it is a safety net, not a daily backup.
 */
function snapshotBeforeMigrate(db: AppDatabase): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(ensureBackupDir(), `pre-migrate-${app.getVersion()}-${stamp}.sqlite`);
  snapshotDatabaseTo(db, dest);
  return dest;
}

export async function runMigrations(db: AppDatabase): Promise<void> {
  ensureMigrationsTable(db);

  const all = loadMigrations();
  const umzug = new Umzug<MigrationContext>({
    migrations: all.map((m) => ({
      name: m.name,
      // The SQL and its `_migrations` row are committed as one unit, so a
      // failing statement leaves neither a half-applied schema nor a row that
      // claims it ran. `logMigration` below then finds the row already there.
      up: async ({ context }) => {
        const apply = () => {
          context.db.exec(m.sql);
          insertMigrationRow(context.db, m.name);
        };
        if (managesOwnTransaction(m.sql)) apply();
        else context.db.transaction(apply)();
      },
      down: async () => {
        throw new Error('Down migrations are not supported');
      },
    })),
    context: { db },
    storage: {
      logMigration: async ({ name }) => {
        insertMigrationRow(db, name);
      },
      unlogMigration: async ({ name }) => {
        db.prepare('DELETE FROM _migrations WHERE name = ?').run(name);
      },
      executed: async () => {
        const rows = db
          .prepare('SELECT name FROM _migrations ORDER BY name')
          .all() as Array<{ name: string }>;
        return rows.map((r) => r.name);
      },
    },
    logger: {
      info: (msg) => log.info('[migrator]', msg),
      warn: (msg) => log.warn('[migrator]', msg),
      error: (msg) => log.error('[migrator]', msg),
      debug: (msg) => log.debug('[migrator]', msg),
    },
  });

  const pending = await umzug.pending();
  if (pending.length === 0) {
    log.info('Migrations up to date');
    return;
  }

  // A database that has already been migrated once holds real data; copy it
  // aside first. A brand-new file (nothing executed yet) has nothing to lose.
  let preMigrateCopyPath: string | null = null;
  const executed = await umzug.executed();
  if (executed.length > 0) {
    preMigrateCopyPath = snapshotBeforeMigrate(db);
    log.info('Pre-migrate copy written', { path: preMigrateCopyPath });
  }

  log.info('Applying migrations', { count: pending.length, names: pending.map((p) => p.name) });
  try {
    await umzug.up();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('Migration failed', { error: message, preMigrateCopyPath });
    throw new MigrationFailedError(message, preMigrateCopyPath, e);
  }
  log.info('Migrations complete');
}
