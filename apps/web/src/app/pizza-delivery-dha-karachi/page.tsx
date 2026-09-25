import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { ShowcaseVisual } from '@/components/ShowcaseVisual';
import { DELIVERY_AREAS, feeText } from '@/lib/areas';
import { FEE_SUMMARY } from '@/lib/delivery-zones';
import { formatCents } from '@/lib/format';
import { JsonLd, webPageNode } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Pizza Delivery in DHA Karachi — Medium & Large, Cash on Delivery',
  description:
    'Order pizza online for delivery across DHA Phases 1–8 and Clifton — Signature pies and regular pizzas in Medium 9" or Large 12". Cash on delivery, till 1 am.',
  alternates: { canonical: '/pizza-delivery-dha-karachi' },
};

const WHY = [
  {
    img: '/images/menu/cheesy-star.webp' as string | null,
    alt: 'Cheesy Star signature pizza, cut like a star',
    fallback: { big: 'Signature', small: 'Large 12"' },
    title: 'Signature pizzas',
    body: 'Shawarma Pizza, Crown Crust, Cheesy Star, Meat Lovers and Cheetos — the house specials, all Large 12". The Cheesy Star is cut like a star and comes with a Sriracha mayo dip.',
  },
  {
    img: null as string | null,
    alt: 'Regular pizzas in Medium 9" and Large 12"',
    fallback: { big: '9" · 12"', small: 'Medium · Large' },
    title: 'Regular pizzas, two sizes',
    body: 'Fajita, Classic Supreme, Malai Supreme, Chicken Tikka, Chicken Tikka Malai, Cheesalious, Veggie Lovers (any five veggies) and Classic Pepperoni — each in Medium 9" or Large 12".',
  },
  {
    img: null as string | null,
    alt: 'Value deals with a 1 litre soft drink',
    fallback: { big: 'From Rs 2,600', small: 'Value deals · 1 litre soft drink' },
    title: 'Value deals',
    body: 'Big Two (2 Large), Family Feast (1 Medium + 1 Large) and Perfect Pair (2 Medium) — regular-menu pizzas with a 1 litre soft drink, for less than ordering them one by one.',
  },
];

const FAQS = [
  {
    q: 'How much is pizza delivery in DHA and Clifton?',
    a: `${FEE_SUMMARY.map((f) => `${formatCents(f.feeCents)} for ${f.places.replace(' · ', ', ')}`).join('; ')}. We deliver in DHA and Clifton only. You can follow your order’s status after checkout.`,
  },
  {
    q: 'Do you deliver pizza late at night?',
    a: 'Yes — we take orders every day from 12 noon until 1 am, on the website and on WhatsApp.',
  },
  {
    q: 'How do I pay for my pizza?',
    a: 'Cash on delivery on every order. The bill is the menu total plus 15% tax and your area’s delivery fee.',
  },
  {
    q: 'Can I customize my pizza?',
    a: 'Regular pizzas come in Medium 9" or Large 12" (Signature pizzas are Large 12"), Veggie Lovers takes any five veggies you choose, and dips are Rs 100 each. For anything else, ask us on WhatsApp.',
  },
];

export default function PizzaDeliveryPage() {
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
          <p className="mt-5 leading-relaxed text-cream/80">
            Craving pizza in DHA? Ours bakes in our Phase 6 kitchen and rides
            out across every DHA phase and Clifton — Signature pies and regular
            pizzas in Medium 9&quot; or Large 12&quot;, fired to order and paid
            in cash at your door. Order on the website in under a minute, or
            send your order on WhatsApp; both land straight in the kitchen.
          </p>
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
            {WHY.map((w, i) => (
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
                  {a.name} · {feeText(a)}
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
          heading="PIZZA CRAVING? IT'S CHEESE O'CLOCK."
          waMessage="Hi Cheese O'Clock! I'd like to order pizza. "
        />
      </main>
      <SiteFooter />
      <WhatsAppFab />
      <JsonLd
        nodes={webPageNode({
          path: '/pizza-delivery-dha-karachi',
          name: 'Pizza Delivery in DHA Karachi',
          description:
            'Signature and regular pizzas delivered across DHA Karachi and Clifton — cash on delivery, open till 1 am.',
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Pizza delivery DHA Karachi', path: '/pizza-delivery-dha-karachi' },
          ],
        })}
      />
    </>
  );
}
