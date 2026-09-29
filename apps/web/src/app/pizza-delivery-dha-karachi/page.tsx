import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { ShowcaseVisual } from '@/components/ShowcaseVisual';
import { DELIVERY_AREAS, feeText } from '@/lib/areas';
import { copyText, type Copy } from '@/lib/delivery-facts';
import {
  PIZZA_CTA,
  PIZZA_DESCRIPTION,
  PIZZA_FAQ_AREAS,
  PIZZA_FAQ_LATE,
  PIZZA_FAQ_PAY,
  PIZZA_INTRO,
  PIZZA_PAGE_DESCRIPTION,
  WA_PIZZA,
} from '@/lib/page-copy';
import { JsonLd, webPageNode } from '@/lib/seo';
import { getCopyFacts } from '@/lib/site-facts';

/**
 * Static, refreshed from the owner's delivery settings (lib/site-facts): at
 * build, whenever a till publishes (api/bridge/menu revalidates), and at
 * least hourly. force-static keeps the settings read (a no-store fetch) from
 * turning the page dynamic.
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

/** The description names the closing time (the owner's hours). The title says "Cash on Delivery": cash is always taken. */
export async function generateMetadata(): Promise<Metadata> {
  const facts = await getCopyFacts();
  return {
    title: 'Pizza Delivery in DHA Karachi — Medium & Large, Cash on Delivery',
    description: copyText(PIZZA_DESCRIPTION, facts),
    alternates: { canonical: '/pizza-delivery-dha-karachi' },
  };
}

/** A card of the "why" row: its words as page copy (a price is a {price:…} token, sweep B2). */
interface WhyCard {
  img: string | null;
  alt: string;
  fallback: { big: Copy; small: Copy };
  title: string;
  body: Copy;
}

const WHY: WhyCard[] = [
  {
    img: '/images/menu/cheesy-star.webp',
    alt: 'Cheesy Star signature pizza, cut like a star',
    fallback: { big: 'Signature', small: 'Large 12"' },
    title: 'Signature pizzas',
    body: 'Shawarma Pizza, Crown Crust, Cheesy Star, Meat Lovers and Cheetos — the house specials, all Large 12". The Cheesy Star is cut like a star and comes with a Sriracha mayo dip.',
  },
  {
    img: null,
    alt: 'Regular pizzas in Medium 9" and Large 12"',
    fallback: { big: '9" · 12"', small: 'Medium · Large' },
    title: 'Regular pizzas, two sizes',
    body: 'Fajita, Classic Supreme, Malai Supreme, Chicken Tikka, Chicken Tikka Malai, Cheesalious, Veggie Lovers (any five veggies) and Classic Pepperoni — each in Medium 9" or Large 12".',
  },
  {
    img: null,
    alt: 'Value deals with a 1 litre soft drink',
    // The cheapest of the three deals, at the menu's price; the menu unknown or the deals gone: no price.
    fallback: {
      big: { text: 'From {price:deals}', when: { priced: 'deals' }, otherwise: 'Value deals' },
      small: { text: 'Value deals · 1 litre soft drink', when: { priced: 'deals' }, otherwise: '1 litre soft drink' },
    },
    title: 'Value deals',
    body: 'Big Two (2 Large), Family Feast (1 Medium + 1 Large) and Perfect Pair (2 Medium) — regular-menu pizzas with a 1 litre soft drink, for less than ordering them one by one.',
  },
];

/** The dips' one price from the menu; at more than one price (or unknown), no number. */
const FAQ_CUSTOMIZE: Copy = {
  text: 'Regular pizzas come in Medium 9" or Large 12" (Signature pizzas are Large 12"), Veggie Lovers takes any five veggies you choose, and dips are {price:dip} each. For anything else, ask us on WhatsApp.',
  when: { priced: 'dip' },
  otherwise:
    'Regular pizzas come in Medium 9" or Large 12" (Signature pizzas are Large 12"), Veggie Lovers takes any five veggies you choose, and dips cost extra. For anything else, ask us on WhatsApp.',
};

const FAQS = [
  {
    q: 'How much is pizza delivery in DHA and Clifton?',
    a: PIZZA_FAQ_AREAS,
  },
  {
    q: 'Do you deliver pizza late at night?',
    a: PIZZA_FAQ_LATE,
  },
  {
    q: 'How do I pay for my pizza?',
    a: PIZZA_FAQ_PAY,
  },
  {
    q: 'Can I customize my pizza?',
    a: FAQ_CUSTOMIZE,
  },
];

export default async function PizzaDeliveryPage() {
  const facts = await getCopyFacts();
  const faqs = FAQS.map((f) => ({ q: f.q, a: copyText(f.a, facts) }));
  const why = WHY.map((w) => ({
    ...w,
    fallback: { big: copyText(w.fallback.big, facts), small: copyText(w.fallback.small, facts) },
    body: copyText(w.body, facts),
  }));
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-4 pt-12">
          <nav aria-label="Breadcrumb" className="text-sm text-smoke">
            <Link href="/" className="hover:text-cheese">
              Home
            </Link>{' '}
            / <span className="text-cream/80">Pizza delivery DHA Karachi</span>
          </nav>
          <h1 className="mt-4 font-display text-4xl leading-[0.95] tracking-wide text-cream md:text-6xl">
            PIZZA DELIVERY IN DHA KARACHI — FIRED TO ORDER
          </h1>
          <p className="mt-5 leading-relaxed text-cream/80">{copyText(PIZZA_INTRO, facts)}</p>
          <p className="mt-4 leading-relaxed text-cream/80">
            No app downloads, no online payments: the box goes from the oven
            to the rider and is opened by you. If a pizza ever arrives in a
            state we would not serve, message us on WhatsApp.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/menu"
              className="rounded-full bg-cheese px-8 py-3.5 font-display text-xl tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
            >
              SEE PIZZAS &amp; PRICES →
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-12">
          <div className="grid gap-5 md:grid-cols-3">
            {why.map((w, i) => (
              <Reveal key={w.title} delay={i * 80}>
                <div className="h-full overflow-hidden rounded-2xl border border-white/10 bg-night-card">
                  <ShowcaseVisual img={w.img} alt={w.alt} fallback={w.fallback} />
                  <div className="p-5">
                    <h2 className="text-lg font-bold text-cream">{w.title}</h2>
                    <p className="mt-1 text-sm leading-relaxed text-smoke">{w.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 py-8">
          <Reveal>
            <h2 className="font-display text-3xl tracking-wide text-cream">
              PIZZA DELIVERY AREAS
            </h2>
            <p className="mt-3 text-smoke">
              Delivery fees from the Phase 6 kitchen — tap your area for
              covered streets and local FAQs.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {DELIVERY_AREAS.map((a) => (
                <Link
                  key={a.slug}
                  href={`/delivery/${a.slug}`}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-cream/80 transition-colors hover:border-cheese/60 hover:text-cheese"
                >
                  {a.name} · {feeText(a, facts)}
                </Link>
              ))}
            </div>
          </Reveal>

          <Reveal>
            <div className="mt-12">
              <h2 className="font-display text-3xl tracking-wide text-cream">
                PIZZA DELIVERY FAQS
              </h2>
              <div className="mt-4 space-y-3">
                {faqs.map((f) => (
                  <details
                    key={f.q}
                    className="group rounded-2xl border border-white/10 bg-night-card open:border-cheese/40"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-bold text-cream [&::-webkit-details-marker]:hidden">
                      {f.q}
                      <span className="text-cheese transition-transform group-open:rotate-45">+</span>
                    </summary>
                    <p className="px-5 pb-5 text-sm leading-relaxed text-smoke">{f.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </Reveal>
        </section>

        <OrderCtaBand heading={copyText(PIZZA_CTA, facts).toUpperCase()} waMessage={copyText(WA_PIZZA, facts)} />
      </main>
      <SiteFooter />
      <WhatsAppFab />
      <JsonLd
        nodes={webPageNode({
          path: '/pizza-delivery-dha-karachi',
          name: 'Pizza Delivery in DHA Karachi',
          description: copyText(PIZZA_PAGE_DESCRIPTION, facts),
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Pizza delivery DHA Karachi', path: '/pizza-delivery-dha-karachi' },
          ],
        })}
      />
    </>
  );
}
