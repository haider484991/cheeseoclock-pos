/**
 * Menu files from the costing PC (v0.7.32; shared-types menu-deploy.ts):
 * what a till does next with the newest file on the website, and the words
 * the owner reads about it. Pure — the main process
 * (services/menu-package-service.ts) gathers the facts, asks here, and does
 * what comes back.
 *
 * THE RULE (the first that fits wins; `pkg` = the newest file):
 *   R1  no file                                   → idle
 *   R2  this till's marker has it (or newer)      → done: applied (by this till) or
 *                                                   received (through the link);
 *                                                   says so to the website once
 *   R2b the website says this till put it in, but → never again by itself: other_till
 *       its marker does not have it (a backup       (linked, and it is in on the website),
 *       copy restored since)                        else waiting_for_owner (said once)
 *   R3  its format is newer than this till reads  → too_old (said once)
 *   R4  refused (the website's word, or this till's own check)  → refused
 *   R5  failed 5 times                            → gave_up (the owner's "Try again")
 *   R6  linked, and another till put it in        → other_till (its rows come through the link)
 *   R7  linked, and another till holds it         → other_till, or stalled once its claim ran out
 *                                                   (never taken over by itself)
 *   R8  "Wait for my OK", or the file would cut   → waiting_for_owner (said once)
 *       prices to less than half or change the
 *       tax (menuDeployNeedsOwner: never by itself)
 *   R9  linked, and the link is not working       → waiting_link
 *   R10 a failed try is waiting for its next turn → failed
 *   R11 an order was rung up here a moment ago    → waiting_quiet
 *   R12 otherwise                                 → claim it (the website decides who)
 *
 * "Has it" goes by the package id, then by when the website took it —
 * never by its number alone: the numbers start again if the website's
 * database is ever reset (menuMarkerCovers).
 */
import {
  MENU_DEPLOY_MAX_ATTEMPTS,
  type MenuClaimRefusal,
  type MenuDeployCountsView,
  type MenuDeployHistoryLine,
  type MenuDeployNotice,
  type MenuDeployOutcome,
  type MenuDeployPhase,
  type MenuDeployScope,
} from '@cheeseoclock/shared-types';

/** The newest file as the website describes it (shared-schemas menuPackageMetaSchema: the fields the rule reads). */
export interface MenuDeployPackageFacts {
  id: string;
  seq: number;
  /** When the website took it (its clock, ISO). */
  uploadedAt: string;
  fileName: string;
  formatVersion: number;
  state: string;
  claimedBy: string | null;
  leaseExpired: boolean;
  retryReady: boolean;
  appliedBy: string | null;
}

/** The synced marker of the last file put in on either till ('menu.lastPackage'). */
export interface MenuDeployMarkerFacts {
  packageId: string;
  seq: number;
  /** When the website took the file (absent on a marker that does not say). */
  uploadedAt?: string | null;
  appliedByDevice: string;
  counts: MenuDeployCountsView;
}

/**
 * The marker has this package, or a newer one: the same package id, or one
 * the website took later. Never by the number alone (after a reset of the
 * website's database a new file #1 is newer than an old #12); a marker that
 * does not say when falls back to the number.
 */
export function menuMarkerCovers(
  marker: Pick<MenuDeployMarkerFacts, 'packageId' | 'seq' | 'uploadedAt'> | null,
  pkg: Pick<MenuDeployPackageFacts, 'id' | 'seq' | 'uploadedAt'>,
): boolean {
  if (!marker) return false;
  if (marker.packageId === pkg.id) return true;
  const m = marker.uploadedAt ? Date.parse(marker.uploadedAt) : Number.NaN;
  const p = Date.parse(pkg.uploadedAt);
  if (Number.isFinite(m) && Number.isFinite(p)) return m > p;
  return marker.seq >= pkg.seq;
}

/** This till's own bookkeeping for the newest file (pure-local settings 'menuDeploy.local'). */
export interface MenuDeployLocalFacts {
  /** Failed tries of this file on this till. */
  attempts: number;
  /** Not before this (ISO): the back-off after a failed try. */
  nextTryAt: string | null;
  /** This till's full check refused the file (its format is wrong). */
  refused: boolean;
  /**
   * Why the file waits for the owner's OK although the till puts files in by
   * itself (menuDeployNeedsOwner: it would cut prices to less than half, or
   * change the tax), or null.
   */
  held?: string | null;
  error: string | null;
  /** `${packageId}:${outcome}` the website has taken. */
  reported: readonly string[];
}

export interface MenuDeployDecisionInput {
  pkg: MenuDeployPackageFacts | null;
  marker: MenuDeployMarkerFacts | null;
  /** Already this file's (menuDeployLocalFor). */
  local: MenuDeployLocalFacts;
  deviceId: string;
  scope: MenuDeployScope;
  /**
   * The website says THIS till put the newest file in (it said "applied",
   * in either scope). With no marker of it here, a backup copy was restored
   * since: it is never put in again by itself.
   */
  appliedHereBefore: boolean;
  /** The link to the other till is on and has gone quiet, failing or paused. */
  linkStale: boolean;
  mode: 'auto' | 'ask';
  /** The newest menu file format this till reads (shared-schemas MAX_MENU_FILE_VERSION). */
  maxFormatVersion: number;
  /** No order rung up on this till in the last couple of minutes. */
  quiet: boolean;
  nowMs: number;
}

export type MenuDeployRule = 'R1' | 'R2' | 'R2b' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12';

export interface MenuDeployStep {
  rule: MenuDeployRule;
  phase: MenuDeployPhase;
  /** Tell the website this now. */
  report: { outcome: MenuDeployOutcome; counts?: MenuDeployCountsView; error?: string } | null;
  /** Ask the website for the file (it decides which till gets it). */
  claim: { lastPackageSeq: number | null; lastPackageId: string | null } | null;
}

/** How long a till waits after an order before putting a menu file in by itself. */
export const MENU_DEPLOY_QUIET_MS = 2 * 60_000;

/** The key a once-only report is remembered by. */
export function menuDeployReportKey(packageId: string, outcome: MenuDeployOutcome): string {
  return `${packageId}:${outcome}`;
}

/** The wait after the n-th failed try (n from 0): 1, 2, 4, then 8 minutes — the website's own back-off. */
export function menuDeployBackoffMs(attemptsBefore: number): number {
  const n = Math.max(0, Math.floor(attemptsBefore));
  return (n <= 0 ? 1 : n === 1 ? 2 : n === 2 ? 4 : 8) * 60_000;
}

function step(rule: MenuDeployRule, phase: MenuDeployPhase, extra: Partial<Pick<MenuDeployStep, 'report' | 'claim'>> = {}): MenuDeployStep {
  return { rule, phase, report: extra.report ?? null, claim: extra.claim ?? null };
}

/** THE RULE (above). */
export function decideMenuDeployStep(input: MenuDeployDecisionInput): MenuDeployStep {
  const { pkg, marker, local, deviceId: me, scope } = input;
  const shared = scope === 'shared';
  const said = (outcome: MenuDeployOutcome) => pkg !== null && local.reported.includes(menuDeployReportKey(pkg.id, outcome));

  // R1
  if (!pkg) return step('R1', 'idle');

  // R2: done — the file is in on this till (put in here, or arrived through the link).
  if (marker && menuMarkerCovers(marker, pkg)) {
    // A marker of a NEWER file (the website's database went back): nothing to say about this one.
    const sameFile = marker.packageId === pkg.id;
    if (marker.appliedByDevice === me) {
      const otherHoldsIt = pkg.state === 'claimed' && pkg.claimedBy !== null && pkg.claimedBy !== me && !pkg.leaseExpired;
      // Put in here but the website never heard (a lost report, or the till stopped right after the import).
      const tell = sameFile && !said('applied') && (shared ? pkg.state !== 'applied' && !otherHoldsIt : true);
      return step('R2', 'applied', tell ? { report: { outcome: 'applied', counts: marker.counts } } : {});
    }
    return step('R2', 'received', !sameFile || said('received') ? {} : { report: { outcome: 'received' } });
  }

  // R2b: this till put it in once, and its menu no longer has it (a backup copy restored since).
  // Never again by itself: the owner restored that copy, perhaps to undo this very file.
  if (input.appliedHereBefore) {
    if (shared && pkg.state === 'applied') return step('R2b', 'other_till');
    return step('R2b', 'waiting_for_owner', said('waiting_for_owner') ? {} : { report: { outcome: 'waiting_for_owner' } });
  }

  // R3: never downloaded.
  if (pkg.formatVersion > input.maxFormatVersion) {
    return step('R3', 'too_old', said('too_old') ? {} : { report: { outcome: 'too_old' } });
  }

  // R4
  if (local.refused) {
    return step('R4', 'refused', said('refused') ? {} : { report: { outcome: 'refused', error: local.error ?? 'The till refused the file.' } });
  }
  if (shared && pkg.state === 'refused') return step('R4', 'refused');

  // R5
  if ((shared && pkg.state === 'failed') || local.attempts >= MENU_DEPLOY_MAX_ATTEMPTS) return step('R5', 'gave_up');

  if (shared) {
    // R6
    if (pkg.state === 'applied') return step('R6', 'other_till');
    // R7: an expired claim is NEVER taken over by itself — only the owner's take-over (it may double items).
    if (pkg.state === 'claimed' && pkg.claimedBy !== null && pkg.claimedBy !== me) {
      return step('R7', pkg.leaseExpired ? 'stalled' : 'other_till');
    }
  }

  // R8: the owner's OK first — always in "Wait for my OK", and for a file that would cut prices or change the tax.
  if (input.mode === 'ask' || local.held) {
    return step('R8', 'waiting_for_owner', said('waiting_for_owner') ? {} : { report: { outcome: 'waiting_for_owner' } });
  }

  // R9
  if (shared && input.linkStale) return step('R9', 'waiting_link');

  // R10: never a tight loop — the website's next try time (linked) and this till's own.
  const localWait = local.nextTryAt !== null && Date.parse(local.nextTryAt) > input.nowMs;
  if ((shared && !pkg.retryReady) || localWait) return step('R10', 'failed');

  // R11
  if (!input.quiet) return step('R11', 'waiting_quiet');

  // R12
  return step('R12', 'claimed', { claim: { lastPackageSeq: marker?.seq ?? null, lastPackageId: marker?.packageId ?? null } });
}

/** What an import of the file would change that a till never puts in by itself (read from its plan). */
export interface MenuDeployPlanFacts {
  /** Items the file would move onto another tax rate. */
  taxChanges: number;
  /** Existing items whose selling price the file would change: from → to (paisa). */
  priceChanges: ReadonlyArray<{ fromCents: number; toCents: number }>;
}

/**
 * Why a file must wait for the owner's OK even when the tills put files in
 * by themselves — or null. The costing PC's upload key is all it takes to
 * send a file, so a file that would sell items for less than half their
 * price (Rs 0 included) or change what tax is charged never goes in
 * unattended; ordinary price changes and new items do.
 */
export function menuDeployNeedsOwner(f: MenuDeployPlanFacts): string | null {
  const cut = f.priceChanges.filter((c) => c.fromCents > 0 && c.toCents * 2 < c.fromCents).length;
  const parts: string[] = [];
  if (cut > 0) parts.push(`cut ${plural(cut, 'price', 'prices')} to less than half`);
  if (f.taxChanges > 0) parts.push(`change the tax on ${plural(f.taxChanges, 'item', 'items')}`);
  return parts.length ? `it would ${parts.join(' and ')}` : null;
}

/**
 * What a claim the website refused (409) means for this till: its phase, or
 * null with `recheckMs` — a newer file arrived a moment ago: look again soon.
 */
export function menuClaimRefusalStep(code: MenuClaimRefusal | string): { phase: MenuDeployPhase | null; recheckMs?: number; behind?: true } {
  switch (code) {
    case 'behind':
      return { phase: 'waiting_link', behind: true };
    case 'claimed':
    case 'busy':
    case 'already_applied':
      return { phase: 'other_till' };
    case 'stalled':
      return { phase: 'stalled' };
    case 'too_old':
      return { phase: 'too_old' };
    case 'retry_later':
      return { phase: 'failed' };
    case 'superseded':
      return { phase: null, recheckMs: 5_000 };
    case 'refused':
      return { phase: 'refused' };
    case 'failed':
      return { phase: 'gave_up' };
    case 'gone':
    default:
      return { phase: 'failed' };
  }
}

/** This till's bookkeeping, started afresh when a newer file is the newest (what was said is kept). */
export function menuDeployLocalFor<L extends MenuDeployLocalFacts & { packageId: string | null }>(local: L, packageId: string): L {
  if (local.packageId === packageId) return local;
  return { ...local, packageId, attempts: 0, nextTryAt: null, refused: false, held: null, error: null };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 new items, 5 changed, 2 price changes" — or "nothing to change". Numbers only. */
export function menuDeployCountsLine(c: MenuDeployCountsView): string {
  const parts: string[] = [];
  if (c.newItems) parts.push(plural(c.newItems, 'new item', 'new items'));
  if (c.updatedItems) parts.push(`${c.updatedItems} changed`);
  if (c.priceChanges) parts.push(plural(c.priceChanges, 'price change', 'price changes'));
  if (c.newIngredients) parts.push(plural(c.newIngredients, 'new ingredient', 'new ingredients'));
  if (c.updatedIngredients) parts.push(plural(c.updatedIngredients, 'ingredient changed', 'ingredients changed'));
  if (c.newCategories) parts.push(plural(c.newCategories, 'new category', 'new categories'));
  if (c.recipesSet) parts.push(plural(c.recipesSet, 'recipe', 'recipes'));
  if (c.choiceGroupsChanged) parts.push(plural(c.choiceGroupsChanged, 'choice group', 'choice groups'));
  if (c.batchRecipesSet) parts.push(plural(c.batchRecipesSet, 'batch recipe', 'batch recipes'));
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  return parts.length === 0 ? 'nothing to change' : parts.join(', ');
}

/** The file as the owner knows it: "file #4 (cheeseoclock-menu-import.json)" — starting a sentence, "File #4 (…)". */
function fileWords(fileName: string | null | undefined, seq: number | null | undefined): string {
  const name = fileName && fileName.trim() ? fileName.trim() : null;
  if (seq) return name ? `file #${seq} (${name})` : `file #${seq}`;
  return name ? `the menu file ${name}` : 'the new menu file';
}

export interface MenuDeployMessageContext {
  fileName?: string | null;
  seq?: number | null;
  /** The error of the last failed try, or why the file was refused. */
  error?: string | null;
  formatVersion?: number | null;
  maxFormatVersion: number;
  /** other_till: the other till put it in (true), or is putting it in now (false). */
  otherPutIn?: boolean;
  /** other_till / waiting_for_owner where the website says THIS till put it in, but its menu does not have it (a backup restored?). */
  appliedHereButMissing?: boolean;
  /** waiting_for_owner although the tills put files in by themselves: why (menuDeployNeedsOwner). */
  heldReason?: string | null;
  /** waiting_link: waiting for the other till's last menu changes (not for the link itself). */
  behind?: boolean;
  /** applied: put in by itself. */
  automatic?: boolean;
  /** idle: this till has not heard from the website yet (just started, or it could not be reached). */
  notLookedYet?: boolean;
}

/** One plain sentence for each phase (Settings, Menu → Import, the Dashboard). */
export function menuDeployPhaseMessage(phase: MenuDeployPhase, ctx: MenuDeployMessageContext): string {
  const file = fileWords(ctx.fileName, ctx.seq);
  const error = ctx.error?.trim() ? ctx.error.trim().replace(/[.\s]+$/, '') : null;
  switch (phase) {
    case 'not_linked':
      return 'This till has no website link (Settings → Online orders), so it does not look for menu files from the costing PC itself. With the link to the other till on (Settings → Second till), a file the other till puts in reaches this till through that link.';
    case 'website_old':
      return 'The website doesn’t take menu files from the costing PC yet — nothing to do until it is updated.';
    case 'idle':
      return ctx.notLookedYet
        ? 'This till has not looked for a menu file from the costing PC yet — it does within a minute of starting, or tap Check now.'
        : 'No menu file has been sent from the costing PC yet.';
    case 'waiting_for_owner':
      if (ctx.appliedHereButMissing) {
        return `This till put in ${file} before, but its menu doesn’t have it now (a backup copy restored since?). It is not put in again by itself: Menu → Import shows what it would change, and one tap puts it in.`;
      }
      if (ctx.heldReason) {
        return `A new menu file, ${file}, waits for your OK: ${ctx.heldReason}. Menu → Import shows every change first.`;
      }
      return `A new menu file is waiting for your OK: ${file}. Menu → Import shows what it changes.`;
    case 'waiting_quiet':
      return `A new menu file, ${file}, goes in by itself once no order has been rung up here for a couple of minutes.`;
    case 'waiting_link':
      return ctx.behind
        ? `${cap(file)} waits for the other till’s last menu changes to arrive through the link.`
        : `The link to the other till isn’t working, so ${file} waits: putting it in now could leave the two tills with different menus.`;
    case 'other_till':
      if (ctx.appliedHereButMissing) {
        return `This till put in ${file} before, but its menu doesn’t have it now (a backup copy restored since?). It is not put in again by itself; the next file from the costing PC goes in as usual.`;
      }
      return ctx.otherPutIn
        ? `The other till put in ${file}; its changes are on the way through the link.`
        : `The other till is putting in ${file} now; its changes come through the link.`;
    case 'stalled':
      return `The other till started putting in ${file} and stopped. It finishes by itself when that till is back on. If that till is off or broken, the owner can tap Take it over in Menu → Import — if it did finish, the menu may get doubled items.`;
    case 'claimed':
      return `Putting in ${file}…`;
    case 'importing':
      return `Putting in ${file} now (a backup copy was made first).`;
    case 'applied':
      return `This till put in the newest menu file, ${file}${ctx.automatic ? ', by itself' : ''}.`;
    case 'received':
      return `The newest menu file, ${file}, came from the other till through the link.`;
    case 'failed':
      return error
        ? `Putting in ${file} failed: ${error}. The till tries again by itself in a few minutes.`
        : `Putting in ${file} has to wait a few minutes after a failed try; the till tries again by itself.`;
    case 'gave_up':
      return `Putting in ${file} failed ${MENU_DEPLOY_MAX_ATTEMPTS} times${error ? ` (${error})` : ''}. Nothing was changed. Tap Try again in Menu → Import; if it fails again, show this message to whoever makes the menu file.`;
    case 'refused':
      return `${cap(file)} was refused${error ? `: ${error}` : ''}. Nothing was changed. Fix the file on the costing PC and send it again.`;
    case 'too_old':
      return `${cap(file)} is newer than this till can read (format ${ctx.formatVersion ?? '?'}; this till reads up to ${ctx.maxFormatVersion}). Update the till (Settings → About); then it goes in by itself.`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The note for the people who manage the menu, when a phase is news (one per file per kind). */
export function menuDeployNoticeFor(
  phase: MenuDeployPhase,
  ctx: MenuDeployMessageContext & { counts?: MenuDeployCountsView | null; otherTillName?: string | null },
): MenuDeployNotice | null {
  const file = fileWords(ctx.fileName, ctx.seq);
  switch (phase) {
    case 'applied':
      return {
        kind: 'applied',
        title: 'New menu put in from the costing file',
        description: `${cap(ctx.counts ? menuDeployCountsLine(ctx.counts) : 'the menu was updated')} — ${file}. A backup copy was made first.`,
      };
    case 'received':
      return {
        kind: 'received',
        title: `New menu arrived from ${ctx.otherTillName?.trim() || 'the other till'}`,
        description: `${cap(file)} came through the link${ctx.counts ? `: ${menuDeployCountsLine(ctx.counts)}` : ''}.`,
      };
    case 'waiting_for_owner':
      return {
        kind: 'waiting_for_owner',
        title: 'A new menu file is waiting — Menu → Import',
        description: ctx.heldReason
          ? `${cap(file)} waits for your OK: ${ctx.heldReason}. See every change, then put it in with one tap.`
          : ctx.appliedHereButMissing
            ? menuDeployPhaseMessage('waiting_for_owner', ctx)
            : `${cap(file)}: see what it changes, then put it in with one tap.`,
      };
    case 'refused':
    case 'gave_up':
    case 'too_old':
    case 'stalled':
      return {
        kind: 'problem',
        title:
          phase === 'refused'
            ? 'A menu file was refused'
            : phase === 'gave_up'
              ? 'A menu file could not be put in'
              : phase === 'too_old'
                ? 'This till is too old for the new menu file'
                : 'A menu update stopped halfway on the other till',
        description: menuDeployPhaseMessage(phase, ctx),
      };
    default:
      return null;
  }
}

/** One line of the website's history (newest first), as the owner reads it. */
export interface MenuDeployEventFacts {
  at: string;
  kind: string;
  fileName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  detail: Record<string, unknown> | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The counts in a history line's detail (numbers only; anything else is ignored). */
function countsIn(detail: Record<string, unknown> | null): MenuDeployCountsView | null {
  const c = detail?.['counts'];
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const n = (k: keyof MenuDeployCountsView) => num(o[k]) ?? 0;
  return {
    newItems: n('newItems'),
    updatedItems: n('updatedItems'),
    priceChanges: n('priceChanges'),
    newIngredients: n('newIngredients'),
    updatedIngredients: n('updatedIngredients'),
    newCategories: n('newCategories'),
    recipesSet: n('recipesSet'),
    choiceGroupsChanged: n('choiceGroupsChanged'),
    batchRecipesSet: n('batchRecipesSet'),
    skipped: n('skipped'),
  };
}

/** "This till" / "Till by the door" / "A till". */
function whoWords(e: MenuDeployEventFacts, myDeviceId: string): string {
  if (e.deviceId && e.deviceId === myDeviceId) return 'This till';
  return e.deviceName?.trim() || (e.deviceId ? 'The other till' : 'A till');
}

export function describeMenuDeployEvent(e: MenuDeployEventFacts, myDeviceId: string): MenuDeployHistoryLine {
  const who = whoWords(e, myDeviceId);
  const file = e.fileName?.trim() || 'a menu file';
  const d = e.detail;
  const error = str(d?.['error']);
  const line = (text: string, tone: MenuDeployHistoryLine['tone'] = 'ok'): MenuDeployHistoryLine => ({ at: e.at, text, tone });
  switch (e.kind) {
    case 'uploaded': {
      const items = num(d?.['itemCount']);
      const ingredients = num(d?.['ingredientCount']);
      const from = str(d?.['uploader']);
      const sizes = items !== null && ingredients !== null ? ` (${plural(items, 'item', 'items')}, ${plural(ingredients, 'ingredient', 'ingredients')})` : '';
      const made = str(d?.['generatedAt']);
      return { ...line(`${file} sent from ${from ?? 'the costing PC'}${sizes}`), ...(made ? { fileMadeAt: made } : {}) };
    }
    case 'claimed':
      return line(`${who} started putting in ${file}`);
    case 'taken_over':
      return line(`${who} took over ${file} from a till that had stopped`, 'warn');
    case 'applied': {
      const counts = countsIn(d);
      const what = counts ? `: ${menuDeployCountsLine(counts)}` : '';
      if (d?.['duplicate'] === true) return line(`${who} put in ${file} again after another till had — look for doubled items${what}`, 'warn');
      if (d?.['recovered'] === true) return line(`${who} had put in ${file} (noticed later)`);
      return line(`${who} put in ${file}${what}`);
    }
    case 'received':
      return line(`${who} got ${file} through the link`);
    case 'waiting_for_owner':
      return line(`${who} is waiting for the owner’s OK to put in ${file}`);
    case 'too_old': {
      const v = num(d?.['formatVersion']);
      const max = num(d?.['maxFormatVersion']);
      const fmt = v !== null && max !== null ? ` (format ${v}; it reads up to ${max})` : '';
      return line(`${who} is too old to read ${file}${fmt} — update that till`, 'error');
    }
    case 'failed':
      return line(`${who} could not put in ${file}${error ? `: ${error}` : ''}`, d?.['retryable'] === false ? 'error' : 'warn');
    case 'refused':
      return line(`${who} refused ${file}${error ? `: ${error}` : ''}`, 'error');
    case 'key_created': {
      const hint = str(d?.['keyHint']);
      return line(`${who} made a new upload key${hint ? ` (…${hint})` : ''}; the old key stopped working`);
    }
    case 'bad_key':
      return line('Someone tried a wrong upload key', 'warn');
    default:
      return line(`${who}: ${e.kind.replace(/_/g, ' ')} ${file}`);
  }
}
