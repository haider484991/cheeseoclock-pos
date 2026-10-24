import { revalidatePath } from 'next/cache';
import { sql } from './db';
import { withSchema } from './schema-on-demand';

/**
 * Pages Next keeps (the ISR pages: home, menu, delivery, landing pages) are
 * first rendered by the build. A build without the database (the Vercel
 * build has no DATABASE_URL) renders them from the built-in details and
 * without the menu's prices (site-facts: "no database = today's site"), and
 * Next would keep that for up to an hour after every deploy.
 *
 * So the first till heartbeat (or store-status poll) after a deploy marks
 * every page stale once: the next visit renders it from the database. A till
 * heartbeats every minute, so the site is right within about a minute of a
 * deploy. A build that had the database (COC_BUILT_WITH_DB = '1',
 * next.config.mjs) skips it.
 *
 * Once per DEPLOYMENT, not per server instance (24 Oct 2026, "the website's
 * API is so slow"): Vercel starts and stops instances all day, and every new
 * one used to wipe every kept page again, so the next visitor to each page
 * waited for a fresh render (x-vercel-cache REVALIDATED, 2–3 s from Karachi).
 * The first instance of a deployment claims it in site_deploy_refresh; the
 * others ask once and leave the pages alone. Off Vercel (no
 * VERCEL_DEPLOYMENT_ID) it stays once per instance, as before.
 */
let refreshed = false;

/** Made only when the claim finds it missing (schema-on-demand): once per database, never per request. */
async function createRefreshTable(): Promise<void> {
  await sql()`
    CREATE TABLE IF NOT EXISTS site_deploy_refresh (
      deployment_id TEXT PRIMARY KEY,
      refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

/** True for the first instance of this deployment to ask; false once another one has. */
async function claimDeployment(deploymentId: string): Promise<boolean> {
  const rows = (await withSchema(createRefreshTable, () => sql()`
    INSERT INTO site_deploy_refresh (deployment_id) VALUES (${deploymentId})
    ON CONFLICT (deployment_id) DO NOTHING
    RETURNING deployment_id
  `)) as unknown[];
  return rows.length > 0;
}

export async function refreshPagesAfterDeployOnce(
  revalidate: (path: string, type: 'layout') => void = revalidatePath,
  claim: (deploymentId: string) => Promise<boolean> = claimDeployment,
): Promise<boolean> {
  if (refreshed || process.env['COC_BUILT_WITH_DB'] === '1') return false;
  refreshed = true;
  const deployment = process.env['VERCEL_DEPLOYMENT_ID'] || null;
  if (deployment !== null) {
    try {
      if (!(await claim(deployment))) return false;
    } catch (e) {
      // Can't tell whether another instance did it: refresh, as every instance did before.
      console.warn('could not check the deploy refresh; refreshing the pages', e);
    }
  }
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
