/**
 * What the till says about a menu publish and about an item's photo (sweep
 * B5): a photo too big for the website (over PUBLISHED_IMAGE_MAX_CHARS) was
 * left out SILENTLY before — the item went with no picture and nobody knew.
 * Now the publish result names the items, and the Menu editor warns on the
 * item itself.
 */
import {
  PUBLISHED_IMAGE_MAX_CHARS,
  type PublishMenuSummary,
  type WebAvailability,
} from '@cheeseoclock/shared-types';
import { andList } from './foodpandaWords';

/** The toast after "Publish menu to website". */
export function publishedToast(r: PublishMenuSummary): {
  title: string;
  description: string;
  variant: 'success' | 'warning';
} {
  const live = `${r.items} items in ${r.categories} categories are now live on the website.`;
  const left = r.photosLeftOut ?? [];
  const older = r.olderWebsite === true ? ` ${OLDER_WEBSITE_TOAST}` : '';
  if (left.length === 0) {
    return r.olderWebsite === true
      ? { title: 'Menu published — the website needs its update', description: `${live}${older}`, variant: 'warning' }
      : { title: 'Menu published 🎉', description: live, variant: 'success' };
  }
  const names = left.slice(0, 5).map((p) => p.name);
  const more = left.length > 5 ? ` and ${left.length - 5} more` : '';
  return {
    title: r.olderWebsite === true ? 'Menu published — the website needs its update' : 'Menu published — some photos left out',
    description: `${live} ${left.length === 1 ? 'This photo is' : 'These photos are'} too big for the website, so ${left.length === 1 ? 'it goes' : 'they go'} with no picture: ${andList(names)}${more}. Open the item in Menu and pick the photo again (the till makes it smaller).${older}`,
    variant: 'warning',
  };
}

/** The publish toast's words when the website is older than this till (it dropped "Pick-up only" and the messages). */
export const OLDER_WEBSITE_TOAST =
  'But the website is older than this till: it left out “Pick-up only” and the website messages (a delivery with a pick-up-only item is not refused). Update the website, then publish again.';

/** Is this photo too big for the website (it would be published with no picture)? */
export function photoTooBigForWebsite(imageUrl: string | null | undefined): boolean {
  return !!imageUrl && imageUrl.length > PUBLISHED_IMAGE_MAX_CHARS;
}

/** The Menu editor's warning on such a photo, with its size (about 3 characters per 4 bytes of a data URL). */
export function photoTooBigWords(imageUrl: string): string {
  const kb = Math.round((imageUrl.length * 3) / 4 / 1024);
  const limitKb = Math.round((PUBLISHED_IMAGE_MAX_CHARS * 3) / 4 / 1024);
  return `This photo is too big for the website (about ${kb} KB; the website takes up to about ${limitKb} KB): the website shows this item with no picture. Pick the photo again — the till makes it smaller.`;
}

/** Where an item sells on the website, in the owner's words (Menu editor). */
export const WEB_AVAILABILITY_WORDS: Record<WebAvailability, { label: string; hint: string }> = {
  on: { label: 'On the website', hint: 'Customers can order it for delivery or pick-up.' },
  pickup_only: {
    label: 'Pick-up only',
    hint: 'On the website for pick-up only: a delivery with it is refused, and while online pick-up is off it can’t be ordered there. Only this item — another size is its own item.',
  },
  off: { label: 'Not on the website', hint: 'Left off the website. The till still sells it.' },
};

/**
 * A deal's choices are not items: "Large: Fajita Pizza" in a deal is a choice
 * of the deal, which the till does not tie to the "Fajita Pizza — Large"
 * item (the till's own "Hidden" leaves it in the deal too). So an item off
 * the website, or pick-up only, is still a choice in the deals that offer it.
 */
export const WEBSITE_DEAL_CHOICE_NOTE =
  'A deal that offers it as a choice (like “Large: Fajita Pizza”) still offers it on the website, for delivery too — to stop that, take the choice out of the deal (Menu → Choices).';

/**
 * Where an item stands on the website, by the publish's own rule
 * (web-orders-bridge buildPublishedMenuReport): only what the till shows
 * goes — an item hidden on the till, or in a category hidden on the till,
 * never does; then a delivery charge always does; then its category off the
 * website takes it off; then its own setting.
 */
export type ItemWebsiteState = 'hidden_on_till' | 'fee' | 'category_off' | WebAvailability;

export function itemWebsiteState(
  item: { isActive: boolean; webAvailability: WebAvailability },
  category: { isActive: boolean; isOnWebsite: boolean } | undefined,
  isDeliveryCharge: boolean,
): ItemWebsiteState {
  if (!item.isActive || category?.isActive === false) return 'hidden_on_till';
  if (isDeliveryCharge) return 'fee';
  if (category && !category.isOnWebsite) return 'category_off';
  return item.webAvailability;
}

/** Does the item go to the website at the next publish (and its photo with it)? */
export function goesToWebsite(state: ItemWebsiteState): boolean {
  return state === 'fee' || state === 'on' || state === 'pickup_only';
}

/** The Menu editor list's words for an item's state (its own setting: WEB_AVAILABILITY_WORDS). */
export function itemWebsiteLabel(state: ItemWebsiteState): string {
  if (state === 'hidden_on_till') return 'Not on the website (hidden on the till)';
  if (state === 'fee') return 'Always (delivery charge)';
  if (state === 'category_off') return 'Off with its category';
  return WEB_AVAILABILITY_WORDS[state].label;
}

/**
 * Where a category stands on the website, by the same rule: hidden on the
 * till → none of it; on → its items as each is set; off → none of it, but
 * the delivery charges in it still go.
 */
export type CategoryWebsiteState = 'hidden_on_till' | 'on' | 'fees_only' | 'off';

export function categoryWebsiteState(
  category: { isActive: boolean; isOnWebsite: boolean },
  holdsDeliveryCharges: boolean,
): CategoryWebsiteState {
  if (!category.isActive) return 'hidden_on_till';
  if (category.isOnWebsite) return 'on';
  return holdsDeliveryCharges ? 'fees_only' : 'off';
}

export const CATEGORY_WEBSITE_WORDS: Record<CategoryWebsiteState, string> = {
  hidden_on_till: 'Not on the website (hidden on the till)',
  on: 'On the website',
  fees_only: 'Only its delivery charges',
  off: 'Not on the website',
};

/** When a change here reaches the website. */
export const WEBSITE_CHANGE_NOTE =
  'The website changes at the next “Publish menu” (Settings → Online orders) — or a few seconds after Save when “Publish the menu to the website by itself” is on.';

/** An item whose description says "pick-up only" is pick-up only on the website whatever this says (the website's older rule). */
export function saysPickupOnly(description: string | null | undefined): boolean {
  return /\bpick[\s-]?up only\b/i.test(description ?? '');
}
