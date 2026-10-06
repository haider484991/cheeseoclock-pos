import { formatCents } from '@/lib/format';
import {
  OFFER_FINE_PRINT,
  OFFER_HEADLINE,
  OFFER_RULES,
  OFFER_TAG_LINE,
  OFFER_WINDOW,
  type CardOffer,
} from '@/lib/offers';

/**
 * The menu's offers, set in the page's own colours (lib/offers has the words and the rules; nothing here
 * prices anything). Two pieces: the banner under the menu's title, and the small strip on each card.
 */

/** "Buy 1 Large pizza → any burger…": the rule's two halves, the buy half with that pizza's menu price when the menu has it. */
function ruleParts(rule: string, prices: { mediumCents: number | null; largeCents: number | null }): [string, string] {
  const [buy = rule, get = ''] = rule.split(' → ');
  const price = /Large pizza/.test(buy) ? prices.largeCents : /Medium pizza/.test(buy) ? prices.mediumCents : null;
  return [price === null ? buy : `${buy} (${formatCents(price)})`, get];
}

/**
 * Under the menu's title: Buy 1 Get 1 FREE, its hours, where it counts, the two rules, how the free item is
 * earned, and — in solid gold, as prominent as the poster has it — that delivery charges and tax may apply.
 */
export function OfferBanner({
  prices,
  where,
}: {
  prices: { mediumCents: number | null; largeCents: number | null };
  /** Where and when it counts, in the shop's words (page-copy MENU_OFFER_WHERE: "every day" only while open daily). */
  where: string;
}) {
  return (
    <section
      aria-label={`${OFFER_HEADLINE}, ${OFFER_WINDOW}`}
      className="mt-5 max-w-3xl rounded-2xl border-2 border-cheese bg-cheese/10 p-4 md:p-5"
    >
      <p className="font-display text-3xl uppercase leading-none tracking-wide text-cheese md:text-4xl">
        {OFFER_HEADLINE} <span className="whitespace-nowrap">· {OFFER_WINDOW}</span>
      </p>
      <p className="mt-1.5 font-cond text-sm font-bold uppercase tracking-[0.1em] text-cream md:text-base md:tracking-[0.16em]">{where}</p>
      <ul className="mt-3 space-y-1.5 text-[0.95rem] leading-snug text-cream/90">
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
      <p className="mt-3 inline-block rounded-lg bg-cheese px-3 py-2 font-cond text-base font-extrabold uppercase tracking-wide text-ink">
        {OFFER_FINE_PRINT}
      </p>
    </section>
  );
}

/** On a card: the Buy 1 Get 1 strip (what this item earns or is), then the % off and what each size comes to. */
export function OfferStrip({ offer, dark = false }: { offer: CardOffer; dark?: boolean }) {
  if (!offer.bogo && !offer.discount) return null;
  return (
    <div className="mt-3 space-y-1.5">
      {offer.bogo && (
        <p className={`rounded-xl px-3 py-2 ${dark ? 'bg-cheese text-ink' : 'bg-ink text-cheese'}`}>
          <span className="block font-cond text-[0.8rem] font-extrabold uppercase tracking-[0.14em]">{offer.bogo.title}</span>
          <span className={`block text-sm font-semibold leading-snug ${dark ? 'text-ink' : 'text-cream'}`}>{offer.bogo.detail}</span>
        </p>
      )}
      {offer.discount && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-cond text-sm font-bold leading-snug">
          <span className="rounded-full bg-cheese px-2 py-0.5 text-xs font-extrabold uppercase tracking-wide text-ink">
            {offer.discount.label}
          </span>
          {offer.discount.prices?.map((p) => (
            <span key={p.size || 'one'} className={`whitespace-nowrap tabular-nums ${dark ? 'text-cream' : 'text-ink'}`}>
              {p.size && <span className="mr-1 text-xs font-semibold opacity-75">{p.size}</span>}
              <s className={`mr-1 font-semibold ${dark ? 'text-cream/50' : 'text-ink-muted'}`}>{formatCents(p.wasCents)}</s>
              {formatCents(p.nowCents)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
