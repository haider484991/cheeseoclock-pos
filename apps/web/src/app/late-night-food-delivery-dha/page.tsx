import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { ShowcaseVisual } from '@/components/ShowcaseVisual';
import { CheeseTime } from '@/components/CheeseTime';
import { BUSINESS } from '@/lib/business';
import { DELIVERY_AREAS, feeText } from '@/lib/areas';
import { JsonLd, webPageNode } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Late-Night Food Delivery in DHA Karachi — Open Till 1 am',
  description:
    'Kitchen open daily till 1 am — pizza, crispy chicken burgers, masala fries & baked wings delivered late across DHA and Clifton. Cash on delivery.',
  alternates: { canonical: '/late-night-food-delivery-dha' },
};

const NIGHT_PICKS = [
  {
    img: '/images/menu/cheesy-star.webp' as string | null,
    alt: 'Cheesy Star signature pizza',
    fallback: { big: 'Till 1 am', small: 'Ovens on every night' },
    title: 'The midnight pizza',
    body: 'The star-cut Cheesy Star, built for sharing — or a Classic Pepperoni in Medium 9" or Large 12". The ovens stay on until we close at 1 am.',
  },
  {
    img: null as string | null,
    alt: 'Signature Masala Fries',
    fallback: { big: 'Masala fries', small: 'Large · from Rs 480' },
    title: 'Masala fries',
    body: 'Signature Masala or Mayo Masala Fries — exam season, match nights, post-shaadi hunger, the fries show up for all of it.',
  },
  {
    img: null as string | null,
    alt: 'Six oven-baked chicken wings',
    fallback: { big: '6 wings', small: 'Oven-baked · with a dip' },
    title: 'Baked wings',
    body: 'Six oven-baked wings with a dip, somehow always justified at midnight. Add a cold drink to the order — you know you want to.',
  },
];

const FAQS = [
  {
    q: 'How late can I actually order?',
    a: 'The kitchen takes orders every single day until 1 am — website and WhatsApp both — and opens again at 12 noon.',
  },
  {
    q: 'Can I order on WhatsApp late at night?',
    a: `Yes — until 1 am on ${BUSINESS.whatsappLines.map((l) => l.display).join(' or ')}. Send your order and address and we will confirm the total.`,
  },
  {
    q: 'Which areas do you cover after midnight?',
    a: 'The same map as daytime: DHA Phases 1–8 and Clifton, at the same Rs 200–250 delivery fees. We do not deliver outside DHA and Clifton at any hour.',
  },
  {
    q: 'How do I pay late at night?',
    a: 'Cash on delivery, same as always — the menu total plus 15% tax and your area’s delivery fee. If the house is asleep, say so in the order notes and keep your phone on for the rider.',
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
            LATE-NIGHT FOOD DELIVERY IN DHA KARACHI — OPEN TILL 1 AM
          </h1>
          <CheeseTime className="mt-4 text-sm text-smoke" />
          <p className="mt-4 leading-relaxed text-cream/80">
            It is past midnight, half of DHA&rsquo;s kitchens went dark hours
            ago, and the delivery apps are showing you sad leftovers. Ours is
            the kitchen still glowing in Phase 6: pizzas baking, crispy chicken
            burgers coming together and riders rolling out across DHA and
            Clifton until 1 am — every night, not just weekends.
          </p>
          <p className="mt-4 leading-relaxed text-cream/80">
            Night orders are honestly our favourite. Order before 1 am on the
            website or WhatsApp, add a note if the house is asleep, and pay the
            rider in cash at the gate.
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
                  <ShowcaseVisual img={w.img} alt={w.alt} fallback={w.fallback} />
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
              Same delivery map and fees all night — DHA and Clifton, until 1 am.
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
            'Pizza, crispy chicken burgers, fries and baked wings delivered across DHA Karachi and Clifton until 1 am every night — cash on delivery.',
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Late-night delivery', path: '/late-night-food-delivery-dha' },
          ],
        })}
      />
    </>
  );
}
