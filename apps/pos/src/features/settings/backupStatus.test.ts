import { describe, expect, it } from 'vitest';
import {
  fmtWhen,
  localCopyLabel,
  mergeCopies,
  summarizeBackups,
  type BackupHealthInput,
  type OnlineSetupInput,
} from './backupStatus';
import { logoFrameWidth, opaqueBounds, svgSize } from './logoImage';

// Local wall-clock times, so the "today / yesterday" wording does not depend
// on the time zone the tests run in.
const NOW = new Date(2026, 8, 26, 14, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();

const healthy: BackupHealthInput = {
  lastLocalAt: at(26, 9, 12),
  lastLocalError: null,
  lastCloudAt: at(26, 9, 15),
  lastCloudError: null,
};
const connected: OnlineSetupInput = { frequency: 'daily', connected: true, secretUnreadable: false };

describe('fmtWhen', () => {
  it('says today / yesterday / weekday in plain words', () => {
    expect(fmtWhen(at(26, 9, 12), NOW)).toBe('today at 9:12 AM');
    expect(fmtWhen(at(25, 21, 40), NOW)).toBe('yesterday at 9:40 PM');
    expect(fmtWhen(at(22, 10), NOW)).toBe('Tue 22 Sep at 10:00 AM');
    expect(fmtWhen(new Date(2025, 11, 31, 8).toISOString(), NOW)).toBe('31 Dec 2025');
  });
});

describe('summarizeBackups', () => {
  it('is green when both copies are recent', () => {
    const s = summarizeBackups(healthy, connected, NOW);
    expect(s.tone).toBe('good');
    expect(s.headline).toBe('Your data is backed up');
    expect(s.local.text).toBe('On this computer: today at 9:12 AM');
    expect(s.online.text).toBe('Online: today at 9:15 AM');
    expect(s.onlineFix).toBeNull();
  });

  it('is red when the copy on this computer failed', () => {
    const s = summarizeBackups(
      { ...healthy, lastLocalError: { at: at(26, 9), message: 'disk full' } },
      connected,
      NOW,
    );
    expect(s.tone).toBe('bad');
    expect(s.local.text).toContain('disk full');
    expect(s.local.alert).toBe(true);
  });

  it('says "this computer only", without a dashboard alert, when the website is not connected', () => {
    const s = summarizeBackups(healthy, { ...connected, connected: false }, NOW);
    expect(s.tone).toBe('warn');
    expect(s.headline).toBe('Backed up on this computer only');
    expect(s.onlineFix).toBe('connect');
    expect(s.online.alert).toBe(false);
  });

  it('alerts when the connection password was sealed on another computer', () => {
    const s = summarizeBackups(healthy, { ...connected, connected: false, secretUnreadable: true }, NOW);
    expect(s.online.alert).toBe(true);
    expect(s.headline).toBe('Backups need a look');
  });

  it('offers to turn online copies back on when they are switched off', () => {
    const s = summarizeBackups(healthy, { ...connected, frequency: 'off' }, NOW);
    expect(s.onlineFix).toBe('turn-on');
    expect(s.online.text).toBe('Online: switched off');
  });

  it('flags an online copy that is overdue, red when the last try failed', () => {
    const stale = { ...healthy, lastCloudAt: at(20, 9) };
    expect(summarizeBackups(stale, connected, NOW).online).toMatchObject({ tone: 'warn', alert: true });
    const failing = { ...stale, lastCloudError: { at: at(26, 9), message: 'offline' } };
    const s = summarizeBackups(failing, connected, NOW);
    expect(s.tone).toBe('bad');
    expect(s.online.text).toContain('6 days ago');
    // A weekly schedule is not overdue after six days.
    expect(summarizeBackups(stale, { ...connected, frequency: 'weekly' }, NOW).online.tone).toBe('good');
  });

  it('warns when the copy on this computer is days old', () => {
    const s = summarizeBackups({ ...healthy, lastLocalAt: at(22, 9) }, connected, NOW);
    expect(s.local).toMatchObject({ tone: 'warn', text: 'On this computer: last backup 4 days ago' });
  });
});

describe('mergeCopies', () => {
  it('lists local and online copies together, newest first, with where they are', () => {
    const rows = mergeCopies(
      [
        { fileName: 'auto-2026-09-25.db', fullPath: 'x', sizeBytes: 10, createdAtIso: at(25, 9) },
        { fileName: 'before-restore-2026-09-26.db', fullPath: 'y', sizeBytes: 10, createdAtIso: at(26, 11) },
      ],
      [
        { id: 'a', createdAt: at(26, 9), deviceName: 'Counter', isThisDevice: true, orderCount: 5, reason: 'scheduled', sizeBytes: 5 },
        { id: 'b', createdAt: at(24, 9), deviceName: 'Old PC', isThisDevice: false, orderCount: 3, reason: 'manual', sizeBytes: 5 },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual([
      'local:before-restore-2026-09-26.db',
      'online:a',
      'local:auto-2026-09-25.db',
      'online:b',
    ]);
    expect(rows[0]?.label).toBe('Safety copy, made before a restore');
    const last = rows[3];
    expect(last?.where === 'online' && last.fromOtherPc).toBe('Old PC');
    expect(rows[1]?.where === 'online' && rows[1].fromOtherPc).toBeNull();
    expect(localCopyLabel('manual-x.db')).toBe('Saved with “Back up now”');
  });
});

describe('logo frame', () => {
  it('gives a wide logo a wide frame, a tall one a square frame, never beyond the limit', () => {
    expect(logoFrameWidth(3, 40, 200)).toBe(120);
    expect(logoFrameWidth(10, 40, 200)).toBe(200);
    expect(logoFrameWidth(0.5, 40, 200)).toBe(40);
    expect(logoFrameWidth(null, 40, 200)).toBe(40);
  });

  it('reads an SVG size from width/height or its viewBox', () => {
    expect(svgSize('<svg width="300" height="100">')).toEqual({ width: 300, height: 100 });
    expect(svgSize('<svg viewBox="0 0 800 200" stroke-width="2">')).toEqual({ width: 800, height: 200 });
    expect(svgSize('<svg width="100%" viewBox="0,0,50,100">')).toEqual({ width: 50, height: 100 });
    expect(svgSize('<svg width="400" viewBox="0 0 800 200">')).toEqual({ width: 400, height: 100 });
  });

  it('finds the drawn part of a transparent picture so empty margins can be trimmed', () => {
    // 6×4 picture, opaque only at (2..3, 1..2)
    const alpha = (x: number, y: number) => (x >= 2 && x <= 3 && y >= 1 && y <= 2 ? 255 : 0);
    expect(opaqueBounds(alpha, 6, 4)).toEqual({ x: 2, y: 1, w: 2, h: 2 });
    expect(opaqueBounds(() => 0, 6, 4)).toBeNull();
  });
});
