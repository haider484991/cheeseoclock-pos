import { v5 as uuidv5 } from 'uuid';
import { COC_ID_NAMESPACE } from '@cheeseoclock/shared-types';

/**
 * The row id for a business setting's key: a name-based uuid v5, the same on
 * every till (costing spec D13). The same key written on both tills while
 * the link is down is the SAME row, and the link keeps the later write.
 * Kept apart from the repository so read-only code (Settings cards, the
 * Reports worker) can find a key's row without loading the write path.
 */
export function businessSettingId(key: string): string {
  return uuidv5(`business_settings:${key}`, COC_ID_NAMESPACE);
}
