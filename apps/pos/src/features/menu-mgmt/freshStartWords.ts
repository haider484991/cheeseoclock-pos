/**
 * The fresh start's words about the website settings, and the "Never
 * discounted" settings, it can't keep (Menu → Import, "Start fresh"). Pure,
 * so the wording is tested.
 */

/**
 * A fresh start keeps each website setting ("Pick-up only", "Not on the
 * website", a category off the website) for what the file brings back under
 * the SAME name; `n` = the ones it can't keep: set on items or categories the
 * file does not bring back by name, or on two of one name set differently
 * (nothing is carried for that name). Whatever of them the file brings back
 * is on the website, and the import publishes the menu straight away. With
 * none (0) the preview says nothing about the website.
 */
export function freshStartWebsiteWords(n: number): string {
  const one = n === 1;
  return `${n} item${one ? ' or category' : 's or categories'} set pick-up only or off the website can’t keep that setting (${one ? 'it is' : 'they are'} not in the file under the same name, or two of ${one ? 'that' : 'one'} name were set differently). The rest keep their website setting. If the file brings ${one ? 'it' : 'them'} back, ${one ? 'it goes' : 'they go'} on the website straight away (the import publishes the menu): set ${one ? 'it' : 'them'} again in Menu, then press “Publish menu to website”.`;
}

/**
 * A fresh start keeps each category's "Never discounted" setting (migration
 * 0047, yes or no) for the file's category of the SAME name; `n` = the ones
 * it can't keep: set on categories the file does not bring back by name, or
 * on two of one name that answer differently. A file category that gets
 * none goes by its name. With none (0) the preview says nothing about them.
 */
export function freshStartNoDiscountWords(n: number): string {
  const one = n === 1;
  return `${n} categor${one ? 'y’s' : 'ies’'} “Never discounted” setting${one ? '' : 's'} can’t be kept (${one ? 'it is' : 'they are'} not in the file under the same name, or two of ${one ? 'that' : 'one'} name were set differently). The file’s categories go by their names: deals and combos are never discounted, the rest can be. Check ${one ? 'it' : 'them'} in Menu → Categories.`;
}
