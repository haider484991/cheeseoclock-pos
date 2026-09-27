import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STAFF_TIMING } from '@cheeseoclock/shared-types';
import {
  DEFAULT_REPRINT_RULES,
  FREE_CASHIER_REPRINTS,
  REPRINT_FREE_WINDOW_MS,
  isCurrentOrder,
  reprintApproval,
  reprintRulesOf,
  type ReprintApprovalInput,
} from './reprint-policy.js';

/**
 * The owner's reprint rule (Settings → Staff & kitchen timing,
 * 'staff.timing' freeReprints 0–3 within reprintWindowMin 10–120): how many
 * papers a cashier may print again by hand, and for how long after the sale.
 * With nothing saved it is today's: one paper within 30 minutes
 * (reprint-policy.test.ts pins that, unchanged). Made-up orders.
 */
const NOW = Date.parse('2026-09-28T15:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const ask = (extra: Partial<ReprintApprovalInput> = {}): ReprintApprovalInput => ({
  role: 'cashier',
  document: 'receipt',
  copy: 'customer',
  status: 'paid',
  lastActivityAt: minutesAgo(5),
  nowMs: NOW,
  priorManual: 0,
  priorAll: 1,
  fbrCopy: false,
  orderLabel: 'Order #0042',
  ...extra,
});

describe('the released rule is today’s', () => {
  it('one paper within 30 minutes; no rule passed is the same as the default rule', () => {
    expect(DEFAULT_REPRINT_RULES).toEqual({ freeReprints: 1, windowMin: 30 });
    expect([FREE_CASHIER_REPRINTS, REPRINT_FREE_WINDOW_MS]).toEqual([1, 30 * 60_000]);
    expect(reprintRulesOf(DEFAULT_STAFF_TIMING)).toEqual(DEFAULT_REPRINT_RULES);
    for (const extra of [
      { priorManual: 0, priorAll: 1 },
      { priorManual: 1, priorAll: 2 },
      { lastActivityAt: minutesAgo(29) },
      { lastActivityAt: minutesAgo(31) },
      { priorAll: 0 },
    ]) {
      expect(reprintApproval(ask(extra))).toEqual(reprintApproval(ask({ ...extra, rules: DEFAULT_REPRINT_RULES })));
    }
  });
});

describe('the owner’s number of free papers', () => {
  it('two: the second paper by hand is free, the third needs a manager', () => {
    const rules = { freeReprints: 2, windowMin: 30 };
    expect(reprintApproval(ask({ priorManual: 1, priorAll: 2, rules })).approval).toBe(false);
    const third = reprintApproval(ask({ priorManual: 2, priorAll: 3, rules }));
    expect(third.approval).toBe(true);
    expect(third.why).toBe("Order #0042's receipt was already printed 3 times. A manager's PIN or password is needed for another copy.");
  });

  it('none: every copy by hand needs a manager — but the first paper, and the one with the FBR number, never do', () => {
    const rules = { freeReprints: 0, windowMin: 30 };
    expect(reprintApproval(ask({ priorManual: 0, priorAll: 1, rules }))).toEqual({
      approval: true,
      why: "Order #0042's receipt was already printed once. A manager's PIN or password is needed for another copy.",
    });
    expect(reprintApproval(ask({ priorAll: 0, rules })).approval).toBe(false);
    expect(reprintApproval(ask({ fbrCopy: true, priorAll: 1, rules })).approval).toBe(false);
  });

  it('a manager or the owner is never asked, whatever the rule', () => {
    for (const role of ['manager', 'admin'] as const) {
      expect(reprintApproval(ask({ role, priorManual: 3, priorAll: 4, rules: { freeReprints: 0, windowMin: 10 } })).approval).toBe(false);
    }
  });
});

describe('the owner’s free-reprint window', () => {
  it('60 minutes: an order paid 45 minutes ago is still in front of the counter; 61 minutes is not, and the words say 60', () => {
    const rules = { freeReprints: 1, windowMin: 60 };
    expect(reprintApproval(ask({ lastActivityAt: minutesAgo(45), rules })).approval).toBe(false);
    const late = reprintApproval(ask({ lastActivityAt: minutesAgo(61), rules }));
    expect(late).toEqual({
      approval: true,
      why: "Order #0042 was paid more than 60 minutes ago. A manager's PIN or password is needed to print its receipt now.",
    });
  });

  it('10 minutes: an order paid 11 minutes ago needs a manager', () => {
    expect(reprintApproval(ask({ lastActivityAt: minutesAgo(11), rules: { freeReprints: 1, windowMin: 10 } })).why).toMatch(
      /more than 10 minutes ago/,
    );
  });

  it('isCurrentOrder takes the window; an order still on Live Orders is current however old', () => {
    expect(isCurrentOrder('paid', minutesAgo(45), NOW, 60 * 60_000)).toBe(true);
    expect(isCurrentOrder('paid', minutesAgo(45), NOW)).toBe(false);
    expect(isCurrentOrder('preparing', minutesAgo(600), NOW, 10 * 60_000)).toBe(true);
    expect(isCurrentOrder('refunded', minutesAgo(1), NOW, 120 * 60_000)).toBe(false);
  });
});

describe('what Settings says is what the till does', () => {
  /**
   * The words on Settings → Staff & kitchen timing and Settings → Printers
   * (src/features/settings/shop-rules/timingWords.ts), loaded by path as the
   * screen loads them: the main process's tsconfig does not take screen files.
   */
  type ReprintRuleText = (t: { freeReprints: number; reprintWindowMin: number } | null) => string;
  async function screenWords(): Promise<ReprintRuleText> {
    const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const url = pathToFileURL(join(app, 'src', 'features', 'settings', 'shop-rules', 'timingWords.ts')).href;
    return ((await import(/* @vite-ignore */ url)) as { reprintRuleText: ReprintRuleText }).reprintRuleText;
  }

  it('none: the copy that adds the FBR number is still free for the order in front of the counter, and the words say so', async () => {
    const reprintRuleText = await screenWords();
    const rules = { freeReprints: 0, windowMin: 45 };
    // The till: another copy by hand needs a manager; the FBR copy of a current order does not; an older one does.
    expect(reprintApproval(ask({ priorManual: 0, priorAll: 1, rules })).approval).toBe(true);
    expect(reprintApproval(ask({ fbrCopy: true, priorManual: 0, priorAll: 1, rules })).approval).toBe(false);
    expect(reprintApproval(ask({ fbrCopy: true, priorAll: 1, lastActivityAt: minutesAgo(46), rules })).approval).toBe(true);
    // The words: every copy needs a manager EXCEPT that one, and only within the owner's minutes.
    const words = reprintRuleText({ freeReprints: 0, reprintWindowMin: 45 });
    expect(words).toContain("every copy needs a manager's PIN or password, except the one copy that adds the FBR number");
    expect(words).toContain('paid in the last 45 minutes');
    expect(words).not.toMatch(/every copy needs a manager's PIN or password\.$/);
  });
});
