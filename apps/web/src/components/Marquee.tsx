/**
 * Yellow ticker strip — black display-type items looping horizontally.
 * Content is rendered twice so the -50% translate loops seamlessly; pauses
 * on hover. Pure CSS, server-renderable.
 */
export function Marquee({
  items,
  tilted = false,
}: {
  items: string[];
  tilted?: boolean;
}) {
  const row = (ariaHidden: boolean) => (
    <div
      aria-hidden={ariaHidden || undefined}
      className="flex shrink-0 items-center"
    >
      {items.map((item, i) => (
        <span
          key={i}
          className="flex items-center whitespace-nowrap font-display text-xl tracking-wide text-night sm:text-2xl"
        >
          <span className="px-5">{item}</span>
          <span aria-hidden className="text-night/60">
            ★
          </span>
        </span>
      ))}
    </div>
  );

  return (
    <div
      className={`relative z-10 overflow-hidden bg-cheese py-2.5 ${
        tilted ? '-rotate-1 scale-[1.02]' : ''
      }`}
    >
      <div className="flex w-max animate-marquee hover:[animation-play-state:paused]">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
