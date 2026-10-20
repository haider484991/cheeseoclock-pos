/**
 * The menu item that carries a delivery fee is named in the shop's money, and
 * the till still knows it for a fee. It prints on the bill, so it matters.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  US_SHOP_LOCALE,
  deliveryChargeItemName,
  isDeliveryChargeName,
  resetShopLocale,
  setShopLocale,
} from '@cheeseoclock/shared-types';

afterEach(resetShopLocale);

describe('the delivery fee item', () => {
  it('is named exactly as before in Pakistan', () => {
    expect(deliveryChargeItemName(20_000)).toBe('Delivery Charge (Rs 200)');
    expect(deliveryChargeItemName(125_000)).toBe('Delivery Charge (Rs 1,250)');
  });

  it('is named in dollars on a US till, and is still a delivery charge', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(deliveryChargeItemName(300)).toBe('Delivery Charge ($3)');
    expect(deliveryChargeItemName(125_000)).toBe('Delivery Charge ($1,250)');
    expect(isDeliveryChargeName(deliveryChargeItemName(300))).toBe(true);
  });
});
