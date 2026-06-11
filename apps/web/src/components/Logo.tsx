/**
 * Cheese O'Clock logo — rebuilt as a transparent vector so it's crisp at any
 * size and drops onto any background (no black box). The alarm clock's "cheese
 * holes" and hands are real cutouts (transparent), mirroring the original
 * gold-on-black mark, and the wordmark uses Pacifico to match the brush script.
 *
 *   <Logo />                row lockup, gold clock + dark wordmark (light bg)
 *   <Logo dark />           all-gold (use on dark backgrounds)
 *   <Logo stacked dark />   big stacked mark for the hero, gold on dark
 */

const GOLD = '#F5B301';

export function ClockMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="currentColor"
      role="img"
      aria-hidden
    >
      <defs>
        {/* White = visible gold; black = transparent (cheese holes + hands). */}
        <mask id="coc-face">
          <rect width="48" height="48" fill="black" />
          <circle cx="24" cy="26" r="14" fill="white" />
          <circle cx="18.5" cy="21" r="2.2" fill="black" />
          <circle cx="30" cy="20.5" r="1.8" fill="black" />
          <circle cx="20.5" cy="31" r="1.7" fill="black" />
          <circle cx="29.5" cy="31" r="1.9" fill="black" />
          <line
            x1="24"
            y1="26"
            x2="24"
            y2="15.5"
            stroke="black"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <line
            x1="24"
            y1="26"
            x2="31"
            y2="29.5"
            stroke="black"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </mask>
      </defs>
      {/* bells */}
      <circle cx="14" cy="13" r="6.5" />
      <circle cx="34" cy="13" r="6.5" />
      {/* top knob */}
      <rect x="22" y="4.5" width="4" height="4" rx="2" />
      {/* feet */}
      <rect width="6.5" height="3.2" rx="1.6" transform="translate(15 40) rotate(-38)" />
      <rect width="6.5" height="3.2" rx="1.6" transform="translate(31.5 38.8) rotate(38)" />
      {/* clock body with cheese-hole + hand cutouts */}
      <circle cx="24" cy="26" r="14" mask="url(#coc-face)" />
    </svg>
  );
}

export function Logo({
  className = '',
  dark = false,
  stacked = false,
}: {
  className?: string;
  dark?: boolean;
  stacked?: boolean;
}) {
  // The site chrome is dark everywhere now — the fallback wordmark stays
  // brand gold on both variants (`dark` kept for API compatibility).
  const textColor = dark ? 'text-[#F5B301]' : 'text-[#F5B301]';
  const script = { fontFamily: 'var(--font-display), Impact, sans-serif' } as const;

  if (stacked) {
    return (
      <div className={`flex select-none flex-col items-center ${className}`}>
        <ClockMark className="h-16 w-16 text-[#F5B301]" />
        <span style={script} className={`mt-1 text-5xl leading-none ${textColor}`}>
          Cheese
        </span>
        <span style={script} className={`text-2xl leading-none ${textColor}`}>
          O&rsquo;clock
        </span>
      </div>
    );
  }

  return (
    <div className={`flex select-none items-center gap-2 ${className}`}>
      <ClockMark className="h-9 w-9 text-[#F5B301]" />
      <span style={script} className={`text-2xl leading-none ${textColor}`}>
        Cheese O&rsquo;Clock
      </span>
    </div>
  );
}

export { GOLD };
