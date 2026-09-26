/**
 * The shop's food photos ship at 720px (public/images/menu) with a 400px copy
 * beside them (public/images/menu/sm). Phones draw them 150–200px wide, so the
 * small one is plenty there; the browser picks by width from this srcset.
 * Anything else (a till photo sent as a data URL) has no small copy.
 */
const SHOP_PHOTO = /^\/images\/menu\/([a-z0-9-]+\.webp)$/;

export function menuImageSrcSet(src: string | null | undefined): string | undefined {
  const m = src ? SHOP_PHOTO.exec(src) : null;
  return m ? `/images/menu/sm/${m[1]} 400w, ${src} 720w` : undefined;
}
