import { describe, expect, it } from 'vitest';
import { selectBackupsToDelete } from './backup-retention';

const NOW = new Date('2026-09-03T12:00:00Z');
const at = (daysAgo: number, hour = 3) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 + (hour - 12) * 3_600_000).toISOString();

describe('selectBackupsToDelete', () => {
  it('keeps one scheduled copy per day for two weeks plus the newest three', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, createdAt: at(i) }));
    const del = new Set(selectBackupsToDelete(rows, NOW));
    for (let i = 0; i < 14; i++) expect(del.has(`d${i}`)).toBe(false);
    for (let i = 14; i < 20; i++) expect(del.has(`d${i}`)).toBe(true);
  });

  it('cannot be flushed by a burst of uploads on one day', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `old${i}`, createdAt: at(i + 1) })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `burst${i}`, createdAt: at(0, 13 + i / 10) })),
      { id: 'todayFirst', createdAt: at(0, 3) },
    ];
    const del = new Set(selectBackupsToDelete(rows, NOW));
    // every earlier day survives, and so does today's genuine first copy
    for (let i = 0; i < 5; i++) expect(del.has(`old${i}`)).toBe(false);
    expect(del.has('todayFirst')).toBe(false);
    // of the burst only the newest three remain
    const survivingBurst = rows.filter((r) => r.id.startsWith('burst') && !del.has(r.id));
    expect(survivingBurst.map((r) => r.id).sort()).toEqual(['burst7', 'burst8', 'burst9']);
  });

  it('keeps before-restore safety copies for 30 days even when older than the daily window', () => {
    const rows = [
      { id: 'safe', createdAt: at(25), reason: 'before-restore' },
      { id: 'stale', createdAt: at(40), reason: 'before-restore' },
      { id: 'plain', createdAt: at(25), reason: 'scheduled' },
      ...Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, createdAt: at(i) })),
    ];
    const del = new Set(selectBackupsToDelete(rows, NOW));
    expect(del.has('safe')).toBe(false);
    expect(del.has('stale')).toBe(true);
    expect(del.has('plain')).toBe(true);
  });

  it('deletes nothing when there is nothing to trim', () => {
    expect(selectBackupsToDelete([{ id: 'a', createdAt: at(0) }], NOW)).toEqual([]);
    expect(selectBackupsToDelete([], NOW)).toEqual([]);
  });
});
