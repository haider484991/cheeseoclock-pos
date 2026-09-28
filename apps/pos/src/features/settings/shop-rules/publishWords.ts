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
  if (left.length === 0) return { title: 'Menu published 🎉', description: live, variant: 'success' };
  const names = left.slice(0, 5).map((p) => p.name);
  const more = left.length > 5 ? ` and ${left.length - 5} more` : '';
  return {
    title: 'Menu published — some photos left out',
    description: `${live} ${left.length === 1 ? 'This photo is' : 'These photos are'} too big for the website, so ${left.length === 1 ? 'it goes' : 'they go'} with no picture: ${andList(names)}${more}. Open the item in Menu and pick the photo again (the till makes it smaller).`,
    variant: 'warning',
  };
}

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
    hint: 'On the website, but only for pick-up: the website refuses it on a delivery.',
  },
  off: { label: 'Not on the website', hint: 'Left off the website. The till still sells it.' },
};

/** When a change here reaches the website. */
export const WEBSITE_CHANGE_NOTE =
  'The website changes at the next “Publish menu” (Settings → Online orders) — or a few seconds after Save when “Publish the menu to the website by itself” is on.';

/** An item whose description says "pick-up only" is pick-up only on the website whatever this says (the website's older rule). */
export function saysPickupOnly(description: string | null | undefined): boolean {
  return /\bpick[\s-]?up only\b/i.test(description ?? '');
}
