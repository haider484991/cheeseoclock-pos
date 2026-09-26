import type { DrawerOpenResult } from '@cheeseoclock/shared-types';

export interface DrawerToast {
  title: string;
  description?: string;
  variant: 'success' | 'info' | 'warning';
}

/**
 * What the counter is told after the till tried to open the drawer by hand.
 * "No printer" comes first: the file-only printer always "works", and saying
 * "Drawer opened" there would be a lie.
 */
export function drawerResultToast(r: DrawerOpenResult): DrawerToast {
  if (r.noPrinter) {
    return { title: 'No printer is set up — nothing opened', description: 'It was noted anyway.', variant: 'info' };
  }
  if (r.opened) return { title: 'Drawer opened', variant: 'success' };
  if (r.unsure) {
    return {
      title: 'Cash drawer may not have opened — check it',
      ...(r.message ? { description: r.message } : {}),
      variant: 'warning',
    };
  }
  return {
    title: 'Cash drawer did not open — use the key',
    ...(r.message ? { description: r.message } : {}),
    variant: 'warning',
  };
}

/** Quick reasons for a no-sale open; "Other" asks for a few words. */
export const DRAWER_REASONS = ['Change', 'Check notes', 'Other'] as const;
export type DrawerReasonChip = (typeof DRAWER_REASONS)[number];

/** The reason saved with the open: the chip, or what was typed for "Other" (optional). */
export function drawerReason(chip: DrawerReasonChip | null, other: string): string | null {
  if (chip === null) return null;
  if (chip !== 'Other') return chip;
  const typed = other.replace(/\s+/g, ' ').trim();
  return typed === '' ? 'Other' : typed.slice(0, 80);
}
