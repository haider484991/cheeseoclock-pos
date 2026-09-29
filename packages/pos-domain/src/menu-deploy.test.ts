/**
 * Menu files from the costing PC (v0.7.32): THE RULE a till follows with the
 * newest file on the website, row by row (R1–R12), what a refused claim
 * means, and the words the owner reads. Every name and number is made up.
 */
import { describe, expect, it } from 'vitest';
import type { MenuDeployCountsView } from '@cheeseoclock/shared-types';
import {
  MENU_DEPLOY_QUIET_MS,
  decideMenuDeployStep,
  describeMenuDeployEvent,
  menuClaimRefusalStep,
  menuDeployBackoffMs,
  menuDeployCountsLine,
  menuDeployLocalFor,
  menuDeployNoticeFor,
  menuDeployPhaseMessage,
  menuDeployReportKey,
  type MenuDeployDecisionInput,
  type MenuDeployPackageFacts,
} from './menu-deploy.js';

const ME = 'till-1';
const OTHER = 'till-2';
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const ZERO: MenuDeployCountsView = {
  newItems: 0,
  updatedItems: 0,
  priceChanges: 0,
  newIngredients: 0,
  updatedIngredients: 0,
  newCategories: 0,
  recipesSet: 0,
  choiceGroupsChanged: 0,
  batchRecipesSet: 0,
  skipped: 0,
};
const COUNTS: MenuDeployCountsView = { ...ZERO, newItems: 3, updatedItems: 5, priceChanges: 2 };

const pkg = (over: Partial<MenuDeployPackageFacts> = {}): MenuDeployPackageFacts => ({
  id: 'p2',
  seq: 2,
  fileName: 'test-menu.json',
  formatVersion: 3,
  state: 'pending',
  claimedBy: null,
  leaseExpired: false,
  retryReady: true,
  appliedBy: null,
  ...over,
});

const input = (over: Partial<MenuDeployDecisionInput> = {}): MenuDeployDecisionInput => ({
  pkg: pkg(),
  marker: { packageId: 'p1', seq: 1, appliedByDevice: ME, counts: ZERO },
  local: { attempts: 0, nextTryAt: null, refused: false, error: null, reported: [] },
  deviceId: ME,
  scope: 'shared',
  linkStale: false,
  mode: 'auto',
  maxFormatVersion: 3,
  quiet: true,
  nowMs: NOW,
  ...over,
});

describe('THE RULE, row by row', () => {
  it('R1: no file on the website → idle, nothing said, nothing claimed', () => {
    expect(decideMenuDeployStep(input({ pkg: null }))).toEqual({ rule: 'R1', phase: 'idle', report: null, claim: null });
  });

  it('R2: this till put it in → applied; the website is told (from the marker’s counts) when it does not know yet — once', () => {
    const marker = { packageId: 'p2', seq: 2, appliedByDevice: ME, counts: COUNTS };
    // The report was lost (or the till stopped right after the import): the website still says claimed by this till.
    expect(decideMenuDeployStep(input({ marker, pkg: pkg({ state: 'claimed', claimedBy: ME }) }))).toMatchObject({
      rule: 'R2',
      phase: 'applied',
      report: { outcome: 'applied', counts: COUNTS },
      claim: null,
    });
    // Already applied on the website, or already told: nothing more.
    expect(decideMenuDeployStep(input({ marker, pkg: pkg({ state: 'applied', appliedBy: ME }) }))).toMatchObject({ rule: 'R2', report: null });
    const told = { attempts: 0, nextTryAt: null, refused: false, error: null, reported: [menuDeployReportKey('p2', 'applied')] };
    expect(decideMenuDeployStep(input({ marker, local: told, pkg: pkg({ state: 'claimed', claimedBy: ME }) }))).toMatchObject({ report: null });
    // Another till holds a live claim on it (a take-over): never told over its head.
    expect(decideMenuDeployStep(input({ marker, pkg: pkg({ state: 'claimed', claimedBy: OTHER }) }))).toMatchObject({ phase: 'applied', report: null });
    // …but a claim of the other's that ran out does not stop the truth.
    expect(decideMenuDeployStep(input({ marker, pkg: pkg({ state: 'claimed', claimedBy: OTHER, leaseExpired: true }) }))).toMatchObject({
      report: { outcome: 'applied' },
    });
    // Link off (own scope): the website's state never changes; told once.
    expect(decideMenuDeployStep(input({ marker, scope: 'own', pkg: pkg({ state: 'pending' }) }))).toMatchObject({
      phase: 'applied',
      report: { outcome: 'applied' },
    });
    expect(decideMenuDeployStep(input({ marker, scope: 'own', local: told }))).toMatchObject({ phase: 'applied', report: null });
  });

  it('R2: the other till put it in → received, said once; never claimed', () => {
    const marker = { packageId: 'p2', seq: 2, appliedByDevice: OTHER, counts: COUNTS };
    expect(decideMenuDeployStep(input({ marker, pkg: pkg({ state: 'applied', appliedBy: OTHER }) }))).toEqual({
      rule: 'R2',
      phase: 'received',
      report: { outcome: 'received' },
      claim: null,
    });
    const said = { attempts: 0, nextTryAt: null, refused: false, error: null, reported: [menuDeployReportKey('p2', 'received')] };
    expect(decideMenuDeployStep(input({ marker, local: said }))).toMatchObject({ phase: 'received', report: null, claim: null });
    // A marker AHEAD of the newest file (a newer one reached this till first) is done too.
    expect(decideMenuDeployStep(input({ marker: { ...marker, seq: 7 } }))).toMatchObject({ rule: 'R2', claim: null });
  });

  it('R3: a file newer than this till reads is never downloaded — too_old, said once', () => {
    expect(decideMenuDeployStep(input({ pkg: pkg({ formatVersion: 4 }) }))).toEqual({
      rule: 'R3',
      phase: 'too_old',
      report: { outcome: 'too_old' },
      claim: null,
    });
    const said = { attempts: 0, nextTryAt: null, refused: false, error: null, reported: [menuDeployReportKey('p2', 'too_old')] };
    expect(decideMenuDeployStep(input({ pkg: pkg({ formatVersion: 4 }), local: said }))).toMatchObject({ phase: 'too_old', report: null });
  });

  it('R4: refused — by the website (linked) or by this till’s own check (resent until the website has it)', () => {
    expect(decideMenuDeployStep(input({ pkg: pkg({ state: 'refused' }) }))).toMatchObject({ rule: 'R4', phase: 'refused', report: null, claim: null });
    const local = { attempts: 0, nextTryAt: null, refused: true, error: 'The menu file has a problem (at items.0.name): Required', reported: [] };
    expect(decideMenuDeployStep(input({ local, scope: 'own' }))).toMatchObject({
      rule: 'R4',
      report: { outcome: 'refused', error: 'The menu file has a problem (at items.0.name): Required' },
    });
    expect(
      decideMenuDeployStep(input({ local: { ...local, reported: [menuDeployReportKey('p2', 'refused')] } })),
    ).toMatchObject({ phase: 'refused', report: null, claim: null });
  });

  it('R5: failed 5 times (the website’s word, or this till’s own count) → gave_up', () => {
    expect(decideMenuDeployStep(input({ pkg: pkg({ state: 'failed' }) }))).toMatchObject({ rule: 'R5', phase: 'gave_up', claim: null });
    expect(
      decideMenuDeployStep(input({ scope: 'own', local: { attempts: 5, nextTryAt: null, refused: false, error: 'x', reported: [] } })),
    ).toMatchObject({ rule: 'R5', phase: 'gave_up', claim: null });
    // Four is not five.
    expect(
      decideMenuDeployStep(input({ scope: 'own', local: { attempts: 4, nextTryAt: null, refused: false, error: 'x', reported: [] } })),
    ).toMatchObject({ rule: 'R12' });
  });

  it('R6: linked, and another till put it in (the marker not here yet) → other_till; with the link off it is this till’s own', () => {
    expect(decideMenuDeployStep(input({ pkg: pkg({ state: 'applied', appliedBy: OTHER }) }))).toMatchObject({ rule: 'R6', phase: 'other_till', claim: null });
    expect(decideMenuDeployStep(input({ scope: 'own', pkg: pkg({ state: 'applied', appliedBy: OTHER }) }))).toMatchObject({ rule: 'R12' });
  });

  it('R7: another till holds it → other_till; once its claim ran out → stalled, NEVER taken over by itself', () => {
    expect(decideMenuDeployStep(input({ pkg: pkg({ state: 'claimed', claimedBy: OTHER }) }))).toMatchObject({ rule: 'R7', phase: 'other_till', claim: null });
    expect(decideMenuDeployStep(input({ pkg: pkg({ state: 'claimed', claimedBy: OTHER, leaseExpired: true }) }))).toMatchObject({
      rule: 'R7',
      phase: 'stalled',
      claim: null,
    });
    // This till's own claim (it stopped halfway): claimed again.
    expect(decideMenuDeployStep(input({ pkg: pkg({ state: 'claimed', claimedBy: ME, leaseExpired: true }) }))).toMatchObject({ rule: 'R12' });
  });

  it('R8: "Wait for my OK" → waiting_for_owner, said once, never claimed', () => {
    expect(decideMenuDeployStep(input({ mode: 'ask' }))).toEqual({
      rule: 'R8',
      phase: 'waiting_for_owner',
      report: { outcome: 'waiting_for_owner' },
      claim: null,
    });
    const said = { attempts: 0, nextTryAt: null, refused: false, error: null, reported: [menuDeployReportKey('p2', 'waiting_for_owner')] };
    expect(decideMenuDeployStep(input({ mode: 'ask', local: said }))).toMatchObject({ phase: 'waiting_for_owner', report: null, claim: null });
  });

  it('R9: linked and the link is not working → waiting_link; with the link off it does not matter', () => {
    expect(decideMenuDeployStep(input({ linkStale: true }))).toMatchObject({ rule: 'R9', phase: 'waiting_link', claim: null });
    expect(decideMenuDeployStep(input({ linkStale: true, scope: 'own' }))).toMatchObject({ rule: 'R12' });
  });

  it('R10: a failed try waits for its next turn — the website’s (linked) and this till’s own', () => {
    expect(decideMenuDeployStep(input({ pkg: pkg({ retryReady: false }) }))).toMatchObject({ rule: 'R10', phase: 'failed', claim: null });
    const waiting = { attempts: 1, nextTryAt: new Date(NOW + 30_000).toISOString(), refused: false, error: 'x', reported: [] };
    expect(decideMenuDeployStep(input({ scope: 'own', local: waiting }))).toMatchObject({ rule: 'R10', claim: null });
    expect(decideMenuDeployStep(input({ local: waiting }))).toMatchObject({ rule: 'R10', claim: null });
    // Its time has come.
    expect(decideMenuDeployStep(input({ scope: 'own', local: waiting, nowMs: NOW + 60_000 }))).toMatchObject({ rule: 'R12' });
  });

  it('R11: an order rung up here a moment ago → waiting_quiet', () => {
    expect(decideMenuDeployStep(input({ quiet: false }))).toMatchObject({ rule: 'R11', phase: 'waiting_quiet', claim: null });
    expect(MENU_DEPLOY_QUIET_MS).toBe(120_000);
  });

  it('R12: otherwise claim it, saying which file this till has last (the website refuses a till that is behind)', () => {
    expect(decideMenuDeployStep(input())).toEqual({ rule: 'R12', phase: 'claimed', report: null, claim: { lastPackageSeq: 1 } });
    expect(decideMenuDeployStep(input({ marker: null }))).toMatchObject({ claim: { lastPackageSeq: null } });
  });

  it('the order of the rows: a file this till has beats everything; too new beats refused; refused beats given up', () => {
    const marker = { packageId: 'p2', seq: 2, appliedByDevice: OTHER, counts: ZERO };
    expect(decideMenuDeployStep(input({ marker, pkg: pkg({ formatVersion: 9, state: 'refused' }) })).rule).toBe('R2');
    expect(decideMenuDeployStep(input({ pkg: pkg({ formatVersion: 9, state: 'refused' }) })).rule).toBe('R3');
    expect(decideMenuDeployStep(input({ pkg: pkg({ state: 'refused' }), local: { attempts: 9, nextTryAt: null, refused: false, error: null, reported: [] } })).rule).toBe('R4');
    expect(decideMenuDeployStep(input({ mode: 'ask', linkStale: true, quiet: false })).rule).toBe('R8');
  });
});

describe('a claim the website refused (409)', () => {
  it('maps each reason to where the till stands', () => {
    expect(menuClaimRefusalStep('behind')).toEqual({ phase: 'waiting_link', behind: true });
    for (const code of ['claimed', 'busy', 'already_applied']) expect(menuClaimRefusalStep(code)).toEqual({ phase: 'other_till' });
    expect(menuClaimRefusalStep('stalled')).toEqual({ phase: 'stalled' });
    expect(menuClaimRefusalStep('too_old')).toEqual({ phase: 'too_old' });
    expect(menuClaimRefusalStep('retry_later')).toEqual({ phase: 'failed' });
    expect(menuClaimRefusalStep('superseded')).toEqual({ phase: null, recheckMs: 5_000 });
    expect(menuClaimRefusalStep('refused')).toEqual({ phase: 'refused' });
    expect(menuClaimRefusalStep('failed')).toEqual({ phase: 'gave_up' });
    expect(menuClaimRefusalStep('gone')).toEqual({ phase: 'failed' });
    expect(menuClaimRefusalStep('something new')).toEqual({ phase: 'failed' });
  });
});

describe('bookkeeping', () => {
  it('the back-off is the website’s: 1, 2, 4, then 8 minutes', () => {
    expect([0, 1, 2, 3, 4, 9].map(menuDeployBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 480_000, 480_000]);
  });

  it('a newer file starts the tries afresh; what was said is kept', () => {
    const old = { v: 1, packageId: 'p1', attempts: 3, nextTryAt: '2026-09-29T12:00:00.000Z', refused: true, error: 'x', reported: ['p1:received'], notified: ['p1:received'] };
    expect(menuDeployLocalFor(old, 'p1')).toBe(old);
    expect(menuDeployLocalFor(old, 'p2')).toEqual({ ...old, packageId: 'p2', attempts: 0, nextTryAt: null, refused: false, error: null });
  });
});

describe('the words', () => {
  it('counts: numbers only, zeros left out', () => {
    expect(menuDeployCountsLine(COUNTS)).toBe('3 new items, 5 changed, 2 price changes');
    expect(menuDeployCountsLine({ ...ZERO, newItems: 1, newIngredients: 1, recipesSet: 1, newCategories: 2 })).toBe(
      '1 new item, 1 new ingredient, 2 new categories, 1 recipe',
    );
    expect(menuDeployCountsLine(ZERO)).toBe('nothing to change');
  });

  it('each phase has one plain sentence', () => {
    const ctx = { fileName: 'test-menu.json', seq: 4, maxFormatVersion: 3 };
    expect(menuDeployPhaseMessage('waiting_for_owner', ctx)).toBe(
      'A new menu file is waiting for your OK: file #4 (test-menu.json). Menu → Import shows what it changes.',
    );
    expect(menuDeployPhaseMessage('too_old', { ...ctx, formatVersion: 4 })).toBe(
      'File #4 (test-menu.json) is newer than this till can read (format 4; this till reads up to 3). Update the till (Settings → About); then it goes in by itself.',
    );
    expect(menuDeployPhaseMessage('other_till', { ...ctx, otherPutIn: true })).toBe(
      'The other till put in file #4 (test-menu.json); its changes are on the way through the link.',
    );
    expect(menuDeployPhaseMessage('waiting_link', { ...ctx, behind: true })).toContain('waits for the other till’s last menu changes');
    expect(menuDeployPhaseMessage('stalled', ctx)).toContain('the owner can take it over in Menu → Import');
    expect(menuDeployPhaseMessage('stalled', ctx)).toContain('doubled items');
    expect(menuDeployPhaseMessage('gave_up', { ...ctx, error: 'The disk is full.' })).toBe(
      'Putting in file #4 (test-menu.json) failed 5 times (The disk is full). Nothing was changed. Fix what it says, then tap Try again in Menu → Import.',
    );
    expect(menuDeployPhaseMessage('refused', { ...ctx, error: 'The menu file has a problem' })).toContain('Fix the file on the costing PC');
    expect(menuDeployPhaseMessage('applied', { ...ctx, automatic: true })).toBe('This till put in the newest menu file, file #4 (test-menu.json), by itself.');
    for (const phase of [
      'not_linked',
      'website_old',
      'idle',
      'waiting_quiet',
      'waiting_link',
      'claimed',
      'importing',
      'received',
      'failed',
    ] as const) {
      expect({ phase, ok: menuDeployPhaseMessage(phase, ctx).length > 20 }).toEqual({ phase, ok: true });
    }
  });

  it('notices: applied with its counts, received from the other till, waiting, and problems', () => {
    const ctx = { fileName: 'test-menu.json', seq: 4, maxFormatVersion: 3 };
    expect(menuDeployNoticeFor('applied', { ...ctx, counts: COUNTS })).toEqual({
      kind: 'applied',
      title: 'New menu put in from the costing file',
      description: '3 new items, 5 changed, 2 price changes — file #4 (test-menu.json). A backup copy was made first.',
    });
    expect(menuDeployNoticeFor('received', { ...ctx, otherTillName: 'Till 2' })).toMatchObject({ kind: 'received', title: 'New menu arrived from Till 2' });
    expect(menuDeployNoticeFor('waiting_for_owner', ctx)).toMatchObject({ kind: 'waiting_for_owner', title: 'A new menu file is waiting — Menu → Import' });
    for (const phase of ['refused', 'gave_up', 'too_old', 'stalled'] as const) {
      expect(menuDeployNoticeFor(phase, ctx)).toMatchObject({ kind: 'problem' });
    }
    for (const phase of ['idle', 'claimed', 'importing', 'other_till', 'waiting_quiet', 'failed'] as const) {
      expect(menuDeployNoticeFor(phase, ctx)).toBeNull();
    }
  });

  it('the history, as the owner reads it: this till by name, counts only, problems marked', () => {
    const e = (kind: string, detail: Record<string, unknown> | null, deviceId: string | null = OTHER) =>
      describeMenuDeployEvent({ at: '2026-09-29T12:00:00.000Z', kind, fileName: 'test-menu.json', deviceId, deviceName: 'Till 2', detail }, ME);
    expect(e('uploaded', { uploader: 'COSTING-PC', itemCount: 12, ingredientCount: 1, generatedAt: '2026-09-29T11:55:00.000Z' }, null)).toEqual({
      at: '2026-09-29T12:00:00.000Z',
      text: 'test-menu.json sent from COSTING-PC (12 items, 1 ingredient)',
      tone: 'ok',
      fileMadeAt: '2026-09-29T11:55:00.000Z',
    });
    expect(e('applied', { counts: COUNTS }).text).toBe('Till 2 put in test-menu.json: 3 new items, 5 changed, 2 price changes');
    expect(e('applied', { counts: COUNTS }, ME).text).toBe('This till put in test-menu.json: 3 new items, 5 changed, 2 price changes');
    expect(e('applied', { duplicate: true })).toMatchObject({ tone: 'warn' });
    expect(e('received', null, ME).text).toBe('This till got test-menu.json through the link');
    expect(e('too_old', { formatVersion: 4, maxFormatVersion: 3 })).toEqual({
      at: '2026-09-29T12:00:00.000Z',
      text: 'Till 2 is too old to read test-menu.json (format 4; it reads up to 3) — update that till',
      tone: 'error',
    });
    expect(e('failed', { error: 'The disk is full.', retryable: true })).toMatchObject({ tone: 'warn', text: 'Till 2 could not put in test-menu.json: The disk is full.' });
    expect(e('refused', { error: 'Bad file' })).toMatchObject({ tone: 'error' });
    expect(e('key_created', { keyHint: 'ab_Z' }, ME).text).toBe('This till made a new upload key (…ab_Z); the old key stopped working');
    expect(e('bad_key', null, null)).toMatchObject({ tone: 'warn', text: 'Someone tried a wrong upload key' });
    expect(e('taken_over', { from: OTHER })).toMatchObject({ tone: 'warn' });
    // Anything the counts hold that is not a number is ignored (never a price line).
    expect(e('applied', { counts: { newItems: 'Rs 1,200', updatedItems: 1 } }).text).toBe('Till 2 put in test-menu.json: 1 changed');
  });
});
