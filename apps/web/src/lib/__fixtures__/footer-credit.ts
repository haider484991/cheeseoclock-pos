/**
 * The footer's bottom line gained one link after the golden copy was taken
 * (2026-10-13, with the owner's OK): a credit for the ordering system that
 * runs the site, after "Staff login". Every page with the site footer is the
 * golden with exactly this added, and nothing else.
 *
 * Then one line under it (2026-10-26): the legal name of the company that runs
 * the shop, which Meta's business verification needs on the site.
 */
export const FOOTER_CREDIT =
  ' · <a href="https://pixelandoak.com/pos/online-ordering-system/" target="_blank" rel="noopener" class="hover:text-cheese">Ordering by Pixel &amp; Oak POS</a>';

export const FOOTER_LEGAL_NAME = '<span class="mt-1 block">Operated by Saaz Global (SMC-Private) Limited</span>';

const BOTTOM_LINE_END = 'Staff login</a></div></footer>';

/** The golden page as served today: the credit and the legal name added to the footer's bottom line. */
export function withFooterCredit(html: string): string {
  return html.replace(BOTTOM_LINE_END, `Staff login</a>${FOOTER_CREDIT}${FOOTER_LEGAL_NAME}</div></footer>`);
}
