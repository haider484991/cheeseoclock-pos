import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { DELIVERY_AREAS, etaText } from '@/lib/areas';
import { JsonLd, webPageNode } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Burger Delivery in DHA Karachi — Smashed to Order',
  description:
    'Gourmet smash burgers delivered across DHA Phases 1–8, Clifton & Gizri. Smashed when your ticket prints, hot in 30–45 min, cash on delivery, open till 2am.',
  alternates: { canonical: '/burger-delivery-dha-karachi' },
};

const WHY = [
  {
    img: '/images/burger-stack.jpg',
    alt: 'Double smash burger with melting cheese and house sauce',
    title: 'Smashed when you order',
    body: 'Patties hit the hot plate when your ticket prints — not before. The smash gives crispy lace edges and a juicy centre that survives the ride.',
  },
  {
    img: '/images/burger-triple.jpg',
    alt: 'Triple-stack burger with crispy strips on a black background',
    title: 'Stacks for real appetites',
    body: 'Singles, doubles and triple-stacks with proper cheese between every patty. Pick your fighter on the menu and customize the works.',
  },
  {
    img: '/images/fries-loaded.jpg',
    alt: 'Basket of crispy fries with cheese and herbs',
    title: 'Sides that keep up',
    body: 'Loaded fries, sticky wings and thick shakes — built to travel, packed separately so nothing arrives soggy.',
  },
];

const FAQS = [
  {
    q: 'Do smash burgers travel well?',
    a: 'Better than most — the crust from the smash holds heat and texture. We also pack burgers wrapped snug and boxed flat, with sides in their own compartment so steam does not soften anything.',
  },
  {
    q: 'How long does burger delivery take in DHA?',
    a: '20–35 minutes inside Phase 6, where the kitchen lives; 25–45 for the neighbouring phases and Gizri; up to 50 for Clifton and Phase 1 & 2. Track it live after you order.',
  },
  {
    q: 'Can I get a burger deal for a group?',
    a: 'Yes — combos and family deals are on the online menu, and for office or gathering orders you can WhatsApp us; we will suggest the best-value spread for your headcount.',
  },
  {
    q: 'Is payment cash only?',
    a: 'Cash on delivery on every order — no cards or wallets needed. The rider carries change and your printed receipt is the bill.',
  },
];

export default function BurgerDeliveryPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-4 pt-12">
          <nav aria-label="Breadcrumb" className="text-sm text-smoke">
            <Link href="/" className="hover:text-cheese">
              Home
            </Link>{' '}
            / <span className="text-cream/80">Burger delivery DHA Karachi</span>
          </nav>
          <h1 className="mt-4 font-display text-4xl leading-[0.95] tracking-wide text-cream md:text-6xl">
            BURGER DELIVERY IN DHA KARACHI — SMASHED TO ORDER
          </h1>
          <p className="mt-5 leading-relaxed text-cream/80">
            DHA has burger spots on every other street — but most of what gets
            delivered was cooked before you ordered. Ours work the other way:
            the patty hits the plate when your ticket prints in our Phase 6
            kitchen, gets its cheese, sauce and proper bun, and rides out hot
            across DHA, Clifton and Gizri.
          </p>
          <p className="mt-4 leading-relaxed text-cream/80">
            Order online in under a minute or send a WhatsApp — both are cash
            on delivery, every day from noon to 2am.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/menu"
              className="rounded-full bg-cheese px-8 py-3.5 font-display text-xl tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
            >
              SEE BURGERS &amp; PRICES →
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-12">
          <div className="grid gap-5 md:grid-cols-3">
            {WHY.map((w, i) => (
              <Reveal key={w.title} delay={i * 80}>
                <div className="h-full overflow-hidden rounded-2xl border border-white/10 bg-night-card">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={w.img}
                    alt={w.alt}
                    width={1200}
                    height={900}
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover"
                  />
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
              BURGER DELIVERY AREAS
            </h2>
            <p className="mt-3 text-smoke">
              Fired in Phase 6, delivered across the map — tap your area for
              streets covered and honest ETAs.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {DELIVERY_AREAS.map((a) => (
                <Link
                  key={a.slug}
                  href={`/delivery/${a.slug}`}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-cream/80 transition-colors hover:border-cheese/60 hover:text-cheese"
                >
                  {a.name} · {etaText(a)}
                </Link>
              ))}
            </div>
          </Reveal>

          <Reveal>
            <div className="mt-12">
              <h2 className="font-display text-3xl tracking-wide text-cream">
                BURGER DELIVERY FAQS
              </h2>
              <div className="mt-4 space-y-3">
                {FAQS.map((f) => (
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

        <OrderCtaBand
          heading="BURGER MOOD? IT'S CHEESE O'CLOCK."
          waMessage="Hi Cheese O'Clock! I'd like to order burgers. "
        />
      </main>
      <SiteFooter />
      <WhatsAppFab />
      <JsonLd
        nodes={webPageNode({
          path: '/burger-delivery-dha-karachi',
          name: 'Burger Delivery in DHA Karachi',
          description:
            'Smash burgers made to order, delivered hot across DHA Karachi, Clifton and Gizri — cash on delivery, open till 2am.',
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Burger delivery DHA Karachi', path: '/burger-delivery-dha-karachi' },
          ],
        })}
      />
    </>
  );
}
