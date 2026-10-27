import { gaEvent } from '@/lib/google-analytics';

/**
 * The ordering funnel as Google Analytics 4 events (24 Oct 2026: "less conversions in the past 2 or 3 weeks", and
 * nothing on the site counted the steps between a visit and an order). One event per step, at most two properties,
 * each from a short fixed list — never a name, a phone, an address or anything the customer typed — so the reports
 * compare weeks before and after a change: funnel_add_to_cart → funnel_checkout_opened → funnel_order_placed, plus
 * every reason the checkout stopped someone (funnel_checkout_problem) and every order sent on WhatsApp instead
 * (funnel_whatsapp_order). Like the Meta Pixel (lib/meta-pixel) it can never get in the way of an order: any failure
 * is swallowed.
 *
 * Until 27 Oct 2026 these were Vercel Web Analytics events ("Add to cart", "Checkout opened"…). They moved with the
 * site to Cloudflare: Vercel's free plan records no custom events, and GA4 event names take no spaces.
 */

export type AddHow = 'one tap' | 'sheet' | 'again';

export const funnel = {
  /** Something went in the cart: by its price button (one tap), through the item sheet, or "Order again". */
  addToCart(how: AddHow, deal: boolean): void {
    gaEvent('funnel_add_to_cart', { how, what: deal ? 'deal' : 'item' });
  },
  /** The cart / checkout sheet opened, while the kitchen takes website orders or not. */
  checkoutOpened(open: boolean): void {
    gaEvent('funnel_checkout_opened', { kitchen: open ? 'open' : 'closed' });
  },
  /**
   * The checkout stopped the customer: the form's own check (the field it sent them to) or the server's refusal
   * (its error code: store_closed, buy1get1_closed, outside_zone…).
   */
  checkoutProblem(where: 'form' | 'server', reason: string): void {
    gaEvent('funnel_checkout_problem', { where, reason: reason.slice(0, 40) || 'other' });
  },
  /** The server took the order. */
  orderPlaced(fulfilment: 'delivery' | 'pickup', deal: boolean): void {
    gaEvent('funnel_order_placed', { fulfilment, what: deal ? 'has a deal' : 'no deal' });
  },
  /**
   * The order went to WhatsApp instead: the kitchen was closed, the checkout failed and offered it, or the customer's
   * area is not on the list (AREA_NOT_LISTED, 26 Oct 2026).
   */
  whatsappOrder(why: 'closed' | 'problem' | 'area'): void {
    gaEvent('funnel_whatsapp_order', { why });
  },
};
