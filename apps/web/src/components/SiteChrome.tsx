import Link from 'next/link';
import { BUSINESS } from '@/lib/business';
import { Logo, ClockMark } from './Logo';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/70 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" aria-label="Cheese O'Clock home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 text-sm font-semibold">
          <Link
            href="/menu"
            className="rounded-lg px-3 py-2 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            Menu
          </Link>
          <a
            href={BUSINESS.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg px-3 py-2 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            WhatsApp
          </a>
          <Link
            href="/menu"
            className="ml-2 rounded-xl bg-gradient-to-b from-amber-400 to-amber-500 px-4 py-2 text-stone-900 shadow-soft-sm transition-all hover:from-amber-300 hover:to-amber-400 hover:shadow-lift"
          >
            Order now
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-stone-200 bg-white">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3">
        <div>
          <div className="flex items-center gap-2">
            <ClockMark className="h-8 w-8 text-[#F5B301]" />
            <span className="font-extrabold tracking-tight">Cheese O&rsquo;Clock</span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-stone-500">
            {BUSINESS.tagline}
          </p>
        </div>
        <div className="text-sm">
          <h3 className="mb-2 font-bold uppercase tracking-wider text-stone-400">
            Find us
          </h3>
          <p className="text-stone-600">{BUSINESS.addressLine}</p>
          <p className="mt-1 text-stone-600">{BUSINESS.hours}</p>
        </div>
        <div className="text-sm">
          <h3 className="mb-2 font-bold uppercase tracking-wider text-stone-400">
            Order &amp; contact
          </h3>
          <p>
            <a className="text-stone-600 hover:text-amber-600" href={`tel:${BUSINESS.phoneE164}`}>
              📞 {BUSINESS.phoneDisplay}
            </a>
          </p>
          <p className="mt-1">
            <a
              className="text-stone-600 hover:text-amber-600"
              href={BUSINESS.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              💬 WhatsApp us
            </a>
          </p>
        </div>
      </div>
      <div className="border-t border-stone-100 py-4 text-center text-xs text-stone-400">
        © {new Date().getFullYear()} Cheese O&rsquo;Clock · DHA Karachi
      </div>
    </footer>
  );
}
