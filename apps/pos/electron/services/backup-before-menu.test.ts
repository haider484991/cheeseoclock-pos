/**
 * The copy taken before a menu file from the costing PC goes in (v0.7.32,
 * backup-service.ts 'before-menu'): named before-menu-…, the newest 5 kept,
 * listed with the copies made by hand — and a busy week of menu files never
 * pushes out a daily copy or a hand-made one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData, relaunch: () => {}, exit: () => {} },
  dialog: {},
}));
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('../db/connection.js', () => ({ closeDatabase: () => {} }));
vi.mock('../db/repositories/settings-repo.js', () => ({ setSetting: () => {}, deleteSetting: () => {} }));
// The copy itself (better-sqlite3's online backup) stood in for: a file with a SQLite header.
vi.mock('better-sqlite3', () => ({
  default: class {
    pragma() {}
    close() {}
  },
}));

const { initBackupService, stopBackupService, createBackupAsync, listBackups, KEEP_BEFORE_MENU_BACKUPS } = await import('./backup-service.js');

const fakeDb = {
  backup: async (dest: string) => {
    fs.writeFileSync(dest, 'SQLite format 3\0test');
  },
} as never;

describe('before-menu copies', () => {
  beforeEach(() => {
    state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-before-menu-'));
    initBackupService(fakeDb);
  });
  afterEach(() => {
    stopBackupService();
    fs.rmSync(state.userData, { recursive: true, force: true });
  });

  it('the newest 5 are kept; the daily and hand-made copies are never touched', async () => {
    const dir = path.join(state.userData, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const older = Date.now() / 1000 - 3600;
    for (const name of ['auto-2026-09-20T00-00-00-000Z.db', 'manual-2026-09-21T00-00-00-000Z.db']) {
      fs.writeFileSync(path.join(dir, name), 'SQLite format 3\0old');
      fs.utimesSync(path.join(dir, name), older - 600, older - 600);
    }
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await createBackupAsync({ kind: 'before-menu' });
      expect(r.fileName).toMatch(/^before-menu-.*\.db$/);
      made.push(r.fileName);
      // Oldest first on the disk's clock, the one just made newest.
      fs.utimesSync(r.fullPath, older + i, older + i);
      await new Promise((res) => setTimeout(res, 3));
    }
    const names = fs.readdirSync(dir).sort();
    const kept = names.filter((n) => n.startsWith('before-menu-'));
    expect(KEEP_BEFORE_MENU_BACKUPS).toBe(5);
    expect(kept).toHaveLength(5);
    // The two oldest went.
    expect(kept).toEqual([...made].slice(2).sort());
    expect(names).toContain('auto-2026-09-20T00-00-00-000Z.db');
    expect(names).toContain('manual-2026-09-21T00-00-00-000Z.db');
    // Settings → Backups lists them with the hand-made copies.
    const listed = listBackups();
    expect(listed.filter((b) => b.fileName.startsWith('before-menu-')).every((b) => b.kind === 'manual')).toBe(true);
    expect(listed.filter((b) => b.kind === 'auto').map((b) => b.fileName)).toEqual(['auto-2026-09-20T00-00-00-000Z.db']);
  });

  it('one bad file tried again and again keeps ONE copy: the copy from before the last good file stays', async () => {
    const older = Date.now() / 1000 - 3600;
    let i = 0;
    const make = async (tag: string) => {
      const r = await createBackupAsync({ kind: 'before-menu', tag });
      fs.utimesSync(r.fullPath, older + i, older + i);
      i++;
      await new Promise((res) => setTimeout(res, 3));
      return r.fileName;
    };
    const good1 = await make('aaaa1111');
    const good2 = await make('bbbb2222');
    const good3 = await make('cccc3333');
    // File dddd4444 fails ten times; each try takes a copy first.
    const bad: string[] = [];
    for (let n = 0; n < 10; n++) bad.push(await make('dddd4444'));
    expect(bad[0]).toMatch(/^before-menu-.+-fdddd4444\.db$/);
    const kept = () => fs.readdirSync(path.join(state.userData, 'backups')).filter((f) => f.startsWith('before-menu-')).sort();
    expect(kept()).toEqual([good1, good2, good3, bad[9]!].sort());
    // Two more good files: five files kept, the oldest file's copy goes.
    const good5 = await make('eeee5555');
    const good6 = await make('ffff6666');
    expect(kept()).toEqual([good2, good3, bad[9]!, good5, good6].sort());
    // A tag that is not letters and digits is left off the name (never part of a path).
    const odd = await createBackupAsync({ kind: 'before-menu', tag: '../x' });
    expect(odd.fileName).toMatch(/^before-menu-[0-9TZ-]+\.db$/);
  });
});
