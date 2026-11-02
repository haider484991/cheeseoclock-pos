'use client';

import { useEffect, useState } from 'react';
import { karachiClock } from '@/lib/cheese-time';

/** The clock's middle in its drawing (viewBox 0 0 400 400): the dial is the pizza, the bells and feet around it. */
const CX = 200;
const CY = 214;

/** Where the hands point: the hour hand's and the minute hand's turn from 12, in degrees. */
function handAngles(minutesAfterMidnight: number): { hour: number; minute: number } {
  const h = Math.floor(minutesAfterMidnight / 60) % 12;
  const m = minutesAfterMidnight % 60;
  return { hour: (h + m / 60) * 30, minute: m * 6 };
}

/**
 * The home hero's art (3 Nov 2026, the user: the logo in the hero, "artistic"): the logo's cheese alarm clock made
 * real — the shop's own Crown Crust as the dial, a gold bezel with its bells and feet, the hands at the time in
 * Karachi now, and the Signature Cheese Dipped burger leaning on it. Served at ten past ten (the page is the same for
 * everyone); after it loads, the hands keep Karachi's time. Pictures only: what it says is in the status line above.
 */
export function PizzaClock({ className = '' }: { className?: string }) {
  const [at, setAt] = useState(10 * 60 + 10);

  useEffect(() => {
    const tick = () => setAt(karachiClock(new Date()).now);
    tick();
    const id = window.setInterval(tick, 20_000);
    return () => window.clearInterval(id);
  }, []);

  const { hour, minute } = handAngles(at);
  return (
    <div aria-hidden className={`relative aspect-square ${className}`}>
      <div className="absolute -inset-[12%] rounded-full bg-[radial-gradient(circle,rgba(245,179,1,0.32),transparent_62%)]" />
      {/* The clock's body behind the pizza: the bells, the handle, the feet and the bezel. */}
      <svg viewBox="0 0 400 400" className="absolute inset-0 h-full w-full overflow-visible">
        <g fill="#F5B301">
          {/* the two bells, as the logo's clock wears them: domes on the bezel either side of the top */}
          <path d="M156 34a44 44 0 0 1 88 0z" transform={`rotate(-40 ${CX} ${CY})`} />
          <path d="M156 34a44 44 0 0 1 88 0z" transform={`rotate(40 ${CX} ${CY})`} />
          <rect x="191" y="14" width="18" height="26" rx="6" />
          <path d="M104 352l-26 34" stroke="#F5B301" strokeWidth="16" strokeLinecap="round" />
          <path d="M296 352l26 34" stroke="#F5B301" strokeWidth="16" strokeLinecap="round" />
        </g>
        <circle cx={CX} cy={CY} r="176" fill="#151412" />
        <circle cx={CX} cy={CY} r="176" fill="none" stroke="#F5B301" strokeWidth="14" />
      </svg>
      {/* The dial: the shop's own photo of its Crown Crust. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/menu/crown-crust.webp"
        srcSet="/images/menu/sm/crown-crust.webp 400w, /images/menu/crown-crust.webp 712w"
        sizes="(min-width: 768px) 420px, 70vw"
        alt=""
        width={712}
        height={720}
        fetchPriority="high"
        decoding="async"
        className="absolute left-[9.5%] top-[13%] w-[81%]"
      />
      {/* The hour marks on the bezel, and the hands at Karachi's time. */}
      <svg viewBox="0 0 400 400" className="absolute inset-0 h-full w-full overflow-visible">
        {Array.from({ length: 12 }, (_, i) => (
          <rect
            key={i}
            x={CX - (i % 3 === 0 ? 4 : 2.5)}
            y={CY - 182}
            width={i % 3 === 0 ? 8 : 5}
            height={i % 3 === 0 ? 14 : 10}
            rx="2"
            fill="#151412"
            transform={`rotate(${i * 30} ${CX} ${CY})`}
          />
        ))}
        <g style={{ filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.55))' }}>
          <rect x={CX - 7} y={CY - 92} width="14" height="104" rx="7" fill="#151412" stroke="#FAF5EA" strokeWidth="3" transform={`rotate(${hour} ${CX} ${CY})`} />
          <rect x={CX - 5} y={CY - 140} width="10" height="152" rx="5" fill="#151412" stroke="#FAF5EA" strokeWidth="3" transform={`rotate(${minute} ${CX} ${CY})`} />
          <circle cx={CX} cy={CY} r="14" fill="#F5B301" stroke="#151412" strokeWidth="4" />
        </g>
      </svg>
      {/* The burger leaning on the clock: pizza AND burgers. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/menu/signature-cheese-dipped.webp"
        srcSet="/images/menu/sm/signature-cheese-dipped.webp 400w, /images/menu/signature-cheese-dipped.webp 720w"
        sizes="(min-width: 768px) 200px, 34vw"
        alt=""
        width={720}
        height={674}
        decoding="async"
        className="absolute -bottom-[4%] -right-[10%] w-[46%] drop-shadow-[0_18px_22px_rgba(0,0,0,0.6)]"
      />
    </div>
  );
}
