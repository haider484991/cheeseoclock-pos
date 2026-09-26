/**
 * A staged restore is applied at the next start only once the owner said yes
 * (backup:applyAndRelaunch marks it confirmed). A copy that was staged and
 * then declined used to wait in the slot and replace the data the next time
 * the till started, with no safety copy of what it overwrote.
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

const {
  stageRestoreFromPath,
  hasPendingRestore,
  confirmPendingRestore,
  cancelPendingRestore,
  maybeApplyPendingRestoreSync,
} = await import('./backup-service.js');

/** A file that passes the "is this a SQLite database" header check. */
function fakeDb(file: string, body: string): string {
  fs.writeFileSync(file, Buffer.concat([Buffer.from('SQLite format 3\0', 'utf8'), Buffer.from(body)]));
  return file;
}

describe('staged restores need the owner’s yes', () => {
  let mainDb: string;

  beforeEach(() => {
    state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-restore-'));
    mainDb = fakeDb(path.join(state.userData, 'main.db'), 'TODAY');
  });
  afterEach(() => {
    fs.rmSync(state.userData, { recursive: true, force: true });
  });

  it('throws away a copy that was staged but never confirmed', () => {
    const copy = fakeDb(path.join(state.userData, 'old.db'), 'LAST WEEK');
    stageRestoreFromPath(copy, { source: 'snapshot', label: 'old.db', byUserId: 'owner' });
    expect(hasPendingRestore()).toBe(true);

    expect(maybeApplyPendingRestoreSync(mainDb)).toBeNull();
    expect(fs.readFileSync(mainDb, 'utf8')).toContain('TODAY');
    expect(hasPendingRestore()).toBe(false);
  });

  it('applies a confirmed copy, keeping today’s data aside first', () => {
    const copy = fakeDb(path.join(state.userData, 'old.db'), 'LAST WEEK');
    stageRestoreFromPath(copy, { source: 'snapshot', label: 'old.db', byUserId: 'owner' });
    confirmPendingRestore();

    const applied = maybeApplyPendingRestoreSync(mainDb);
    expect(applied?.info?.confirmedAt).toBeTruthy();
    expect(applied?.info?.byUserId).toBe('owner');
    expect(fs.readFileSync(mainDb, 'utf8')).toContain('LAST WEEK');
    expect(applied?.archivedTo && fs.readFileSync(applied.archivedTo, 'utf8')).toContain('TODAY');
    expect(hasPendingRestore()).toBe(false);
  });

  it('drops a declined copy, and cannot confirm what is not staged', () => {
    const copy = fakeDb(path.join(state.userData, 'old.db'), 'LAST WEEK');
    stageRestoreFromPath(copy, { source: 'snapshot', label: 'old.db', byUserId: 'owner' });
    expect(cancelPendingRestore()).toEqual({ cancelled: true });
    expect(hasPendingRestore()).toBe(false);
    expect(() => confirmPendingRestore()).toThrow(/Nothing is waiting/);
    expect(cancelPendingRestore()).toEqual({ cancelled: false });
  });

  it('a new pick replaces an earlier confirmation', () => {
    stageRestoreFromPath(fakeDb(path.join(state.userData, 'a.db'), 'A'), {
      source: 'snapshot',
      label: 'a.db',
      byUserId: 'owner',
    });
    confirmPendingRestore();
    // Staging again (a different copy) must ask again.
    stageRestoreFromPath(fakeDb(path.join(state.userData, 'b.db'), 'B'), {
      source: 'snapshot',
      label: 'b.db',
      byUserId: 'owner',
    });
    expect(maybeApplyPendingRestoreSync(mainDb)).toBeNull();
    expect(fs.readFileSync(mainDb, 'utf8')).toContain('TODAY');
  });
});
