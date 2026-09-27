import { describe, expect, it } from 'vitest';
import { approvalRuleText, mostOffWithoutManagerCents, requiresManagerApproval } from './discount.js';

/**
 * The one approval rule with the owner's limit (Settings → Money &
 * discounts, 'discounts.approval'). The same function decides the F3 locks,
 * the IPC check and the repository's save and cart re-check, so these cases
 * hold in all three (apps/pos electron/ipc/handlers/owner-rules.db.test.ts
 * drives the three with a saved limit). Made-up amounts.
 */
describe('requiresManagerApproval with the owner’s limit', () => {
  it('a raised limit lets more through, a lowered one less', () => {
    const raised = { percentOver: 20, flatOverCents: 100_000 };
    expect(requiresManagerApproval({ type: 'percent', value: 20 }, 200_000, raised)).toBe(false);
    expect(requiresManagerApproval({ type: 'percent', value: 21 }, 200_000, raised)).toBe(true);
    const lowered = { percentOver: 5, flatOverCents: 20_000 };
    expect(requiresManagerApproval({ type: 'percent', value: 5 }, 200_000, lowered)).toBe(false);
    expect(requiresManagerApproval({ type: 'percent', value: 10 }, 200_000, lowered)).toBe(true);
  });

  it('a rupee amount is held to the rupee limit AND to the % limit of the order, as before', () => {
    const limits = { percentOver: 20, flatOverCents: 100_000 };
    // Rs 400 off Rs 2,000 is exactly 20%: fine. Rs 401 is over 20%.
    expect(requiresManagerApproval({ type: 'flat', value: 40_000 }, 200_000, limits)).toBe(false);
    expect(requiresManagerApproval({ type: 'flat', value: 40_100 }, 200_000, limits)).toBe(true);
    // Rs 1,000 off Rs 10,000 is 10%, under 20%, and at the Rs 1,000 limit: fine. Rs 1,001 is over it.
    expect(requiresManagerApproval({ type: 'flat', value: 100_000 }, 1_000_000, limits)).toBe(false);
    expect(requiresManagerApproval({ type: 'flat', value: 100_100 }, 1_000_000, limits)).toBe(true);
  });

  it('0% means every discount needs a manager — rupee amounts too', () => {
    const none = { percentOver: 0, flatOverCents: 50_000 };
    expect(requiresManagerApproval({ type: 'percent', value: 1 }, 200_000, none)).toBe(true);
    expect(requiresManagerApproval({ type: 'flat', value: 100 }, 200_000, none)).toBe(true);
    // Nothing off is not a discount to approve.
    expect(requiresManagerApproval({ type: 'percent', value: 0 }, 200_000, none)).toBe(false);
  });

  it('Rs 0 means every rupee discount needs a manager; the % limit still stands', () => {
    const noRupees = { percentOver: 10, flatOverCents: 0 };
    expect(requiresManagerApproval({ type: 'flat', value: 100 }, 200_000, noRupees)).toBe(true);
    expect(requiresManagerApproval({ type: 'percent', value: 10 }, 200_000, noRupees)).toBe(false);
  });
});

describe('the rule in words, built from the limit', () => {
  it('the default', () => {
    expect(approvalRuleText({ percentOver: 10, flatOverCents: 50_000 })).toBe(
      "Up to 10% off, or up to Rs 500 off if that is no more than 10% of the order, without a manager. More needs a manager's PIN or password.",
    );
  });

  it('follows the owner’s numbers', () => {
    expect(approvalRuleText({ percentOver: 15, flatOverCents: 100_000 })).toBe(
      "Up to 15% off, or up to Rs 1,000 off if that is no more than 15% of the order, without a manager. More needs a manager's PIN or password.",
    );
    expect(approvalRuleText({ percentOver: 0, flatOverCents: 50_000 })).toBe("Every discount needs a manager's PIN or password.");
    expect(approvalRuleText({ percentOver: 10, flatOverCents: 0 })).toBe(
      "Up to 10% off without a manager. More, or any amount off in rupees, needs a manager's PIN or password.",
    );
  });

  it('on an order with a delivery charge a discount leaves alone, the words name the food — what the limit is checked on', () => {
    expect(approvalRuleText({ percentOver: 10, flatOverCents: 50_000 }, 'food')).toBe(
      "Up to 10% off, or up to Rs 500 off if that is no more than 10% of the food, without a manager. More needs a manager's PIN or password.",
    );
    expect(approvalRuleText({ percentOver: 10, flatOverCents: 0 }, 'food')).toBe(
      "Up to 10% off the food without a manager. More, or any amount off in rupees, needs a manager's PIN or password.",
    );
    expect(approvalRuleText({ percentOver: 0, flatOverCents: 50_000 }, 'food')).toBe("Every discount needs a manager's PIN or password.");
    // The words and the lock agree: Rs 210 off Rs 2,000 of food (a Rs 200 charge on top) is over 10% of the food.
    expect(requiresManagerApproval({ type: 'flat', value: 21_000 }, 200_000)).toBe(true);
    expect(approvalRuleText({ percentOver: 10, flatOverCents: 50_000 })).toBe(approvalRuleText({ percentOver: 10, flatOverCents: 50_000 }, 'order'));
  });

  it('the most a cashier can take off alone: the smaller of the rupee limit and the % of the order', () => {
    const limits = { percentOver: 10, flatOverCents: 50_000 };
    expect(mostOffWithoutManagerCents(limits, 200_000)).toBe(20_000);
    expect(mostOffWithoutManagerCents(limits, 1_000_000)).toBe(50_000);
    expect(mostOffWithoutManagerCents(limits, 0)).toBe(0);
    // …and that amount itself never needs a manager, one paisa more does.
    for (const order of [60_000, 200_000, 1_234_567, 1_000_000]) {
      const most = mostOffWithoutManagerCents(limits, order);
      expect(requiresManagerApproval({ type: 'flat', value: most }, order, limits)).toBe(false);
      expect(requiresManagerApproval({ type: 'flat', value: most + 1 }, order, limits)).toBe(true);
    }
  });
});
