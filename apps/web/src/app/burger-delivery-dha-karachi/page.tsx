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
  title: 'Burger Delivery in DHA Karachi — Crispy Chicken on Brioche',
  description:
    'Crispy chicken burgers — thigh-marinated fillets in brioche buns — delivered across DHA Phases 1–8 and Clifton. Cash on delivery, open daily till 1 am.',
  alternates: { canonical: '/burger-delivery-dha-karachi' },
};

const WHY = [
  {
    img: '/images/menu/signature-cheese-dipped.webp' as string | null,
    alt: 'Signature Cheese Dipped crispy chicken burger',
    fallback: { big: 'Crispy chicken', small: 'Thigh fillet · brioche bun' },
    title: 'Crispy chicken, thigh meat',
    body: 'Every burger is built on a thigh-marinated crispy chicken fillet in a brioche bun, made when your order comes in.',
  },
  {
    img: null as string | null,
    alt: 'Four crispy chicken burgers',
    fallback: { big: '4 burgers', small: 'Rs 700 – Rs 950' },
    title: 'Four burgers, pick your level',
    body: 'Classic Crispy Chicken, Crispy Signature, Signature Cheese Dipped and Nashville Authentic (Hot). Add cheese to any burger for Rs 100.',
  },
  {
    img: null as string | null,
    alt: 'Fries and sides',
    fallback: { big: 'Fries & sides', small: 'From Rs 300' },
    title: 'Sides that keep up',
    body: 'Fries, Signature Masala and Mayo Masala Fries, five nuggets with fries and a dip, or six oven-baked wings. (Signature Loaded Fries are pick-up only.)',
  },
];

const FAQS = [
  {
    q: 'What goes into your burgers?',
    a: 'A thigh-marinated crispy chicken fillet in a brioche bun. Start with the Classic Crispy Chicken, step up to the Crispy Signature or the Signature Cheese Dipped, or go Nashville Authentic if you want heat. Add cheese to any of them for Rs 100.',
  },
  {
    q: 'Where do you deliver burgers?',
    a: `DHA and Clifton only, from our kitchen in Rahat Commercial, Phase 6. Delivery is ${FEE_SUMMARY.map((f) => `${formatCents(f.feeCents)} for ${f.places.replace(' · ', ', ')}`).join('; ')}. You can follow your order’s status after checkout.`,
  },
  {
    q: 'Can I get a burger deal for a group?',
    a: 'Our value deals are pizza deals — Big Two, Family Feast and Perfect Pair. For a group burger order, WhatsApp us your headcount and we will help you put it together.',
  },
  {
    q: 'Is payment cash only?',
    a: 'Cash on delivery on every order — no cards or wallets needed. The bill is the menu total plus 15% tax and your area’s delivery fee.',
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
            BURGER DELIVERY IN DHA KARACHI — CRISPY CHICKEN ON BRIOCHE
          </h1>
          <p className="mt-5 leading-relaxed text-cream/80">
            DHA has burger spots on every other street. Ours keeps it to
            chicken and does it properly: a thigh-marinated crispy chicken
            fillet in a brioche bun, made when your order lands in our Phase 6
            kitchen and sent out hot across DHA and Clifton.
          </p>
          <p className="mt-4 leading-relaxed text-cream/80">
            Order online in under a minute or send a WhatsApp — both are cash
            on delivery, every day from 12 noon to 1 am.
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
              BURGER DELIVERY AREAS
            </h2>
            <p className="mt-3 text-smoke">
              Fired in Phase 6, delivered across DHA and Clifton — tap your
              area for the streets we cover and its delivery fee.
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
            'Crispy chicken burgers in brioche buns, delivered across DHA Karachi and Clifton — cash on delivery, open till 1 am.',
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Burger delivery DHA Karachi', path: '/burger-delivery-dha-karachi' },
          ],
        })}
      />
    </>
  );
}
