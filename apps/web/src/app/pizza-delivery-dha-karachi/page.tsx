import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { DELIVERY_AREAS, etaText } from '@/lib/areas';
import { JsonLd, webPageNode } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Pizza Delivery in DHA Karachi — Hot in 30–45 Min',
  description:
    'Order signature cheese-pull pizza online for delivery across DHA Phases 1–8, Clifton & Gizri. Daily-proofed dough, oven to door in 30–45 min, cash on delivery, open till 2am.',
  alternates: { canonical: '/pizza-delivery-dha-karachi' },
};

const WHY = [
  {
    img: '/images/pizza-cheesy.jpg',
    alt: 'Cheese O\'Clock four-cheese pizza fresh out of the oven',
    title: 'Dough proofed daily',
    body: 'Every base is proofed in-house the same day it bakes. No frozen discs, no shortcuts — that is where the chew and the char come from.',
  },
  {
    img: '/images/hero-cheese-pull.jpg',
    alt: 'Slice lift with a long mozzarella cheese pull',
    title: 'A proper cheese pull',
    body: 'We blend real mozzarella for stretch and cheddar for flavour, and we do not ration it. The name is a promise, not a gimmick.',
  },
  {
    img: '/images/pizza-bbq.jpg',
    alt: 'Smoky BBQ chicken pizza on a dark wooden board',
    title: 'Boxed at the bell',
    body: 'Pizzas go straight from oven to box to insulated bag — never under a heat lamp waiting for a rider. What leaves hot, arrives hot.',
  },
];

const FAQS = [
  {
    q: 'How long does pizza delivery take in DHA?',
    a: 'From our Phase 6 kitchen: 20–35 minutes inside Phase 6, 25–45 minutes for Phases 4, 5, 7 and 8, and up to 50 for Phase 1 & 2 and Clifton. You can track your order live after checkout.',
  },
  {
    q: 'Do you deliver pizza late at night?',
    a: 'Yes — the ovens fire daily until 2am, and late-night rides are usually faster with clear roads. We are one of the few kitchens in DHA still baking after midnight.',
  },
  {
    q: 'How do I pay for my pizza?',
    a: 'Cash on delivery on every order. The rider carries change, and the printed kitchen receipt is your exact bill — no surprise charges.',
  },
  {
    q: 'Can I customize my pizza?',
    a: 'Yes — toppings, sizes and add-ons are all on the online menu. Tap a pizza to customize it, or tell us what you want on WhatsApp and we will build it.',
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
            PIZZA DELIVERY IN DHA KARACHI — HOT IN 30–45 MINUTES
          </h1>
          <p className="mt-5 leading-relaxed text-cream/80">
            Craving pizza in DHA? Ours bakes in Phase 6 and rides out across
            every phase, Clifton and Gizri — signature cheese-pull pies on
            daily-proofed dough, delivered hot and paid in cash at your door.
            Order on the website in under a minute, or send your order on
            WhatsApp; both land straight in the kitchen queue.
          </p>
          <p className="mt-4 leading-relaxed text-cream/80">
            No app downloads, no online payments, no cold corners: the box is
            sealed at the oven and opened by you. If a pizza ever arrives in a
            state we would not serve, message us and we will make it right.
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
              PIZZA DELIVERY AREAS
            </h2>
            <p className="mt-3 text-smoke">
              Honest delivery windows from the Phase 6 ovens — tap your area for
              covered streets and local FAQs.
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
            'Signature cheese-pull pizza delivered hot across DHA Karachi, Clifton and Gizri — cash on delivery, open till 2am.',
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Pizza delivery DHA Karachi', path: '/pizza-delivery-dha-karachi' },
          ],
        })}
      />
    </>
  );
}
