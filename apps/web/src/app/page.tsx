import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { Logo } from '@/components/Logo';
import { BUSINESS } from '@/lib/business';

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden bg-gradient-to-b from-amber-50 via-stone-50 to-stone-50">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 md:grid-cols-2 md:py-28">
            <div className="animate-fade-in">
              <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-800">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Now delivering in DHA Karachi
              </p>
              <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-5xl md:text-6xl">
                It&rsquo;s always
                <span className="block bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text text-transparent">
                  Cheese O&rsquo;Clock.
                </span>
              </h1>
              <p className="mt-4 max-w-md text-lg leading-relaxed text-stone-600">
                Premium fast food done right — signature handcrafted pizzas,
                loaded gourmet burgers, crispy sides and more, delivered hot to
                your door in Phase 6, DHA.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/menu"
                  className="rounded-2xl bg-gradient-to-b from-amber-400 to-amber-500 px-8 py-4 text-lg font-bold text-stone-900 shadow-lift transition-all hover:from-amber-300 hover:to-amber-400 hover:shadow-soft-lg active:scale-95"
                >
                  Order online →
                </Link>
                <a
                  href={BUSINESS.whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-2xl bg-white px-8 py-4 text-lg font-bold text-stone-700 shadow-soft-sm ring-1 ring-stone-200 transition-all hover:bg-stone-50 hover:shadow-soft-md active:scale-95"
                >
                  💬 WhatsApp
                </a>
              </div>
              <p className="mt-4 text-sm text-stone-500">
                💵 Cash on delivery · 📞 {BUSINESS.phoneDisplay}
              </p>
            </div>
            <div className="relative hidden select-none md:block">
              <div className="mx-auto flex h-80 w-80 items-center justify-center rounded-[2.5rem] bg-stone-900 shadow-soft-lg ring-1 ring-stone-800">
                <Logo stacked dark />
              </div>
              <div className="absolute -left-2 top-10 rounded-2xl bg-white px-4 py-3 text-sm font-bold shadow-soft-md">
                🍔 Loaded burgers
              </div>
              <div className="absolute -left-6 bottom-24 rounded-2xl bg-white px-4 py-3 text-sm font-bold shadow-soft-md">
                🍟 Crispy sides
              </div>
              <div className="absolute -right-2 bottom-12 rounded-2xl bg-white px-4 py-3 text-sm font-bold shadow-soft-md">
                🧀 Extra cheesy
              </div>
            </div>
          </div>
        </section>

        {/* Why us */}
        <section className="mx-auto max-w-6xl px-4 py-16">
          <div className="grid gap-6 sm:grid-cols-3">
            {[
              {
                emoji: '🔥',
                title: 'Fresh to order, every time',
                body: 'Signature pizzas on daily-proofed dough, burgers grilled to order — never reheated.',
              },
              {
                emoji: '🛵',
                title: 'Hot to your door',
                body: 'Fast delivery across DHA. Track your order live from kitchen to doorstep.',
              },
              {
                emoji: '💵',
                title: 'Cash on delivery',
                body: 'No cards needed. Pay the rider when your food arrives.',
              },
            ].map((f) => (
              <div
                key={f.title}
                className="rounded-2xl bg-white p-6 shadow-soft-sm ring-1 ring-stone-100 transition-shadow hover:shadow-soft-md"
              >
                <div className="text-3xl">{f.emoji}</div>
                <h3 className="mt-3 text-lg font-bold">{f.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-stone-500">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA strip */}
        <section className="mx-auto max-w-6xl px-4 pb-8">
          <div className="flex flex-col items-center justify-between gap-4 rounded-3xl bg-gradient-to-r from-amber-500 to-orange-500 px-8 py-10 text-center shadow-lift sm:flex-row sm:text-left">
            <div>
              <h2 className="text-2xl font-black text-white">Hungry right now?</h2>
              <p className="mt-1 text-amber-100">
                Browse the menu and order in under a minute.
              </p>
            </div>
            <Link
              href="/menu"
              className="whitespace-nowrap rounded-2xl bg-white px-8 py-4 text-lg font-bold text-amber-700 shadow-soft-md transition-transform hover:scale-105 active:scale-95"
            >
              See the menu →
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
