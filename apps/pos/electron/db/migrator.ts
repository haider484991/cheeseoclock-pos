import { Umzug } from 'umzug';
import log from 'electron-log/main';
import type { AppDatabase } from './connection.js';

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

export async function runMigrations(db: AppDatabase): Promise<void> {
  ensureMigrationsTable(db);

  const all = loadMigrations();
  const umzug = new Umzug<MigrationContext>({
    migrations: all.map((m) => ({
      name: m.name,
      up: async ({ context }) => {
        context.db.exec(m.sql);
      },
      down: async () => {
        throw new Error('Down migrations are not supported');
      },
    })),
    context: { db },
    storage: {
      logMigration: async ({ name }) => {
        db.prepare('INSERT INTO _migrations (name, ran_at) VALUES (?, ?)').run(
          name,
          new Date().toISOString(),
        );
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
  log.info('Applying migrations', { count: pending.length, names: pending.map((p) => p.name) });
  await umzug.up();
  log.info('Migrations complete');
}
