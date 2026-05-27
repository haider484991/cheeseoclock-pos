import Database, { type Database as DBType } from 'better-sqlite3';
import log from 'electron-log/main';

let db: DBType | null = null;

export function initDatabase(filePath: string): DBType {
  if (db) return db;
  db = new Database(filePath, { fileMustExist: false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
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
