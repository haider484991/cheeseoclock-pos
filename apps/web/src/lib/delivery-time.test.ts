import { describe, expect, it } from 'vitest';
import { DEFAULT_ZONE_FACTS, deliveryMaxMinutes } from './delivery-facts';

describe('deliveryMaxMinutes (user, 24 Oct 2026: 40 minutes at most in DHA and Clifton)', () => {
  it('DHA and Clifton: 40 minutes, the DHA towers included', () => {
    expect(deliveryMaxMinutes({ group: 'DHA', name: 'DHA Phase 6' })).toBe(40);
    expect(deliveryMaxMinutes({ group: 'DHA', name: 'Emaar Crescent Bay (DHA)' })).toBe(40);
    expect(deliveryMaxMinutes({ group: 'Clifton', name: 'Clifton Block 9' })).toBe(40);
  });

  it('the farther areas the till adds: 50 minutes', () => {
    expect(deliveryMaxMinutes({ group: 'Abysinya', name: 'Abysinya lines' })).toBe(50);
    expect(deliveryMaxMinutes({ group: 'Brooks churangi', name: 'Korangi' })).toBe(50);
  });

  it('every built-in area is DHA or Clifton', () => {
    for (const z of DEFAULT_ZONE_FACTS) expect(deliveryMaxMinutes(z), z.name).toBe(40);
  });
});
