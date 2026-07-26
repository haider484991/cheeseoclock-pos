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

  const band = (
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

  // The tilt's scale-[1.02] widens the band past both viewport edges (~4px a
  // side at 375px), which adds horizontal page scroll on phones. Clip the
  // overhang on the X axis only — `overflow-y` stays visible (clip + visible
  // is the one pairing CSS doesn't coerce to auto) so the rotation's corners
  // still bleed over the sections above and below, which is the point of it.
  return tilted ? <div className="overflow-x-clip">{band}</div> : band;
}
