import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { HeroOffers } from '@/components/HeroOffers';
import { HomeOrderBar } from '@/components/HomeOrderBar';
import { OpenNow } from '@/components/OpenNow';
import { PizzaClock } from '@/components/PizzaClock';
import { TodaysDeals } from '@/components/TodaysDeals';
import { PromiseIcon } from '@/components/PromiseIcon';
import { ShopMapCard } from '@/components/ShopMapCard';
import { BUSINESS } from '@/lib/business';
import { DELIVERY_AREAS, feeText } from '@/lib/areas';
import { copyText, feeSummary, renderCopy, shopOf } from '@/lib/delivery-facts';
import { formatCents } from '@/lib/format';
import {
  BURGER_PROMISE,
  HOME_DELIVERY_HEADING,
  HOME_DELIVERY_NOTE,
  HOME_FAQ_AREAS,
  HOME_FAQ_CROWN_CRUST,
  HOME_FAQ_HOURS,
  HOME_FAQ_PAY,
  HOME_FAQ_WHATSAPP,
  HOME_FAQ_ZINGER,
  HOME_FINAL_HEADING,
  HOME_HERO_FEE,
  HOME_HERO_HEADING,
  HOME_HERO_TEXT,
  HOME_HERO_TIME,
  HOME_MAP_TITLE,
  PIZZA_PROMISE,
  PIZZA_PROMISE_KICKER,
} from '@/lib/page-copy';
import { lineOrderUrl, nameIsDefault, orderWhatsappUrl, shopHoursLine, shopNameProse, whatsappLinesOf } from '@/lib/shop-facts';
import { getCopyFacts, getHomeView, requireStoredFacts } from '@/lib/site-facts';
import { dealSaveCents, dealsAreTodays, homeDishes } from '@/lib/home-lineup';
import { menuImageSrcSet } from '@/lib/images';
import { PICKUP_ONLY_WORDS } from '@/lib/menu-view';

/**
 * Static, refreshed from the owner's delivery settings (lib/site-facts): at
 * build, whenever a till publishes (api/bridge/menu revalidates), and at
 * least hourly. force-static keeps the settings read (a no-store fetch) from
 * turning the page dynamic. The owner's announcement (v0.7.30, off = none)
 * comes with the same read and the same refresh: page text in the hero
 * only — never the title, a meta tag or the JSON-LD.
 *
 * The featured pizzas, burger and value deals (sweep B2) are the owner's
 * lineup (Settings → Home page; today's with none saved) found on the
 * published menu, with ITS prices and deal worth — the same read, the same
 * refresh: a Publish moves them. One not on the menu is hidden, never shown
 * at a zero price; with the menu unknown (no database) they show without prices.
 *
 * The page as one story (3 Nov 2026, the user: "think like a brand strategist … structure, grids, art and
 * conversion"): what they came for and the Order button, the deals, why it tastes different (the owner's own brand
 * lines on the shop's own photos), the signatures, what delivery costs where, the questions, and the logo's last word.
 * Every section sits on the same 12-column grid (max-w-6xl, 16px side margins on a phone) and the same rhythm (64px
 * a phone, 96px wide); ink, paper and the printed menu's yellow take turns. Each fact is said where it decides
 * something — the hours in the status line and the sign-off, the fees in the delivery table — not in every section.
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

const FAQS = [
  {
    q: 'Which areas do you deliver to?',
    a: HOME_FAQ_AREAS,
  },
  {
    q: 'What are your hours?',
    a: HOME_FAQ_HOURS,
  },
  {
    q: 'How do I pay?',
    a: HOME_FAQ_PAY,
  },
  {
    q: 'What sizes do the pizzas come in?',
    a: 'Regular pizzas such as Chicken Tikka, Fajita and Classic Pepperoni come in Medium 9" and Large 12". The five signature pizzas are Large 12".',
  },
  // Two dishes people search for (Oct 2026: "crown crust pizza", "zinger burger"): each question shows only
  // while its dish is on the menu (page-copy { onMenu }).
  {
    q: 'Do you have Crown Crust pizza?',
    a: HOME_FAQ_CROWN_CRUST,
  },
  {
    q: 'Do you have a zinger burger?',
    a: HOME_FAQ_ZINGER,
  },
  {
    q: 'Can I order on WhatsApp instead?',
    a: HOME_FAQ_WHATSAPP,
  },
];

/** A section's heading, the same size and rhythm everywhere on the page. */
const H2 = 'font-display text-[clamp(2.4rem,7vw,4.25rem)] uppercase leading-[0.95] tracking-wide';

function WhatsAppGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.8-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2l-.4-.4Z" />
    </svg>
  );
}

/** The gold tick before each of the hero's facts. */
function CheckGlyph() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="h-5 w-5 shrink-0 text-cheese" fill="currentColor">
      <path d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm4.1 6.4-4.9 5.3a.9.9 0 0 1-1.3 0L5.9 11a.9.9 0 1 1 1.3-1.3l1.3 1.4 4.3-4.6a.9.9 0 0 1 1.3 1.3Z" />
    </svg>
  );
}

export default async function HomePage() {
  await requireStoredFacts();
  const [facts, view] = await Promise.all([getCopyFacts(), getHomeView()]);
  const shop = shopOf(facts);
  const dishes = homeDishes(view);
  // The deals section's two fixed lines are today's three deals' facts (a drink in each, regular pizzas).
  const todaysDeals = dealsAreTodays(view);
  // A question whose answer can't print (its dish is off the menu) is left out.
  const faqs = FAQS.flatMap((f) => {
    const a = renderCopy(f.a, facts);
    return a === null ? [] : [{ q: f.q, a }];
  });
  const { announcement } = facts;
  const deliveryTime = renderCopy(HOME_HERO_TIME, facts);
  return (
    <>
      <SiteHeader />
      <main>
        {/* ============================== HERO ============================== */}
        {/* One screen, everything that decides an order (3 Nov 2026, the user: "logo on hero … show every thing in
            hero in a compact artistic design and conversion way"; Google brought half the week's visits and both its
            orders, for "pizza / burger delivery in DHA"): the time in Karachi and whether the kitchen is taking
            orders, the logo's cheese clock made real (PizzaClock), "It's always" over the logo, what they searched
            for, the facts, Order now with WhatsApp beside it, and every offer one tap away. Every line starts on the
            same left edge (the user, 3 Nov 2026: centred, "those are not looking good"): a phone sets the logo beside
            the clock, then the words full width; a wide screen sets the clock beside all of them. */}
        <section className="relative overflow-hidden bg-ink">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,rgba(245,179,1,0.13),transparent_58%)] md:bg-[radial-gradient(ellipse_at_74%_46%,rgba(245,179,1,0.15),transparent_55%)]"
          />
          <div className="relative mx-auto grid max-w-6xl grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] items-center gap-x-3 px-4 pb-10 pt-5 [grid-template-areas:'status_status'_'brand_art'_'head_head'_'facts_facts'_'cta_cta'_'offers_offers'] md:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] md:gap-x-14 md:pb-16 md:pt-12 md:[grid-template-areas:'status_art'_'brand_art'_'head_art'_'facts_art'_'cta_art'_'offers_art']">
            <OpenNow className="font-cond text-[0.8rem] font-bold uppercase tracking-wide text-cream/80 [grid-area:status] sm:text-base" />
            <PizzaClock className="mt-6 w-full justify-self-end [grid-area:art] md:mt-0 md:max-w-[29rem]" />
            {/* The brand line beside the art (a phone) or over the words (wide): "It's always" over the script logo
                (partner, 27 Sep 2026: it never outweighs the name). Under another name: the name alone (the logo
                drawing until it is redrawn). */}
            <p className="relative z-10 mt-6 flex flex-col items-start [grid-area:brand] md:mt-5 md:self-end">
              {nameIsDefault(shop) && (
                <span className="font-display text-[clamp(1.1rem,4.8vw,2.1rem)] uppercase leading-none tracking-[0.05em] text-cream">
                  It&rsquo;s always
                </span>
              )}
              <span className="sr-only">{`${shopNameProse(shop)}.`}</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo-wordmark.svg"
                alt=""
                aria-hidden
                width={642}
                height={308}
                decoding="async"
                className="mt-1.5 block h-auto w-full max-w-[12rem] drop-shadow-[0_8px_28px_rgba(245,179,1,0.22)] md:w-[24rem] md:max-w-none"
              />
            </p>
            <h1 className="mt-6 max-w-[16ch] font-display text-[clamp(2.2rem,10vw,3.1rem)] uppercase leading-[0.92] tracking-wide text-cream [grid-area:head] md:mt-4">
              {copyText(HOME_HERO_HEADING, facts)}
            </h1>
            <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 font-cond text-base font-semibold leading-snug text-cream/85 [grid-area:facts] sm:text-lg">
              {[deliveryTime, copyText(HOME_HERO_FEE, facts), 'Cash on delivery']
                .filter((w): w is string => w !== null)
                .map((w) => (
                  <li key={w} className="flex items-center gap-1.5">
                    <CheckGlyph />
                    {w}
                  </li>
                ))}
            </ul>
            <div className="mt-5 flex w-full max-w-md flex-col items-stretch gap-3 [grid-area:cta]">
              {announcement && (
                <p className="flex items-start gap-2 rounded-2xl border border-cheese/50 bg-cheese/10 px-4 py-2.5 font-cond text-lg font-bold leading-snug text-cheese">
                  <span aria-hidden>★</span>
                  <span>{announcement}</span>
                </p>
              )}
              <div className="flex gap-3">
                <Link
                  id="hero-order"
                  href="/menu"
                  className="flex-1 rounded-full bg-cheese px-8 py-4 text-center font-display text-[1.75rem] uppercase leading-none tracking-wide text-ink shadow-glow transition-colors hover:bg-cheese-hot active:scale-[0.98]"
                >
                  Order now
                </Link>
                <a
                  href={orderWhatsappUrl(shop)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Order on WhatsApp"
                  className="grid h-[3.75rem] w-[3.75rem] shrink-0 place-items-center rounded-full bg-[#25D366] text-white transition-transform hover:scale-105 active:scale-95"
                >
                  <WhatsAppGlyph className="h-7 w-7" />
                </a>
              </div>
            </div>
            {/* Every offer the slider below shows, in a line: one tap to its place on the menu. */}
            <HeroOffers className="[grid-area:offers]" />
          </div>
        </section>

        {/* ========================== TODAY'S DEALS ========================= */}
        <TodaysDeals heading={`${H2} text-cream`} />

        {/* ========================== VALUE DEALS ========================== */}
        {/* The owner's featured deals (Settings → Home page), when set. No featured deal on the menu: no section. */}
        {view.deals.length > 0 && (
          <section id="deals" className="bg-cheese text-ink">
            <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
              <div className="flex flex-wrap items-end justify-between gap-4 border-b-[3px] border-ink pb-3">
                <div>
                  {todaysDeals && <p className="font-cond text-lg font-bold leading-snug">Every deal comes with a 1 litre soft drink</p>}
                  <h2 className={`mt-1 ${H2}`}>Value deals</h2>
                </div>
                {todaysDeals && <p className="max-w-xs font-cond text-lg font-bold leading-snug">Choice of pizzas only from the regular menu.</p>}
              </div>
              <div className="mt-8 grid gap-4 md:grid-cols-3">
                {view.deals.map((d) => {
                  // The saving and the struck-through worth only when the deal is worth more than it costs.
                  const save = dealSaveCents(d);
                  return (
                    <Link
                      key={d.key}
                      href="/menu#value-deals"
                      className="group relative flex h-full flex-col overflow-hidden rounded-[28px] bg-ink p-6 text-cream transition-transform hover:-translate-y-1"
                    >
                      {save !== null && (
                        <span className="absolute right-4 top-4 -rotate-6 rounded-xl bg-cheese px-2.5 py-1.5 text-center font-cond font-extrabold uppercase leading-none text-ink">
                          <span className="block text-[0.65rem] tracking-widest">Save</span>
                          <span className="mt-0.5 block text-lg">{formatCents(save)}</span>
                        </span>
                      )}
                      <span className="block pr-20 font-display text-4xl uppercase leading-none tracking-wide">{d.name}</span>
                      {d.what && <span className="mt-3 block text-lg leading-snug text-cream/75">{d.what}</span>}
                      {/* A deal the till set "Pick-up only": /menu's words, never shown as delivered. */}
                      {d.pickupOnly && (
                        <span className="mt-3 block w-fit rounded-full border-2 border-dashed border-cream/30 px-3 py-1 font-cond text-xs font-bold uppercase tracking-wide text-cream/70">
                          {PICKUP_ONLY_WORDS}
                        </span>
                      )}
                      <span className="relative mt-auto flex items-end justify-between gap-3 pt-6">
                        <span>
                          {save !== null && d.worthCents !== null && (
                            <span className="block text-sm text-cream/45 line-through">{formatCents(d.worthCents)}</span>
                          )}
                          {d.priceCents !== null && (
                            <span className="block font-display text-4xl tracking-wide text-cheese">{formatCents(d.priceCents)}</span>
                          )}
                        </span>
                        <span className="rounded-full bg-cheese px-4 py-2 font-cond text-base font-extrabold uppercase tracking-wide text-ink transition-colors group-hover:bg-cheese-hot">
                          Order
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* ============================ THE PROMISE ========================== */}
        {/* The brand's edge in the owner's own words (24 Oct 2026, final: the pizza's three lines, the burgers' one —
            "everywhere, always in a premium style"), on the shop's own close-ups, under the owner's tagline. */}
        <section className="bg-paper text-ink">
          <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
            <div className="max-w-3xl">
              <h2 className={H2}>{shop.profile.tagline ?? 'Made to order in DHA Phase 6'}</h2>
              <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink/70">{copyText(HOME_HERO_TEXT, facts)}</p>
            </div>
            <div className="mt-10 grid gap-5 md:grid-cols-12">
              <article className="flex flex-col overflow-hidden rounded-[28px] bg-ink text-cream md:col-span-7">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/promise/pizza-crust.webp"
                  srcSet="/images/promise/sm/pizza-crust.webp 480w, /images/promise/pizza-crust.webp 960w"
                  sizes="(min-width: 1152px) 640px, (min-width: 768px) 56vw, 92vw"
                  alt="A pizza on a wooden board, its golden crust up close"
                  width={960}
                  height={540}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[16/9] w-full object-cover"
                />
                <div className="flex-1 p-6 md:p-8">
                  <h3 className="font-display text-3xl uppercase leading-none tracking-wide text-cheese">{PIZZA_PROMISE_KICKER}</h3>
                  <ul className="mt-5 space-y-4">
                    {PIZZA_PROMISE.map((p) => (
                      <li key={p.title} className="flex items-center gap-4">
                        <PromiseIcon kind={p.icon} />
                        <span className="min-w-0">
                          <span className="block font-display text-[1.6rem] uppercase leading-none tracking-wide md:text-[1.85rem]">{p.title}</span>
                          <span className="mt-1 block text-base italic text-cream/70">{p.line}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
              <article className="relative flex min-h-[22rem] flex-col justify-end overflow-hidden rounded-[28px] bg-ink text-cream md:col-span-5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/promise/burger-brioche.webp"
                  srcSet="/images/promise/sm/burger-brioche.webp 480w, /images/promise/burger-brioche.webp 843w"
                  sizes="(min-width: 1152px) 460px, (min-width: 768px) 40vw, 92vw"
                  alt="A crispy chicken burger with melted cheese in a brioche bun, up close"
                  width={843}
                  height={474}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink via-ink/40 to-transparent" />
                <div className="relative p-6 md:p-8">
                  <h3 className="font-display text-[2rem] uppercase leading-none tracking-wide md:text-4xl">{BURGER_PROMISE.title}</h3>
                  <p className="mt-2 text-lg italic text-cheese">{BURGER_PROMISE.line}</p>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* ======================== THE SIGNATURES ========================= */}
        {/* The owner's lineup (Settings → Home page) with the menu's prices: a row to swipe on a phone, a grid on a
            wide screen. No featured pizza or burger on the menu: no section. */}
        {dishes.length > 0 && (
          <section className="bg-ink text-cream">
            <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                <div>
                  <h2 className={H2}>The signatures</h2>
                  <p className="mt-3 text-lg text-cream/65">Our own recipes, made when your order comes in.</p>
                </div>
                <Link
                  href="/menu"
                  className="font-cond text-lg font-bold uppercase tracking-wide text-cheese underline decoration-cheese/40 decoration-2 underline-offset-4 hover:decoration-cheese"
                >
                  Full menu &amp; prices
                </Link>
              </div>
              <ul className="scrollbar-hide -mx-4 mt-8 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-3 lg:gap-5 lg:overflow-visible lg:px-0">
                {dishes.map((item) => (
                  <li key={item.key} className="w-[80%] shrink-0 snap-start sm:w-[46%] lg:w-auto">
                    <Link
                      href={item.href}
                      className="group flex h-full flex-col overflow-hidden rounded-[28px] bg-night-card ring-1 ring-inset ring-cream/10 transition-colors hover:ring-cheese/50"
                    >
                      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-[radial-gradient(circle_at_50%_58%,rgba(245,179,1,0.3),transparent_66%)]">
                        {item.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.image}
                            srcSet={menuImageSrcSet(item.image)}
                            sizes="(min-width: 1024px) 340px, (min-width: 640px) 44vw, 78vw"
                            alt={`${item.name} from ${shop.profile.name}`}
                            width={720}
                            height={720}
                            loading="lazy"
                            decoding="async"
                            className={
                              item.shopPhoto
                                ? 'w-[74%] drop-shadow-[0_22px_26px_rgba(0,0,0,0.55)] transition-transform duration-700 group-hover:rotate-[14deg]'
                                : 'aspect-square w-[62%] rounded-full object-cover'
                            }
                          />
                        ) : (
                          // No photo: the name on the gold glow (never a stock picture).
                          <span aria-hidden className="px-6 text-center font-display text-5xl uppercase leading-none tracking-wide text-cheese">
                            {item.name}
                          </span>
                        )}
                        {item.priceCents !== null && (
                          <span className="absolute left-4 top-4 rounded-full bg-cheese px-3 py-1 font-cond text-base font-extrabold text-ink">
                            {formatCents(item.priceCents)}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-1 flex-col p-5">
                        <p className="font-cond text-sm font-bold uppercase tracking-wide text-cheese">{item.label}</p>
                        <h3 className="mt-1 font-display text-3xl uppercase leading-none tracking-wide">{item.name}</h3>
                        {/* An item the till set "Pick-up only": /menu's words, never shown as delivered. */}
                        {item.pickupOnly && (
                          <p className="mt-2 w-fit rounded-full border-2 border-dashed border-cream/30 px-3 py-1 font-cond text-xs font-bold uppercase tracking-wide text-cream/70">
                            {PICKUP_ONLY_WORDS}
                          </p>
                        )}
                        {item.description && <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-cream/65">{item.description}</p>}
                        <span className="mt-auto pt-4 font-cond text-base font-bold uppercase tracking-wide text-cheese">Order it</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {/* ============================ DELIVERY =========================== */}
        {/* The printed deal menu's yellow: what a delivery costs, area by area, how long it takes, every area's own
            page, and where the kitchen is. */}
        <section id="delivery" className="bg-cheese text-ink">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 md:grid-cols-12 md:gap-x-10 md:py-24">
            <div className="md:col-span-7">
              <h2 className={`max-w-[16ch] ${H2}`}>{copyText(HOME_DELIVERY_HEADING, facts)}</h2>
              <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink/80">{copyText(HOME_DELIVERY_NOTE, facts)}</p>
              <dl className="mt-8 border-t-[3px] border-ink">
                {feeSummary(facts).map((f) => (
                  <div key={f.feeCents} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 border-b-2 border-ink/25 py-4 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
                    <dt className="whitespace-nowrap font-display text-[2rem] tracking-wide sm:text-4xl">{formatCents(f.feeCents)}</dt>
                    {/* The places break between areas, never inside one ("Clifton Blocks 3–9" stays whole). */}
                    <dd className="font-cond text-base font-bold uppercase leading-snug sm:text-lg">
                      {f.places.split(' · ').map((place, k) => (
                        <span key={place}>
                          {k > 0 && ' · '}
                          <span className="whitespace-nowrap">{place}</span>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
              {deliveryTime && <p className="mt-5 font-cond text-xl font-bold">{deliveryTime} · Cash on delivery</p>}
              <nav aria-label="Delivery areas" className="mt-6 flex flex-wrap gap-2">
                {DELIVERY_AREAS.map((area) => (
                  <Link
                    key={area.slug}
                    href={`/delivery/${area.slug}`}
                    title={`${area.name}: ${feeText(area, facts)}`}
                    className="rounded-full border-2 border-ink/80 px-3.5 py-1.5 font-cond text-sm font-bold uppercase tracking-wide transition-colors hover:bg-ink hover:text-cheese sm:text-base"
                  >
                    {area.name}
                  </Link>
                ))}
              </nav>
            </div>
            <div className="md:col-span-5">
              <ShopMapCard title={copyText(HOME_MAP_TITLE, facts)} heightClass="h-[380px]" className="rounded-[28px]" />
              <address className="mt-3 text-center text-sm not-italic text-ink/75">
                {shop.profile.address.street}, {BUSINESS.locality} · {shopHoursLine(shop)}
              </address>
            </div>
          </div>
        </section>

        {/* =============================== FAQ ============================= */}
        <section className="bg-paper text-ink">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:grid-cols-12 md:gap-x-10 md:py-24">
            <div className="md:col-span-4">
              <h2 className={H2}>Questions, answered</h2>
              <p className="mt-4 text-lg leading-relaxed text-ink/70">
                Anything else?{' '}
                <a
                  href={orderWhatsappUrl(shop)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-ink underline decoration-cheese decoration-[3px] underline-offset-4"
                >
                  Ask us on WhatsApp
                </a>
                .
              </p>
            </div>
            <div className="border-t-[3px] border-ink md:col-span-8">
              {faqs.map((f) => (
                <details key={f.q} className="group border-b-2 border-ink/15">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-cond text-xl font-bold uppercase tracking-wide [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span aria-hidden className="text-2xl text-cheese-deep transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="pb-5 leading-relaxed text-ink/75">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ SIGN-OFF =========================== */}
        {/* The brand's last word, and the last Order button: "Hungry? It's {nameProse}." (another name: "Hungry?
            Order now."). The logo itself is in the header and the hero already. */}
        <section className="relative overflow-hidden bg-night">
          <div aria-hidden className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_30%,rgba(245,179,1,0.18),transparent_60%)]" />
          <div className="relative mx-auto flex max-w-6xl flex-col items-center px-4 py-20 text-center md:py-28">
            <h2 className="max-w-[14ch] font-display text-[clamp(2.6rem,8vw,5.25rem)] uppercase leading-[0.92] tracking-wide text-cream">
              {copyText(HOME_FINAL_HEADING, facts)}
            </h2>
            <div className="mt-10 grid w-full max-w-md gap-3 sm:flex sm:max-w-none sm:justify-center">
              <Link
                href="/menu"
                className="rounded-full bg-cheese px-10 py-4 text-center font-display text-3xl uppercase tracking-wide text-ink shadow-glow transition-colors hover:bg-cheese-hot active:scale-[0.98]"
              >
                Order now
              </Link>
              {whatsappLinesOf(shop).map((l) => (
                <a
                  key={l.url}
                  href={lineOrderUrl(shop, l)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 rounded-full border border-cream/25 px-7 py-4 font-cond text-lg font-bold uppercase tracking-wide text-cream transition-colors hover:border-cheese hover:text-cheese active:scale-[0.98]"
                >
                  <WhatsAppGlyph className="h-5 w-5" /> {l.display}
                </a>
              ))}
            </div>
            <p className="mt-6 font-cond text-base font-bold uppercase tracking-wide text-cream/60">{shopHoursLine(shop)}</p>
          </div>
        </section>
      </main>
      <SiteFooter />
      {/* A phone: the order bar (below) has the floating WhatsApp button's corner, and room under the footer. */}
      <div aria-hidden className="h-20 bg-night md:hidden" />
      <WhatsAppFab className="max-md:hidden" />
      <HomeOrderBar watch="hero-order" label="Order now" whatsappUrl={orderWhatsappUrl(shop)} />
    </>
  );
}
