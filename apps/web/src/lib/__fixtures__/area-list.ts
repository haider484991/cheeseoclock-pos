import { AREA_NOT_LISTED, zoneNameWithLocalNames } from '../delivery-facts';

/**
 * The checkout's area list gained two things after the golden copy was taken (2026-10-26, the user's OK): the names
 * customers know an area by after its zone name (lib/delivery-facts zoneNameWithLocalNames), and "My area isn't
 * listed" as the last choice (AREA_NOT_LISTED). The sheet is the golden with exactly these added, and nothing else.
 */
export function withAreaListAdditions(html: string): string {
  return html
    .replace(
      /(<option value="[^"]+"[^>]*>)([^<]+?)( — [^<]*<\/option>)/g,
      (_m, open: string, name: string, rest: string) => `${open}${zoneNameWithLocalNames(name)}${rest}`,
    )
    .replace(
      '</optgroup></select>',
      `</optgroup><optgroup label="Somewhere else"><option value="${AREA_NOT_LISTED}">My area isn’t listed — order on WhatsApp</option></optgroup></select>`,
    );
}

/** The golden's checkout area options with the local names added (the "not listed" choice is the sheet's own). */
export function optionsWithLocalNames<T extends { label: string }>(options: readonly T[]): T[] {
  return options.map((o) => {
    const at = o.label.lastIndexOf(' — ');
    return at < 0 ? o : { ...o, label: `${zoneNameWithLocalNames(o.label.slice(0, at))}${o.label.slice(at)}` };
  });
}
