/**
 * What a till shows about the menu files from the costing PC (v0.7.32,
 * menu-deploy.ts): Settings → Kitchen & stock ("Menu file from the costing
 * PC"), the panel above Menu → Import, the Dashboard's banner and the
 * notices. The main process builds it (services/menu-package-service.ts)
 * from the website's status, this till's own bookkeeping and the synced
 * marker of the last file put in; the words come from pos-domain
 * menu-deploy.ts.
 *
 * Never holds the file, its costs, or the upload key.
 */

/**
 * Where this till stands with the newest menu file:
 *  not_linked        no website link on this till (Settings → Online orders);
 *  website_old       the website is older than this feature: nothing to do;
 *  idle              no file uploaded yet;
 *  waiting_for_owner "Wait for my OK": the file waits in Menu → Import;
 *  waiting_quiet     an order was rung up a moment ago: it goes in when the counter is quiet;
 *  waiting_link      the link to the other till is not working, or the other till's
 *                    last menu changes have not arrived yet;
 *  other_till        the other till is putting it in, or has (its changes come through the link);
 *  stalled           the other till started putting it in and stopped: the owner's take-over;
 *  claimed           this till has it and is about to put it in;
 *  importing         this till is putting it in now;
 *  applied           this till put it in;
 *  received          the other till put it in and its changes are here;
 *  failed            putting it in failed: the till tries again by itself later;
 *  gave_up           it failed 5 times: the owner's "Try again";
 *  refused           the file itself is wrong: never tried again;
 *  too_old           the file is newer than this till reads: update the till.
 */
export const MENU_DEPLOY_PHASES = [
  'not_linked',
  'website_old',
  'idle',
  'waiting_for_owner',
  'waiting_quiet',
  'waiting_link',
  'other_till',
  'stalled',
  'claimed',
  'importing',
  'applied',
  'received',
  'failed',
  'gave_up',
  'refused',
  'too_old',
] as const;
export type MenuDeployPhase = (typeof MENU_DEPLOY_PHASES)[number];

/** Phases the owner should hear about on the Dashboard (Shop status). */
export const MENU_DEPLOY_PROBLEM_PHASES: readonly MenuDeployPhase[] = Object.freeze(['refused', 'gave_up', 'too_old', 'stalled']);

/**
 * How many of each thing an import changed — numbers only (the website's
 * counts, shared-schemas menu-deploy.ts menuDeployCountsSchema, have exactly
 * these fields).
 */
export interface MenuDeployCountsView {
  newItems: number;
  updatedItems: number;
  priceChanges: number;
  newIngredients: number;
  updatedIngredients: number;
  newCategories: number;
  recipesSet: number;
  choiceGroupsChanged: number;
  batchRecipesSet: number;
  skipped: number;
}

/** One line of the history (Settings), newest first. */
export interface MenuDeployHistoryLine {
  at: string;
  text: string;
  tone: 'ok' | 'warn' | 'error';
  /** A file sent from the costing PC: when the generator made it (the screen says "made 29 Sep, 14:02"). */
  fileMadeAt?: string;
}

/** A note for the people who manage the menu (shown once per file per kind). */
export interface MenuDeployNotice {
  kind: 'applied' | 'received' | 'waiting_for_owner' | 'problem';
  title: string;
  description: string;
}

export interface MenuDeployView {
  /** This till has the website link (Settings → Online orders: address and secret). */
  websiteLinked: boolean;
  phase: MenuDeployPhase;
  /** One plain sentence about the phase. */
  message: string;
  /** 'shared': the tills are linked, one puts each file in for both; 'own': this till's link is off. */
  scope: 'shared' | 'own';
  /** Settings → Kitchen & stock: put in by themselves, or wait for the owner's OK. */
  mode: 'auto' | 'ask';
  /** The upload key the costing PC uses (only its last 4 characters), or null when none was made. */
  key: { keyHint: string; createdAt: string; deviceName: string | null; madeOnThisTill: boolean } | null;
  /** The newest file on the website (never its content). */
  package: {
    id: string;
    seq: number;
    fileName: string;
    source: string | null;
    generatedAt: string;
    uploadedAt: string;
    itemCount: number;
    ingredientCount: number;
    formatVersion: number;
    state: string;
  } | null;
  /** The last file put in (on this till or arriving from the other), from the synced marker. */
  appliedHere: {
    fileName: string;
    seq: number;
    at: string;
    automatic: boolean;
    byThisTill: boolean;
    counts: MenuDeployCountsView;
  } | null;
  /** "Show the changes" / Apply are offered (waiting for the owner, given up, stalled). */
  canApplyNow: boolean;
  /** Applying now takes the file over from a till that stopped: the owner's login. */
  applyNeedsOwner: boolean;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  /** The last error putting the file in, or reaching the website, in plain words. */
  lastError: string | null;
  /** Only when asked for (menuDeploy:getStatus with history): the last lines, newest first. */
  history?: MenuDeployHistoryLine[];
}

/** menuDeploy:changed — main → renderer. */
export interface MenuDeployChangedEvent {
  view: MenuDeployView;
  notice: MenuDeployNotice | null;
}

/** menuDeploy:createKey — the key, shown ONCE on the owner's screen, never stored on the till. */
export interface MenuDeployKeyMade {
  key: string;
  keyHint: string;
  createdAt: string;
}
