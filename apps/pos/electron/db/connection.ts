import Database, { type Database as DBType } from 'better-sqlite3';
import log from 'electron-log/main';
import { reuseCompiledStatements } from './statement-cache.js';

let db: DBType | null = null;

export function initDatabase(filePath: string): DBType {
  if (db) return db;
  db = new Database(filePath, { fileMustExist: false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // 32 MB of page cache instead of SQLite's 2 MB default: the menu, today's
  // orders and the indexes the till reads all day stay decoded in memory
  // instead of being re-read from the OS on every call.
  db.pragma('cache_size = -32000');
  // Sorts and GROUP BYs (reports, history) in memory, not in temp files.
  db.pragma('temp_store = MEMORY');
  reuseCompiledStatements(db);
  log.info('SQLite opened', { filePath });
  return db;
}

export function getDatabase(): DBType {
  if (!db) throw new Error('Database not initialized — call initDatabase first');
  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    log.warn('Error closing database', err);
  }
  db = null;
}

export type AppDatabase = DBType;
