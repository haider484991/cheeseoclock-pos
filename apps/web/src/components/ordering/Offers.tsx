import { formatCents } from '@/lib/format';
import { OFFER_FINE_PRINT, OFFER_HEADLINE, OFFER_RULES, OFFER_TAG_LINE, type CardOffer } from '@/lib/offers';

/**
 * The menu's offers, set in the page's own colours (lib/offers has the words and the rules; nothing here
 * prices anything). Two pieces: the Buy 1 Get 1 line in the menu's header, and the small note on each card.
 * Since 20 Oct 2026 (the cleaner menu) both are short: the header says the offer and its hours in one tap-able
 * line, and the rules sit where they are acted on — the Buy 1 Get 1 deals' own cards, or (no deals on the menu
 * yet) behind the line itself.
 */

/** "Buy 1 Large pizza → any burger…": the rule's two halves, the buy half with that pizza's menu price when the menu has it. */
function ruleParts(rule: string, prices: { mediumCents: number | null; largeCents: number | null }): [string, string] {
  const [buy = rule, get = ''] = rule.split(' → ');
  const price = /Large pizza/.test(buy) ? prices.largeCents : /Medium pizza/.test(buy) ? prices.mediumCents : null;
  return [price === null ? buy : `${buy} (${formatCents(price)})`, get];
}

/**
 * In the menu's header: Buy 1 Get 1 FREE, its hours and where it counts, on one line. With the deals on the menu it
 * jumps to them (their cards say each rule; the section says "delivery charges & tax may apply"); without, it opens
 * to the two rules, how the free item is earned and the delivery-and-tax words. Not shown at all while the owner
 * has the offer switched off (OrderingApp).
 */
export function OfferTeaser({
  prices,
  where,
  window,
  dealsAnchor = null,
}: {
  prices: { mediumCents: number | null; largeCents: number | null };
  /** Where and when it counts, in the shop's words (page-copy MENU_OFFER_WHERE: "every day" only while open daily). */
  where: string;
  /** The offer's hours in words, as the owner set them on the till (lib/offers offerWindow: "1–7 PM"). */
  window: string;
  /** The Buy 1 Get 1 deals' section on this menu (7 Oct 2026): the line jumps there; null = it opens to the rules. */
  dealsAnchor?: string | null;
}) {
  const words = (
    <span className="min-w-0">
      <span className="block font-display text-[1.4rem] uppercase leading-none tracking-wide text-cheese sm:text-[1.7rem]">
        {OFFER_HEADLINE} <span className="whitespace-nowrap">· {window}</span>
      </span>
      <span className="mt-1 block font-cond text-[0.8rem] font-bold uppercase tracking-[0.12em] text-cream/70">{where}</span>
    </span>
  );
  const box = 'rounded-2xl border border-cheese/45 bg-cheese/[0.08] px-4 py-3';
  if (dealsAnchor) {
    return (
      <a
        href={`#${dealsAnchor}`}
        aria-label={`${OFFER_HEADLINE}, ${window}: see the deals`}
        className={`flex items-center justify-between gap-3 transition-colors hover:bg-cheese/15 ${box}`}
      >
        {words}
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-cheese py-2 pl-3 pr-2.5 font-cond text-sm font-extrabold uppercase tracking-wide text-ink">
          Deals <span aria-hidden>↓</span>
        </span>
      </a>
    );
  }
  return (
    <details className={`group ${box}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        {words}
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-cheese/60 text-cheese transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <ul className="mt-3 space-y-1.5 border-t border-cheese/25 pt-3 text-[0.95rem] leading-snug text-cream/90">
        {OFFER_RULES.map((rule) => {
          const [buy, get] = ruleParts(rule, prices);
          return (
            <li key={rule}>
              <b className="font-bold text-cheese">{buy}</b> → {get}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-sm leading-snug text-cream/75">{OFFER_TAG_LINE}</p>
      <p className="mt-2.5 inline-block rounded-md bg-cheese px-2 py-1 font-cond text-xs font-extrabold uppercase tracking-wide text-ink">
        {OFFER_FINE_PRINT}
      </p>
    </details>
  );
}

/** A card's offers as the menu shows them (OrderingApp works them out per section; lib/offers has the words). */
export interface ShownOffer {
  offer: CardOffer;
  /** Every online order takes the % (lib/offers discountOnEveryOrder): the price buttons show the prices after it. */
  onPrice: boolean;
  /** That % ("20% off" on the card) when `onPrice`; else null and the card says the % in full. */
  pct: number | null;
  /**
   * The regular pizzas while the menu has Buy 1 Get 1 deals: their Buy 1 Get 1 words are the same on every card, so
   * each shows only the offer and its hours (it jumps to the deals, whose cards say each rule). Burgers and sides
   * keep their one line of what is free; so do the pizzas of a menu with no deals yet.
   */
  brief: boolean;
}

/**
 * On a card, one row of small tags: the % off and Buy 1 Get 1 with its hours — then, for a burger or a side, what
 * makes it free; for a % one way of ordering takes (not on the prices), what each size comes to. The Buy 1 Get 1 tag
 * jumps to the Buy 1 Get 1 deals when the menu has them.
 */
export function OfferStrip({
  shown,
  dark = false,
  dealsAnchor = null,
}: {
  shown: ShownOffer;
  dark?: boolean;
  /** The Buy 1 Get 1 deals' section on this menu; null = the tag is words only. */
  dealsAnchor?: string | null;
}) {
  const { offer, onPrice, pct, brief } = shown;
  if (!offer.bogo && !offer.discount) return null;
  const tag = 'inline-block rounded-full px-2 py-0.5 font-cond text-xs font-extrabold uppercase tracking-wide';
  const bogoTag = offer.bogo && (
    <span className={`${tag} border ${dark ? 'border-cheese/70 text-cheese' : 'border-ink/70 text-ink'}`}>
      {offer.bogo.title}
      {dealsAnchor && <span aria-hidden> ›</span>}
    </span>
  );
  return (
    <div className="mt-2.5">
      <p className="flex flex-wrap items-center gap-1.5">
        {offer.discount && (
          <span className={`${tag} bg-cheese text-ink`}>{onPrice && pct ? `${pct}% off` : offer.discount.label}</span>
        )}
        {bogoTag &&
          (dealsAnchor ? (
            <a href={`#${dealsAnchor}`} aria-label={`${offer.bogo!.title}: see the Buy 1 Get 1 deals`} className="hover:opacity-80">
              {bogoTag}
            </a>
          ) : (
            bogoTag
          ))}
      </p>
      {offer.bogo && !brief && (
        <p className={`mt-1 text-[0.8rem] leading-snug ${dark ? 'text-cream/70' : 'text-ink-muted'}`}>{offer.bogo.detail}</p>
      )}
      {offer.discount && !onPrice && offer.discount.prices && (
        <p className="mt-1 flex flex-wrap gap-x-3 font-cond text-sm font-bold leading-snug">
          {offer.discount.prices.map((p) => (
            <span key={p.size || 'one'} className={`whitespace-nowrap tabular-nums ${dark ? 'text-cream' : 'text-ink'}`}>
              {p.size && <span className="mr-1 text-xs font-semibold opacity-75">{p.size}</span>}
              {formatCents(p.nowCents)}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
