import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { Marquee } from '@/components/Marquee';
import { Reveal } from '@/components/Reveal';
import { CheeseTime } from '@/components/CheeseTime';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { PizzaCarousel3D } from '@/components/PizzaCarousel3D';
import { ShopMapCard } from '@/components/ShopMapCard';
import { BUSINESS } from '@/lib/business';
import { DELIVERY_AREAS, feeText } from '@/lib/areas';
import { copyText, feeSummary, renderCopy, shopOf, type CopyFacts } from '@/lib/delivery-facts';
import { formatCents } from '@/lib/format';
import {
  HOME_DELIVERY_NOTE,
  HOME_FAQ_AREAS,
  HOME_FAQ_HOURS,
  HOME_FAQ_PAY,
  HOME_FAQ_WHATSAPP,
  HOME_FINAL_HEADING,
  HOME_HERO_FEE,
  HOME_HERO_HOURS,
  HOME_HERO_TEXT,
  HOME_MAP_TITLE,
  HOME_MARQUEE,
  HOME_STAT_DAYS,
  HOME_STAT_FEE,
  HOME_STAT_HOURS,
  HOME_STEP_PAY,
} from '@/lib/page-copy';
import { lineOrderUrl, nameIsDefault, orderWhatsappUrl, shopHoursLine, whatsappLinesOf } from '@/lib/shop-facts';
import { getCopyFacts, getHomeView, requireStoredFacts } from '@/lib/site-facts';
import { dealSaveCents, dealsFromCents, homeDishes } from '@/lib/home-lineup';
import { menuImageSrcSet } from '@/lib/images';

/**
 * The ticker's words: the shop's tagline, then page-copy's (the hours and
 * the name from the owner's settings); the owner's announcement, while on,
 * goes first. Upper-cased, as the ticker has always printed them.
 */
function marqueeItems(facts: CopyFacts): string[] {
  const tagline = shopOf(facts).profile.tagline;
  const words = HOME_MARQUEE.map((c) => renderCopy(c, facts)).filter((w): w is string => w !== null);
  return [...(tagline ? [tagline] : []), ...words].map((w) => w.toUpperCase());
}

/**
 * Static, refreshed from the owner's delivery settings (lib/site-facts): at
 * build, whenever a till publishes (api/bridge/menu revalidates), and at
 * least hourly. force-static keeps the settings read (a no-store fetch) from
 * turning the page dynamic. The owner's announcement (v0.7.30, off = none)
 * comes with the same read and the same refresh: page text in the hero and
 * the ticker only — never the title, a meta tag or the JSON-LD.
 *
 * The featured pizzas, burger and value deals (sweep B2) are the owner's
 * lineup (Settings → Home page; today's with none saved) found on the
 * published menu, with ITS prices and deal worth — the same read, the same
 * refresh: a Publish moves them. One not on the menu is hidden, never shown
 * at a zero price; with the menu unknown (no database) they show without prices.
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

const STEPS = (facts: CopyFacts) => [
  {
    n: '01',
    title: 'Order in under a minute',
    body: 'Pick from the menu here, or send your order on WhatsApp — both land in the same kitchen queue.',
  },
  {
    n: '02',
    title: 'Fired when your ticket prints',
    body: 'Every pizza and burger is made to order in our DHA Phase 6 kitchen and sent out hot.',
  },
  {
    n: '03',
    title: copyText(HOME_STEP_PAY, facts),
    body: 'Follow your order live from kitchen to doorstep, then pay the rider exactly what the printed receipt says.',
  },
];

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
    a: 'Regular pizzas come in Medium 9" and Large 12". The five signature pizzas are Large 12".',
  },
  {
    q: 'Can I order on WhatsApp instead?',
    a: HOME_FAQ_WHATSAPP,
  },
];

function WhatsAppGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.8-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2l-.4-.4Z" />
    </svg>
  );
}

export default async function HomePage() {
  await requireStoredFacts();
  const [facts, view] = await Promise.all([getCopyFacts(), getHomeView()]);
  const shop = shopOf(facts);
  const dishes = homeDishes(view);
  const dealsFrom = dealsFromCents(view);
  const faqs = FAQS.map((f) => ({ q: f.q, a: copyText(f.a, facts) }));
  const { announcement } = facts;
  const marquee = marqueeItems(facts);
  return (
    <>
      <SiteHeader />
      <main>
        {/* ============================== HERO ============================== */}
        <section className="relative overflow-hidden bg-ink">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_72%_45%,rgba(245,179,1,0.16),transparent_58%)]"
          />
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.07] [background-image:repeating-linear-gradient(90deg,#F5B301_0_1px,transparent_1px_90px)]"
          />
          {/* Phones: headline → pizzas → the rest, so the food is above the
              fold. Desktop: text left, pizzas right. */}
          <div className="relative mx-auto grid max-w-6xl gap-x-4 px-4 pb-14 pt-8 [grid-template-areas:'head'_'wheel'_'rest'] md:grid-cols-[0.95fr_1.05fr] md:items-center md:pb-20 md:pt-14 md:[grid-template-areas:'head_wheel'_'rest_wheel']">
            <div className="animate-fade-up [grid-area:head] md:self-end md:pr-4">
              <p className="inline-flex items-center gap-2 rounded-full border border-cheese/40 bg-cheese/10 px-4 py-1.5 font-cond text-sm font-bold uppercase tracking-[0.16em] text-cheese">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                We deliver all over DHA &amp; Clifton
              </p>
              {/* The brand leads (partner, 27 Sep 2026: "it's always" must not
                  outweigh the name): a small "It's always" over the real
                  script wordmark, big. The words stay in the heading for
                  search and screen readers; the drawing is decoration. */}
              {/* The pun is today's name's: under another name the heading says
                  that name in plain words (the logo drawing stays until it is
                  redrawn — the till's Shop details card says so). */}
              <h1 className="mt-5">
                {nameIsDefault(shop) ? (
                  <>
                    <span className="block font-display text-[clamp(2.1rem,5vw,3.6rem)] uppercase leading-none tracking-wide text-cream">
                      It&rsquo;s always
                    </span>
                    <span className="sr-only">Cheese O&rsquo;Clock.</span>
                  </>
                ) : (
                  <span className="sr-only">{shop.profile.name}</span>
                )}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/logo-wordmark.svg"
                  alt=""
                  aria-hidden
                  width={642}
                  height={308}
                  fetchPriority="high"
                  decoding="async"
                  className="mt-3 block h-auto w-[min(88vw,34rem)] drop-shadow-[0_8px_28px_rgba(245,179,1,0.18)] md:mt-4"
                />
              </h1>
            </div>

            <PizzaCarousel3D className="-mt-6 [grid-area:wheel] md:-mr-6 md:mt-0" />

            <div className="animate-fade-up [grid-area:rest] md:self-start md:pr-4">
              {announcement && (
                <p className="mt-6 flex w-fit max-w-md items-start gap-2 rounded-2xl border border-cheese/50 bg-cheese/10 px-4 py-2.5 font-cond text-lg font-bold leading-snug text-cheese md:mt-4">
                  <span aria-hidden>★</span>
                  <span>{announcement}</span>
                </p>
              )}
              {shop.profile.tagline && (
                <p className="mt-6 font-cond text-2xl font-semibold italic text-cream/85 md:mt-4">
                  {shop.profile.tagline}
                </p>
              )}
              <p className="mt-3 max-w-md text-lg leading-relaxed text-cream/65">
                {copyText(HOME_HERO_TEXT, facts)}
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link
                  href="/menu"
                  className="rounded-full bg-cheese px-9 py-4 font-display text-2xl uppercase tracking-wide text-ink shadow-glow transition-all animate-tick-glow hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
                >
                  Order now →
                </Link>
                <a
                  href={orderWhatsappUrl(shop)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-full border border-cream/25 px-6 py-4 font-cond text-lg font-bold uppercase tracking-wide text-cream transition-all hover:border-cheese hover:text-cheese active:scale-95"
                >
                  <WhatsAppGlyph className="h-5 w-5" /> WhatsApp
                </a>
              </div>
              <ul className="mt-6 flex flex-wrap gap-2 font-cond text-sm font-bold uppercase tracking-wide text-cream/80">
                {/* The cheapest deal shown, at the menu's price; no deal shown: no chip. */}
                {dealsFrom !== null ? (
                  <li>
                    <Link
                      href="/menu#value-deals"
                      className="block rounded-full bg-cheese px-3 py-1.5 text-ink transition-colors hover:bg-cheese-hot"
                    >
                      Value deals from {formatCents(dealsFrom)} →
                    </Link>
                  </li>
                ) : view.deals.length > 0 ? (
                  <li>
                    <Link
                      href="/menu#value-deals"
                      className="block rounded-full bg-cheese px-3 py-1.5 text-ink transition-colors hover:bg-cheese-hot"
                    >
                      Value deals →
                    </Link>
                  </li>
                ) : null}
                <li className="rounded-full border border-cream/15 px-3 py-1.5">{copyText(HOME_HERO_FEE, facts)}</li>
                <li className="rounded-full border border-cream/15 px-3 py-1.5">{copyText(HOME_HERO_HOURS, facts)}</li>
                <li className="rounded-full border border-cream/15 px-3 py-1.5">Cash on delivery</li>
              </ul>
              <CheeseTime className="mt-4 text-sm text-cream/55" />
            </div>
          </div>
        </section>

        {/* ============================ MARQUEE ============================ */}
        <Marquee tilted items={announcement ? [announcement, ...marquee] : marquee} />

        {/* ========================== VALUE DEALS ========================== */}
        {/* Straight after the marquee, before the signatures (owner 2026-09-25:
            "deals should be prominent"). No featured deal on the menu: no section. */}
        {view.deals.length > 0 && (
          <section id="deals" className="relative overflow-hidden bg-cheese text-ink">
            <div
              aria-hidden
              className="absolute inset-0 opacity-[0.07] [background-image:repeating-linear-gradient(135deg,#151412_0_2px,transparent_2px_22px)]"
            />
            <div className="relative mx-auto max-w-6xl px-4 py-16 md:py-20">
              <Reveal>
                <div className="flex flex-wrap items-end justify-between gap-4 border-b-[3px] border-ink pb-3">
                  <div>
                    <p className="font-cond text-sm font-extrabold uppercase tracking-[0.24em] text-ink/70">
                      Every deal comes with a 1 litre soft drink
                    </p>
                    <h2 className="mt-1 font-display text-5xl uppercase leading-none tracking-wide md:text-7xl">
                      Value deals
                    </h2>
                  </div>
                  <p className="max-w-xs font-cond text-lg font-bold leading-snug">
                    Choice of pizzas only from the regular menu.
                  </p>
                </div>
              </Reveal>
              <div className="mt-8 grid gap-4 md:grid-cols-3">
                {view.deals.map((d, i) => {
                  // The saving and the struck-through worth only when the deal is worth more than it costs.
                  const save = dealSaveCents(d);
                  return (
                    <Reveal key={d.key} delay={i * 80}>
                      <Link
                        href="/menu#value-deals"
                        className="group relative flex h-full flex-col overflow-hidden rounded-3xl bg-ink p-6 text-cream shadow-soft-lg transition-transform hover:-translate-y-1"
                      >
                        <span
                          aria-hidden
                          className="pointer-events-none absolute -bottom-8 -right-2 select-none font-display text-[9rem] leading-none text-cheese/10"
                        >
                          0{i + 1}
                        </span>
                        {save !== null && (
                          <span className="absolute right-4 top-4 -rotate-6 rounded-xl bg-cheese px-2.5 py-1.5 text-center font-cond font-extrabold uppercase leading-none text-ink">
                            <span className="block text-[0.65rem] tracking-widest">Save</span>
                            <span className="mt-0.5 block text-lg">{formatCents(save)}</span>
                          </span>
                        )}
                        <span className="font-cond text-xs font-bold uppercase tracking-[0.24em] text-cheese">
                          Value deal 0{i + 1}
                        </span>
                        <span className="mt-1 block pr-20 font-display text-4xl uppercase leading-none tracking-wide">
                          {d.name}
                        </span>
                        {d.what && (
                          <span className="mt-3 block font-cond text-lg font-semibold uppercase leading-snug tracking-wide text-cream/75">
                            {d.what}
                          </span>
                        )}
                        <span className="relative mt-auto flex items-end justify-between gap-3 pt-6">
                          <span>
                            {save !== null && d.worthCents !== null && (
                              <span className="block text-sm text-cream/45 line-through">{formatCents(d.worthCents)}</span>
                            )}
                            {d.priceCents !== null && (
                              <span className="block font-display text-4xl tracking-wide text-cheese">
                                {formatCents(d.priceCents)}
                              </span>
                            )}
                          </span>
                          <span className="rounded-full bg-cheese px-4 py-2 font-cond text-base font-extrabold uppercase tracking-wide text-ink transition-colors group-hover:bg-cheese-hot">
                            Order →
                          </span>
                        </span>
                      </Link>
                    </Reveal>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* ======================== THE SIGNATURES ========================= */}
        {/* No featured pizza or burger on the menu: no section. */}
        {dishes.length > 0 && (
          <section className="bg-paper text-ink">
            <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
              <Reveal>
                <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese-deep">
                  From our kitchen, not a stock library
                </p>
                <div className="mt-2 flex flex-wrap items-end justify-between gap-4 border-b-[3px] border-ink pb-3">
                  <h2 className="font-display text-5xl uppercase tracking-wide md:text-6xl">
                    The signatures
                  </h2>
                  <Link
                    href="/menu"
                    className="font-cond text-lg font-bold uppercase tracking-wide text-ink underline decoration-cheese decoration-[3px] underline-offset-4 hover:text-cheese-deep"
                  >
                    Full menu &amp; prices →
                  </Link>
                </div>
              </Reveal>
              <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {dishes.map((item, i) => (
                  <Reveal key={item.key} delay={(i % 3) * 80}>
                    <Link
                      href={item.href}
                      className="group flex h-full flex-col overflow-hidden rounded-3xl bg-ink text-cream shadow-soft-md transition-transform hover:-translate-y-1"
                    >
                      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-[radial-gradient(circle_at_50%_58%,rgba(245,179,1,0.3),transparent_66%)]">
                        {item.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.image}
                            srcSet={menuImageSrcSet(item.image)}
                            sizes="(min-width: 1024px) 290px, (min-width: 640px) 36vw, 72vw"
                            alt={`${item.name} from ${shop.profile.name}`}
                            width={720}
                            height={720}
                            loading="lazy"
                            decoding="async"
                            className={
                              item.shopPhoto
                                ? 'w-[78%] drop-shadow-[0_22px_26px_rgba(0,0,0,0.55)] transition-transform duration-700 group-hover:rotate-[18deg] group-hover:scale-105'
                                : 'aspect-square w-[64%] rounded-full object-cover shadow-soft-lg transition-transform duration-700 group-hover:scale-105'
                            }
                          />
                        ) : (
                          // No photo: the name on the gold glow (never a stock picture).
                          <span
                            aria-hidden
                            className="px-6 text-center font-display text-5xl uppercase leading-none tracking-wide text-cheese"
                          >
                            {item.name}
                          </span>
                        )}
                        {item.priceCents !== null && (
                          <span className="absolute left-4 top-4 rounded-full bg-cheese px-3 py-1 font-cond text-sm font-extrabold text-ink">
                            {formatCents(item.priceCents)}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-1 flex-col p-5">
                        <p className="font-cond text-xs font-bold uppercase tracking-[0.24em] text-cheese">
                          {item.label}
                        </p>
                        <h3 className="mt-1 font-display text-3xl uppercase tracking-wide">{item.name}</h3>
                        {item.description && <p className="mt-2 text-sm leading-relaxed text-cream/65">{item.description}</p>}
                        <p className="mt-auto pt-4 font-cond text-base font-bold uppercase tracking-wide text-cheese">
                          Order it →
                        </p>
                      </div>
                    </Link>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ============================ DELIVERY =========================== */}
        <section className="bg-paper text-ink">
          <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
            <Reveal>
              <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese-deep">
                Delivery
              </p>
              <h2 className="mt-2 max-w-3xl font-display text-5xl uppercase tracking-wide md:text-6xl">
                All over DHA &amp; Clifton
              </h2>
              <p className="mt-4 max-w-2xl leading-relaxed text-ink/70">
                {copyText(HOME_DELIVERY_NOTE, facts)}
              </p>
            </Reveal>
            <div className="mt-10 grid gap-10 lg:grid-cols-[1.15fr_0.85fr]">
              <div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {feeSummary(facts).map((f, i) => (
                    <Reveal key={f.feeCents} delay={i * 60}>
                      <div className="h-full rounded-3xl border-2 border-ink bg-white p-5">
                        <div className="font-display text-5xl tracking-wide">{formatCents(f.feeCents)}</div>
                        <div className="mt-2 font-cond text-lg font-bold uppercase leading-snug">{f.places}</div>
                      </div>
                    </Reveal>
                  ))}
                </div>
                <div className="mt-6 flex flex-wrap gap-2">
                  {DELIVERY_AREAS.map((area) => (
                    <Link
                      key={area.slug}
                      href={`/delivery/${area.slug}`}
                      className="rounded-full border border-ink/15 bg-white px-4 py-2 font-cond text-base font-bold uppercase tracking-wide transition-colors hover:border-ink hover:bg-ink hover:text-cheese"
                    >
                      {area.name} <span className="font-semibold text-ink/50">· {feeText(area, facts)}</span>
                    </Link>
                  ))}
                </div>
              </div>
              <Reveal delay={100}>
                <ShopMapCard
                  title={copyText(HOME_MAP_TITLE, facts)}
                  heightClass="h-[380px]"
                  className="rounded-3xl border-2 border-ink"
                />
                <address className="mt-3 text-center text-sm not-italic text-ink/65">
                  {shop.profile.address.street}, {BUSINESS.locality} · {shopHoursLine(shop)}
                </address>
              </Reveal>
            </div>
          </div>
        </section>

        {/* =========================== HOW IT WORKS ======================== */}
        <section className="bg-ink">
          <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
            <Reveal>
              <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese">
                How it works
              </p>
              <h2 className="mt-2 font-display text-5xl uppercase tracking-wide text-cream md:text-6xl">
                Oven to door in three steps
              </h2>
            </Reveal>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS(facts).map((s, i) => (
                <Reveal key={s.n} delay={i * 80}>
                  <div className="h-full rounded-3xl border border-cream/10 bg-night-card p-6 transition-colors hover:border-cheese/40">
                    <div className="font-display text-5xl text-cheese/40">{s.n}</div>
                    <h3 className="mt-3 font-cond text-2xl font-bold uppercase tracking-wide text-cream">
                      {s.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-cream/60">{s.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal delay={120}>
              <div className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-cream/10 bg-cream/10 sm:grid-cols-3">
                {[
                  [copyText(HOME_STAT_HOURS, facts), copyText(HOME_STAT_DAYS, facts)],
                  [copyText(HOME_STAT_FEE, facts), 'delivery in DHA & Clifton'],
                  ['Cash on delivery', 'pay the rider at your door'],
                ].map(([big, small]) => (
                  <div key={big} className="bg-night-soft px-6 py-8 text-center">
                    <div className="font-display text-4xl uppercase tracking-wide text-cheese">{big}</div>
                    <div className="mt-1 font-cond text-base font-semibold uppercase tracking-wide text-cream/55">
                      {small}
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* =============================== FAQ ============================= */}
        <section className="bg-ink">
          <div className="mx-auto max-w-3xl px-4 pb-20 md:pb-24">
            <Reveal>
              <h2 className="font-display text-5xl uppercase tracking-wide text-cream">
                Questions, answered
              </h2>
            </Reveal>
            <div className="mt-8 space-y-3">
              {faqs.map((f, i) => (
                <Reveal key={f.q} delay={i * 50}>
                  <details className="group rounded-2xl border border-cream/10 bg-night-card open:border-cheese/40">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-cond text-xl font-bold uppercase tracking-wide text-cream [&::-webkit-details-marker]:hidden">
                      {f.q}
                      <span className="text-2xl text-cheese transition-transform group-open:rotate-45">+</span>
                    </summary>
                    <p className="px-5 pb-5 leading-relaxed text-cream/65">{f.a}</p>
                  </details>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ FINAL CTA ========================== */}
        <section className="bg-cheese">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-16 text-center md:py-20">
            <h2 className="font-display text-[clamp(3rem,8vw,6rem)] uppercase leading-[0.92] tracking-wide text-ink">
              {copyText(HOME_FINAL_HEADING, facts)}
            </h2>
            <div className="flex flex-wrap justify-center gap-3">
              <Link
                href="/menu"
                className="rounded-full bg-ink px-9 py-4 font-display text-2xl uppercase tracking-wide text-cheese shadow-soft-lg transition-transform hover:scale-105 active:scale-95"
              >
                Order now →
              </Link>
              {whatsappLinesOf(shop).map((l) => (
                <a
                  key={l.url}
                  href={lineOrderUrl(shop, l)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-full border-2 border-ink/30 px-6 py-4 font-cond text-lg font-bold uppercase tracking-wide text-ink transition-colors hover:border-ink active:scale-95"
                >
                  <WhatsAppGlyph className="h-5 w-5" /> {l.display}
                </a>
              ))}
            </div>
            <p className="font-cond text-base font-bold uppercase tracking-wide text-ink/70">
              {shopHoursLine(shop)} · Cash on delivery across DHA &amp; Clifton
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
      <WhatsAppFab />
    </>
  );
}
