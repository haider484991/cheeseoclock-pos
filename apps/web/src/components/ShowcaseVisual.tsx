import { menuImageSrcSet } from '@/lib/images';

/**
 * Card art for the landing pages. The shop's own cut-out food photo on a gold
 * glow when one exists; otherwise a bold type panel — never a stock photo of
 * food the kitchen doesn't make.
 */
export function ShowcaseVisual({
  img,
  alt,
  fallback,
}: {
  img?: string | null;
  alt: string;
  fallback: { big: string; small: string };
}) {
  return (
    <div className="relative grid aspect-[4/3] w-full place-items-center overflow-hidden bg-ink bg-[radial-gradient(circle_at_50%_58%,rgba(245,179,1,0.28),transparent_66%)]">
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img}
          srcSet={menuImageSrcSet(img)}
          sizes="(min-width: 768px) 260px, 72vw"
          alt={alt}
          width={720}
          height={720}
          loading="lazy"
          decoding="async"
          className="w-[72%] drop-shadow-[0_20px_24px_rgba(0,0,0,0.55)]"
        />
      ) : (
        <div className="px-6 text-center">
          <div className="font-display text-5xl uppercase leading-none tracking-wide text-cheese">
            {fallback.big}
          </div>
          <div className="mt-2 font-cond text-lg font-bold uppercase tracking-wide text-cream/70">
            {fallback.small}
          </div>
          <span className="sr-only">{alt}</span>
        </div>
      )}
    </div>
  );
}
