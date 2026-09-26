import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@cheeseoclock/ui';
import { logoFrameWidth } from './logoImage';

/**
 * Width ÷ height of an image, once it has loaded (null until then, or when
 * there is no image). Lets a layout give a wide logo a wide frame.
 */
export function useImageAspect(src?: string | null): number | null {
  const [aspect, setAspect] = useState<{ src: string; value: number } | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive && img.naturalWidth > 0 && img.naturalHeight > 0) {
        setAspect({ src, value: img.naturalWidth / img.naturalHeight });
      }
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return src && aspect?.src === src ? aspect.value : null;
}

interface StoreLogoProps {
  src?: string | null;
  /** Frame height in px. The frame grows sideways for a wide logo, up to maxWidth. */
  height: number;
  maxWidth?: number;
  /** Shown when there is no logo. */
  fallback?: ReactNode;
  /** White rounded frame, so a transparent logo reads on any background. */
  framed?: boolean;
  className?: string;
  alt?: string;
}

/**
 * The shop's logo, whole. It is fitted inside its frame (object-contain) and
 * never cropped: a wide logo gets a wide frame, a tall one a square frame
 * with space at the sides.
 */
export function StoreLogo({
  src,
  height,
  maxWidth = height,
  fallback = null,
  framed = true,
  className,
  alt = '',
}: StoreLogoProps) {
  const aspect = useImageAspect(src);
  if (!src) return <>{fallback}</>;
  const width = logoFrameWidth(aspect, height, maxWidth);
  const pad = framed ? Math.max(2, Math.round(height * 0.08)) : 0;
  return (
    <span
      className={cn(
        'inline-flex max-w-full shrink-0 items-center justify-center overflow-hidden',
        framed && 'rounded-xl bg-white ring-1 ring-stone-200/80 dark:ring-stone-700',
        className,
      )}
      style={{ height, width, padding: pad }}
      data-testid="store-logo"
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="block h-full w-full select-none object-contain"
      />
    </span>
  );
}
