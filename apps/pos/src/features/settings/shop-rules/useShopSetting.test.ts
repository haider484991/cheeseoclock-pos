/**
 * A Settings card that says "Not on the other till yet" is read again until
 * the save has reached the other till (and after each sync pass), so the note
 * does not stay up while the tab is open; a card with nothing waiting is not
 * polled.
 */
import { describe, expect, it } from 'vitest';
import { WAITING_CARD_REFETCH_MS, waitingCardRefetchMs } from './useShopSetting';

describe('re-reading a card that waits for the other till', () => {
  it('polls only while the save has not reached the other till', () => {
    expect(waitingCardRefetchMs({ notOnOtherTillYet: true })).toBe(WAITING_CARD_REFETCH_MS);
    expect(waitingCardRefetchMs({ notOnOtherTillYet: false })).toBe(false);
    expect(waitingCardRefetchMs(undefined)).toBe(false);
  });
});
