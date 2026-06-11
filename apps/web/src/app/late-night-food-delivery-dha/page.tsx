import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { CheeseTime } from '@/components/CheeseTime';
import { DELIVERY_AREAS, etaText } from '@/lib/areas';
import { JsonLd, webPageNode } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Late-Night Food Delivery in DHA Karachi — Open Till 2am',
  description:
    'Kitchen open daily till 2am — pizza, smash burgers, loaded fries & shakes delivered late across DHA, Clifton & Gizri. Clear roads mean faster rides. Cash on delivery.',
  alternates: { canonical: '/late-night-food-delivery-dha' },
};

const NIGHT_PICKS = [
  {
    img: '/images/hero-cheese-pull.jpg',
    alt: 'Late-night pepperoni pizza with a cheese pull',
    title: 'The 1am pizza',
    body: 'The single most-ordered thing after midnight. Cheese-pull pies bake until the last ticket at 2am.',
  },
  {
    img: '/images/fries-loaded.jpg',
    alt: 'Loaded fries in a basket, the late-night side order',
    title: 'Loaded fries',
    body: 'Exam season, match nights, post-shaadi hunger — the fries show up for all of it.',
  },
  {
    img: '/images/shake-chocolate.jpg',
    alt: 'Thick chocolate shake with cookies',
    title: 'Thick shakes',
    body: 'Cold, thick, and somehow always justified at midnight. Add one to the order — you know you want to.',
  },
];

const FAQS = [
  {
    q: 'How late can I actually order?',
    a: 'The kitchen takes orders every single day until 2am — website and WhatsApp both. The last rider leaves after the final ticket is fired, so a 1:55am order still gets cooked.',
  },
  {
    q: 'Is late-night delivery slower?',
    a: 'Usually the opposite. After 11pm DHA roads clear out and most deliveries land faster than the daytime quote — Phase 6 late orders often arrive in about 20 minutes.',
  },
  {
    q: 'Which areas do you cover after midnight?',
    a: 'The same full map as daytime: DHA Phases 1–8, Clifton and Gizri. No shrinking coverage at night — if we deliver to you at 8pm, we deliver to you at 1am.',
  },
  {
    q: 'How do I pay at 1am?',
    a: 'Cash on delivery, same as always. The rider calls when he is at your gate so the doorbell never wakes the house.',
  },
];

export default function LateNightPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-4 pt-12">
          <nav aria-label="Breadcrumb" className="text-sm text-smoke">
            <Link href="/" className="hover:text-cheese">
              Home
            </Link>{' '}
            / <span className="text-cream/80">Late-night delivery</span>
          </nav>
          <h1 className="mt-4 font-display text-4xl leading-[0.95] tracking-wide text-cream md:text-6xl">
            LATE-NIGHT FOOD DELIVERY IN DHA KARACHI — OPEN TILL 2AM
          </h1>
          <CheeseTime className="mt-4 text-sm text-smoke" />
          <p className="mt-4 leading-relaxed text-cream/80">
            It is past midnight, half of DHA&rsquo;s kitchens went dark hours
            ago, and the delivery apps are showing you sad leftovers. Ours is
            the kitchen still glowing in Phase 6: pizzas baking, burgers
            smashing and riders rolling out across DHA, Clifton and Gizri until
            2am — every night, not just weekends.
          </p>
          <p className="mt-4 leading-relaxed text-cream/80">
            Night orders are honestly our favourite: clear roads mean your food
            usually arrives faster than the daytime estimate, and the rider
            calls instead of ringing the bell.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/menu"
              className="rounded-full bg-cheese px-8 py-3.5 font-display text-xl tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
            >
              ORDER NOW →
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-12">
          <Reveal>
            <h2 className="font-display text-3xl tracking-wide text-cream">
              WHAT DHA ORDERS AFTER MIDNIGHT
            </h2>
          </Reveal>
          <div className="mt-5 grid gap-5 md:grid-cols-3">
            {NIGHT_PICKS.map((w, i) => (
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
                    <h3 className="text-lg font-bold text-cream">{w.title}</h3>
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
              LATE-NIGHT COVERAGE
            </h2>
            <p className="mt-3 text-smoke">
              Full daytime map, all night — no shrinking delivery zone after 12.
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
                LATE-NIGHT FAQS
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
          heading="MIDNIGHT CRAVING? STILL CHEESE O'CLOCK."
          waMessage="Hi Cheese O'Clock! Late night order please: "
        />
      </main>
      <SiteFooter />
      <WhatsAppFab />
      <JsonLd
        nodes={webPageNode({
          path: '/late-night-food-delivery-dha',
          name: 'Late-Night Food Delivery in DHA Karachi',
          description:
            'Pizza, burgers, fries and shakes delivered across DHA Karachi until 2am every night — cash on delivery.',
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Late-night delivery', path: '/late-night-food-delivery-dha' },
          ],
        })}
      />
    </>
  );
}
