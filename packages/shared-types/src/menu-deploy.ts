/**
 * Menu file auto-deploy (v0.7.32): the costing PC uploads the generated menu
 * import file to the website, and one linked till claims and imports it by
 * itself (the owner, 29 Sep 2026: "this import file is irritating me it
 * should be automatic deploy for any machinse").
 *
 *   costing PC ──(upload key)──▶ website ──(BRIDGE_SECRET)──▶ till
 *   deploy_menu.py              POST /api/menu-deploy        GET  /api/bridge/menu-deploy
 *                               GET  /api/menu-deploy        POST /api/bridge/menu-deploy/<id>/claim
 *                                                            POST /api/bridge/menu-deploy/<id>/report
 *
 * The file holds costs and recipes: the website keeps it only in its own
 * tables and hands it out only behind BRIDGE_SECRET — never with the public
 * menu, never in a log. The upload key is made by the owner on a till, which
 * registers only its SHA-256 with the website; a new key cancels the old one.
 *
 * Pure constants and types (the wire schemas are shared-schemas menu-deploy.ts).
 */

/** The `format` every menu import file names (shared-schemas menu-import.ts). */
export const MENU_IMPORT_FILE_FORMAT = 'cheeseoclock-menu-import' as const;

/** Every upload key starts with this, so a key can never be mistaken for BRIDGE_SECRET. */
export const MENU_DEPLOY_KEY_PREFIX = 'cocmenu_';
/** 'cocmenu_' + base64url of 32 random bytes (43 characters, no padding). */
export const MENU_DEPLOY_KEY_RE = /^cocmenu_[A-Za-z0-9_-]{43}$/;
/** The raw JSON file, before gzip. The generator's file is about a tenth of this. */
export const MENU_FILE_MAX_BYTES = 2_000_000;
/** The gzip of a file at the limit, as base64, with headroom. */
export const MENU_UPLOAD_MAX_GZ_B64_CHARS = 2_800_000;
/** One upload request: under the host's 4.5 MB body limit. */
export const MENU_UPLOAD_MAX_BODY_BYTES = 3_500_000;
/** How long one till holds a claim before another may take it over (the owner's tap). */
export const MENU_DEPLOY_LEASE_SECONDS = 600;
/** Failed imports of one file before it stops by itself (back-off 1, 2, 4, 8 min, then 'failed'). */
export const MENU_DEPLOY_MAX_ATTEMPTS = 5;
/** The newest packages keep their file; older ones keep only their history. */
export const MENU_DEPLOY_KEEP_CONTENT = 5;
/** Uploads the website takes in any 24 hours. */
export const MENU_DEPLOY_UPLOADS_PER_DAY = 30;
/** Wrong upload keys from one address in 15 minutes before it is refused even the right one. */
export const MENU_DEPLOY_BAD_KEY_LIMIT = 10;

export const MENU_PACKAGE_STATES = ['pending', 'claimed', 'applied', 'failed', 'refused', 'superseded'] as const;
/**
 * pending    uploaded, no till has it yet (or a failed try waits for its next turn);
 * claimed    one till is importing it (a lease; an expired lease = "stalled");
 * applied    a till put it in (the other till gets it through the link);
 * failed     5 tries failed: waits for the owner's "Try again";
 * refused    the file itself is wrong (the till's full check) — never retried;
 * superseded a newer file arrived first.
 */
export type MenuPackageState = (typeof MENU_PACKAGE_STATES)[number];

export const MENU_DEPLOY_EVENT_KINDS = [
  'uploaded',
  'claimed',
  'taken_over',
  'applied',
  'received',
  'waiting_for_owner',
  'too_old',
  'failed',
  'refused',
  'key_created',
  'bad_key',
] as const;
export type MenuDeployEventKind = (typeof MENU_DEPLOY_EVENT_KINDS)[number];

/** 'shared': the tills are linked, one claims for both; 'own': a till with its link off imports for itself. */
export const MENU_DEPLOY_SCOPES = ['shared', 'own'] as const;
export type MenuDeployScope = (typeof MENU_DEPLOY_SCOPES)[number];

/** What a till tells the website after looking at (or importing) a package. */
export const MENU_DEPLOY_OUTCOMES = ['applied', 'received', 'waiting_for_owner', 'too_old', 'failed', 'refused'] as const;
export type MenuDeployOutcome = (typeof MENU_DEPLOY_OUTCOMES)[number];

/**
 * Why a claim was refused (409), the first that fits in this order:
 *  superseded       a newer file is on the website;
 *  refused          the file was refused (its format is wrong);
 *  too_old          the file's format is newer than this till reads ("update the till");
 *  already_applied  another till already put it in;
 *  failed           it failed 5 times (claim with retry to try again);
 *  stalled          another till's claim ran out — it, or an older file it held, may
 *                   be half done; only the owner's take-over claims it;
 *  claimed          another till is importing it now;
 *  busy             another till is importing an older file now;
 *  behind           a till put in a file this till has not received through the link yet;
 *  retry_later      it failed a moment ago: wait until its next try time;
 *  gone             its file is no longer kept.
 */
export const MENU_CLAIM_REFUSALS = [
  'superseded',
  'refused',
  'too_old',
  'already_applied',
  'failed',
  'stalled',
  'claimed',
  'busy',
  'behind',
  'retry_later',
  'gone',
] as const;
export type MenuClaimRefusal = (typeof MENU_CLAIM_REFUSALS)[number];
