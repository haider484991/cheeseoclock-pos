import { describe, it, expect } from 'vitest';
import { suggestDhaAreas, formatDhaArea, DHA_KARACHI_PLACES } from './dha-karachi.js';

describe('suggestDhaAreas', () => {
  it('lists the phases when nothing is typed', () => {
    const out = suggestDhaAreas('');
    expect(out.length).toBe(8);
    expect(out.every((p) => p.kind === 'phase')).toBe(true);
  });

  it('finds a phase and its places from a bare number', () => {
    const labels = suggestDhaAreas('6', 20).map((p) => p.label);
    expect(labels[0]).toBe('DHA Phase 6');
    expect(labels).toContain('Rahat Commercial');
    expect(labels).toContain('Bukhari Commercial');
    expect(labels).not.toContain('Zamzama Commercial');
  });

  it('matches word prefixes across label and aliases', () => {
    expect(suggestDhaAreas('kh sha').map((p) => p.label)).toContain('Khayaban-e-Shahbaz');
    expect(suggestDhaAreas('bokhari').map((p) => p.label)).toContain('Bukhari Commercial');
    expect(suggestDhaAreas('rahat com').map((p) => p.label)[0]).toBe('Rahat Commercial');
  });

  it('is tolerant of punctuation and case', () => {
    expect(suggestDhaAreas('KHAYABAN-E-ITTEHAD').map((p) => p.label)[0]).toBe('Khayaban-e-Ittehad');
    expect(suggestDhaAreas('ph-7').map((p) => p.label)[0]).toBe('DHA Phase 7');
  });

  it('returns nothing for a place outside the gazetteer', () => {
    expect(suggestDhaAreas('gulshan')).toEqual([]);
  });
});

describe('formatDhaArea', () => {
  it('writes the ticket text with the phase when known', () => {
    const rahat = DHA_KARACHI_PLACES.find((p) => p.label === 'Rahat Commercial')!;
    expect(formatDhaArea(rahat)).toBe('Rahat Commercial, DHA Phase 6');
    const ph6 = DHA_KARACHI_PLACES.find((p) => p.label === 'DHA Phase 6')!;
    expect(formatDhaArea(ph6)).toBe('DHA Phase 6');
    const ittehad = DHA_KARACHI_PLACES.find((p) => p.label === 'Khayaban-e-Ittehad')!;
    expect(formatDhaArea(ittehad)).toBe('Khayaban-e-Ittehad, DHA');
  });
});
