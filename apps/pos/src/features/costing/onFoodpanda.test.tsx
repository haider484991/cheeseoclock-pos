/**
 * The cost sheet's "On foodpanda" line (Settings → foodpanda): the listing at
 * foodpanda's prices and the price after the deal for anyone who may see
 * costs; foodpanda's commission and what the shop keeps only when the main
 * process sent them (profit.view: the owner). Every figure is made up.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ItemFoodpandaLine } from '@cheeseoclock/shared-types';
import { OnFoodpanda } from './ItemCostSheet';

const LINE: ItemFoodpandaLine = {
  dealPercent: 20,
  shopPercent: 20,
  minOrderCents: null,
  priceCents: 100_000,
  upliftBps: 1_000,
  listingPriceCents: 110_000,
  priceAfterDealCents: 88_000,
  foodCostBps: 3_409,
  owner: null,
};

const html = (line: ItemFoodpandaLine) => renderToStaticMarkup(<OnFoodpanda line={line} costCents={30_000} />);

describe('"On foodpanda" on the cost sheet', () => {
  it("a manager's sheet: the listing and the price after the deal, no commission, nothing kept", () => {
    const out = html(LINE);
    expect(out).toContain('Listed at Rs 1,100');
    expect(out).toContain('10% above the till');
    expect(out).toContain('Rs 880');
    expect(out).not.toMatch(/commission|you keep/i);
  });

  it("the owner's: foodpanda's commission, marked when not confirmed, and what he keeps", () => {
    const out = html({ ...LINE, owner: { commissionBps: 2_500, confirmed: false, foodpandaKeepsCents: 22_000, youKeepCents: 66_000, foodCostOfKeptBps: 4_545 } });
    expect(out).toContain('foodpanda keeps about Rs 220');
    expect(out).toContain('not confirmed yet');
    expect(out).toContain('you keep <b>Rs 660</b>');
  });

  it("at the till's prices it says no listing price of its own", () => {
    expect(html({ ...LINE, upliftBps: 0, listingPriceCents: 100_000, priceAfterDealCents: 80_000 })).not.toContain('Listed at');
  });
});
