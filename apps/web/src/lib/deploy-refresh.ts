import { revalidatePath } from 'next/cache';

/**
 * Pages Next keeps (the ISR pages: home, delivery, landing pages) are first
 * rendered by the build. A build without the database (the Vercel build has
 * no DATABASE_URL) renders them from the built-in details and without the
 * menu's prices (site-facts: "no database = today's site"), and Next would
 * keep that for up to an hour after every deploy.
 *
 * So the first till heartbeat each server instance handles marks every page
 * stale once: the next visit renders it from the database. A till heartbeats
 * every minute, so the site is right within about a minute of a deploy. A
 * build that had the database (COC_BUILT_WITH_DB = '1', next.config.mjs)
 * skips it. Cost: one refresh per server instance.
 */
let refreshed = false;

export function refreshPagesAfterDeployOnce(revalidate: (path: string, type: 'layout') => void = revalidatePath): boolean {
  if (refreshed || process.env['COC_BUILT_WITH_DB'] === '1') return false;
  refreshed = true;
  try {
    revalidate('/', 'layout');
    return true;
  } catch (e) {
    // Outside a Next request (a test) this throws; the heartbeat still stands.
    console.warn('refreshing the pages after a deploy failed', e);
    return false;
  }
}

/** Tests only: forget that this instance refreshed. */
export function forgetDeployRefresh(): void {
  refreshed = false;
}
