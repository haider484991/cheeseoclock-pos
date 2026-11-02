/**
 * The header was redrawn after the golden copies were taken (3 Nov 2026, the user: "cheese o'clock logo at center
 * beautifully and order now button on right side and other nav bar links on left sides"): the links on the left (a
 * phone: one menu button), the logo in the middle, the area and Order now on the right. Every page with the site
 * header is the golden with exactly its header swapped for today's — the one the home page's own golden
 * (home-page-2026-11-03.json, taken from this code) carries — and nothing else.
 */
const HEADER = /<header class="sticky top-0 z-40[\s\S]*?<\/header>/g;

/** The site header in a page's HTML (it must be there exactly once). */
export function siteHeaderOf(html: string): string {
  const found = html.match(HEADER) ?? [];
  if (found.length !== 1) throw new Error(`the header is in the page ${found.length} times, not once`);
  return found[0]!;
}

/** A golden page as served today: its header swapped for `header`, once; a page without the site header as it was. */
export function withSiteHeader(html: string, header: string): string {
  const found = html.match(HEADER)?.length ?? 0;
  if (found === 0) return html;
  if (found !== 1) throw new Error(`the header is in the page ${found} times, not once`);
  return html.replace(HEADER, () => header);
}
