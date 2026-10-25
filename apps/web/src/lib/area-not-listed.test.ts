import { describe, expect, it } from 'vitest';
import { AREA_NOT_LISTED, DEFAULT_FACTS, zoneNameWithLocalNames, zoneOptionGroups } from './delivery-facts';
import { parseLocationChoice, serializeLocationChoice } from './location-choice';

describe('the area lists (26 Oct 2026)', () => {
  it('add the names customers know an area by, and nothing to an area without any', () => {
    expect(zoneNameWithLocalNames('DHA Phase 5')).toBe('DHA Phase 5 (Zamzama, Badar, Khadda)');
    expect(zoneNameWithLocalNames('DHA Phase 6')).toBe('DHA Phase 6 (Bukhari, Ittehad, Rahat, Nishat)');
    expect(zoneNameWithLocalNames('Clifton Block 5')).toBe('Clifton Block 5 (Boat Basin, Kehkashan)');
    expect(zoneNameWithLocalNames('dha  phase 8')).toBe('dha  phase 8 (Do Darya, Al-Murtaza)');
    expect(zoneNameWithLocalNames('DHA Phase 1')).toBe('DHA Phase 1');
    expect(zoneNameWithLocalNames('Korangi')).toBe('Korangi');
    const labels = zoneOptionGroups(DEFAULT_FACTS.zones).flatMap((g) => g.options.map((o) => o.label));
    expect(labels).toContain('DHA Phase 6 (Bukhari, Ittehad, Rahat, Nishat) — Rs 200');
    expect(labels).toContain('Clifton Block 9 (Schon Circle) — Rs 200');
  });

  it('"My area isn’t listed" is never a zone, and a phone keeps it as its delivery choice', () => {
    expect(DEFAULT_FACTS.zones.some((z) => z.id === AREA_NOT_LISTED)).toBe(false);
    const choice = { fulfilment: 'delivery' as const, zoneId: AREA_NOT_LISTED, pin: null, pinAt: null, at: Date.UTC(2026, 9, 26) };
    expect(parseLocationChoice(serializeLocationChoice(choice))).toEqual(choice);
  });
});
