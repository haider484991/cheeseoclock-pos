/**
 * The share images carry their font in the code since 2026-10-27 (lib/og-font): the database client is TCP now, so
 * they left the Edge runtime, the only one that could fetch the .ttf next to them. Here that fetch always failed, so
 * the golden drew them in the fallback font; now they are drawn as the site has always served them, in Bebas. Each
 * drawing is the golden's with exactly that one word changed, and nothing else.
 */
export function withShareImageFont<T>(images: T): T {
  if (images === undefined) return images;
  return JSON.parse(JSON.stringify(images).replaceAll('font-family:sans-serif', 'font-family:Bebas')) as T;
}
