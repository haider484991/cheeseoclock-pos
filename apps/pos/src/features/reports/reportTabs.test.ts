import { describe, expect, it } from 'vitest';
import { periodFor } from './dateRange';
import { LAST_TAB_KEY, readLastTab, tabQueryKey, tabRequest, visibleReportTabs, writeLastTab, type TabStorage } from './reportTabs';

const SAT_3PM = new Date('2026-09-26T10:00:00.000Z');

function memory(start: Record<string, string> = {}): TabStorage & { data: Record<string, string> } {
  const data = { ...start };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

/** Storage the browser blocks (a locked-down profile): every call throws. */
const blocked: TabStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('Reports tabs (costing spec Phase 3)', () => {
  it('six tabs in order; Food cost & stock only for a login that may see costs', () => {
    expect(visibleReportTabs(true)).toEqual(['overview', 'when', 'menu', 'channels', 'foodStock', 'team']);
    expect(visibleReportTabs(false)).toEqual(['overview', 'when', 'menu', 'channels', 'team']);
  });

  it('opens on the last tab looked at, if this login still sees it', () => {
    const store = memory();
    expect(readLastTab(store, visibleReportTabs(true))).toBe('overview');
    writeLastTab(store, 'team');
    expect(store.data[LAST_TAB_KEY]).toBe('team');
    expect(readLastTab(store, visibleReportTabs(true))).toBe('team');
    writeLastTab(store, 'foodStock');
    expect(readLastTab(store, visibleReportTabs(true))).toBe('foodStock');
    // The same till, a login without costs: back to Overview.
    expect(readLastTab(store, visibleReportTabs(false))).toBe('overview');
    // Something this version does not know (an older or newer till's key).
    expect(readLastTab(memory({ [LAST_TAB_KEY]: 'profit' }), visibleReportTabs(true))).toBe('overview');
  });

  it('storage that is blocked or missing never breaks the page', () => {
    expect(readLastTab(blocked, visibleReportTabs(true))).toBe('overview');
    expect(() => writeLastTab(blocked, 'menu')).not.toThrow();
    expect(readLastTab(undefined, visibleReportTabs(true))).toBe('overview');
    expect(() => writeLastTab(undefined, 'menu')).not.toThrow();
  });

  it('only the Overview asks for the comparison period', () => {
    const today = periodFor('today', SAT_3PM);
    expect(tabRequest('overview', today)).toEqual({
      sinceIso: '2026-09-26T00:00:00.000Z',
      untilIso: '2026-09-27T00:00:00.000Z',
      compareSinceIso: '2026-09-25T00:00:00.000Z',
      compareUntilIso: '2026-09-25T10:00:00.000Z',
    });
    expect(tabRequest('menu', today)).toEqual({ sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z' });
  });

  it('a running period refreshes each minute; a finished one is asked once', () => {
    const at = (iso: string) => new Date(iso);
    const today = periodFor('today', SAT_3PM);
    expect(tabQueryKey('menu', today, at('2026-09-26T10:00:00.000Z'))).not.toEqual(tabQueryKey('menu', today, at('2026-09-26T10:01:00.000Z')));
    const lastYear = periodFor('lastYear', SAT_3PM);
    expect(tabQueryKey('menu', lastYear, at('2026-09-26T10:00:00.000Z'))).toEqual(tabQueryKey('menu', lastYear, at('2026-09-26T10:01:00.000Z')));
    // Each tab its own entry.
    expect(tabQueryKey('menu', lastYear, SAT_3PM)).not.toEqual(tabQueryKey('when', lastYear, SAT_3PM));
  });
});
