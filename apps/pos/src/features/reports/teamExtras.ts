import type { DeletedTestsPage, DrawerLogPage } from '@cheeseoclock/shared-types';
import type { ReportExtras } from './exporters';

/**
 * Team & leakage's own channels for paper and file (migrations 0042 / 0043):
 * the period's WHOLE cash drawer log (reports:drawerLog, 200 a read) and its
 * deleted test orders (orders:listDeletedTests, 500 a read), read to the end.
 *
 * Nothing goes missing without a word: when a list stops short (the safety
 * stop below) the file says "The latest X of N"; when one cannot be read at
 * all it comes back null — the file says so and `failed` names it, so the
 * screen can tell the owner. Kept apart from ReportsPage (the readers are
 * passed in) so it is tested on its own.
 */

export interface TeamExtrasReaders {
  drawerLog: (q: { sinceIso: string; untilIso: string; limit: number; cursor?: string }) => Promise<DrawerLogPage>;
  deletedTests: (q: { sinceIso: string; untilIso: string; limit: number; offset: number }) => Promise<DeletedTestsPage>;
}

export type TeamExtras = Pick<ReportExtras, 'drawerLog' | 'deletedTests'> & {
  /** What could not be read ("the cash drawer log"), for a note on screen. */
  failed: string[];
};

const LOG_PAGE = 200;
const TESTS_PAGE = 500;
/** A safety stop, never reached by a shop: 1,000 reads is 200,000 drawer opens. */
export const TEAM_EXTRAS_MAX_READS = 1_000;

export const DRAWER_LOG_WORDS = 'the cash drawer log';
export const DELETED_TESTS_WORDS = 'the deleted test orders';

export async function fetchTeamExtras(
  period: { sinceIso: string; untilIso: string },
  read: TeamExtrasReaders,
): Promise<TeamExtras> {
  const failed: string[] = [];

  let drawerLog: ReportExtras['drawerLog'] = null;
  try {
    const rows: DrawerLogPage['rows'] = [];
    let first: DrawerLogPage | null = null;
    let cursor: string | null = null;
    for (let i = 0; i < TEAM_EXTRAS_MAX_READS; i += 1) {
      const page: DrawerLogPage = await read.drawerLog({
        sinceIso: period.sinceIso,
        untilIso: period.untilIso,
        limit: LOG_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      first ??= page;
      rows.push(...page.rows);
      // A cursor that does not move would read the same page for ever.
      if (!page.nextCursor || page.nextCursor === cursor || page.rows.length === 0) break;
      cursor = page.nextCursor;
    }
    if (first) drawerLog = { rows, counts: first.counts, logSince: first.logSince };
  } catch {
    failed.push(DRAWER_LOG_WORDS);
  }

  let deletedTests: ReportExtras['deletedTests'] = null;
  try {
    let page = await read.deletedTests({ ...period, limit: TESTS_PAGE, offset: 0 });
    const rows = [...page.rows];
    for (let i = 1; i < TEAM_EXTRAS_MAX_READS && rows.length < page.total && page.rows.length > 0; i += 1) {
      page = await read.deletedTests({ ...period, limit: TESTS_PAGE, offset: rows.length });
      rows.push(...page.rows);
    }
    deletedTests = { rows, total: page.total, totalCents: page.totalCents };
  } catch {
    failed.push(DELETED_TESTS_WORDS);
  }

  return { drawerLog, deletedTests, failed };
}

/** The screen's note when part of Team & leakage could not go on the paper or into the file. */
export function teamExtrasFailedText(failed: readonly string[]): string | null {
  if (failed.length === 0) return null;
  return `Could not read ${failed.join(' or ')}; the paper or file says so where the list would be. Try again in a moment.`;
}
