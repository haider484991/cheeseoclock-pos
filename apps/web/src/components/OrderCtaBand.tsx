import Link from 'next/link';
import { BUSINESS, waLink } from '@/lib/business';

/** Yellow conversion band reused across delivery/intent pages. */
export function OrderCtaBand({
  heading,
  waMessage,
}: {
  heading: string;
  waMessage: string;
}) {
  return (
    <section className="bg-cheese">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-4 py-14 text-center">
        <h2 className="font-display text-[clamp(2.5rem,6vw,4.5rem)] leading-[0.92] tracking-wide text-night">
          {heading}
        </h2>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/menu"
            className="rounded-full bg-night px-8 py-4 font-display text-xl tracking-wide text-cheese shadow-soft-lg transition-transform hover:scale-105 active:scale-95"
          >
            ORDER ONLINE →
          </Link>
          <a
            href={waLink(waMessage)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border-2 border-night/30 px-7 py-4 text-lg font-bold text-night transition-colors hover:border-night active:scale-95"
          >
            💬 WhatsApp us
          </a>
        </div>
        <p className="text-sm font-semibold text-night/70">
          {BUSINESS.hours} · Cash on delivery · {BUSINESS.phoneDisplay}
        </p>
      </div>
    </section>
  );
}
