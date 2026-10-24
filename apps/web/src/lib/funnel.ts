import { track } from '@vercel/analytics';

/**
 * The ordering funnel as Vercel Web Analytics events (24 Oct 2026: "less conversions in the past 2 or 3 weeks", and
 * nothing on the site counted the steps between a visit and an order). One event per step, at most two properties,
 * each from a short fixed list — never a name, a phone, an address or anything the customer typed — so the Events
 * tab compares weeks before and after a change: Add to cart → Checkout opened → Order placed, plus every reason the
 * checkout stopped someone and every order sent on WhatsApp instead. Like the Meta Pixel (lib/meta-pixel) it can
 * never get in the way of an order: any failure is swallowed.
 */

export type AddHow = 'one tap' | 'sheet' | 'again';

function send(name: string, props: Record<string, string>): void {
  try {
    track(name, props);
  } catch {
    // Analytics never blocks the order.
  }
}

export const funnel = {
  /** Something went in the cart: by its price button (one tap), through the item sheet, or "Order again". */
  addToCart(how: AddHow, deal: boolean): void {
    send('Add to cart', { how, what: deal ? 'deal' : 'item' });
  },
  /** The cart / checkout sheet opened, while the kitchen takes website orders or not. */
  checkoutOpened(open: boolean): void {
    send('Checkout opened', { kitchen: open ? 'open' : 'closed' });
  },
  /**
   * The checkout stopped the customer: the form's own check (the field it sent them to) or the server's refusal
   * (its error code: store_closed, buy1get1_closed, outside_zone…).
   */
  checkoutProblem(where: 'form' | 'server', reason: string): void {
    send('Checkout problem', { where, reason: reason.slice(0, 40) || 'other' });
  },
  /** The server took the order. */
  orderPlaced(fulfilment: 'delivery' | 'pickup', deal: boolean): void {
    send('Order placed', { fulfilment, what: deal ? 'has a deal' : 'no deal' });
  },
  /** The order went to WhatsApp instead: the kitchen was closed, or the checkout failed and offered it. */
  whatsappOrder(why: 'closed' | 'problem'): void {
    send('WhatsApp order', { why });
  },
};
