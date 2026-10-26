/** The personal WhatsApp order link on the customer's phone (lib/wa-link, 26 Oct 2026). */
import { describe, expect, it } from 'vitest';
import { WA_LINK_KEEP_MS, parseWaLink, readWaToken, serializeWaLink } from './wa-link';

describe('wa-link', () => {
  it('takes a token as the bot makes them, nothing else', () => {
    expect(readWaToken('Abc23Def45Gh')).toBe('Abc23Def45Gh');
    for (const t of ['', 'short', 'has space 123', '<script>alert</script>', 'a'.repeat(17), null, undefined]) {
      expect(readWaToken(t)).toBeNull();
    }
  });

  it('keeps it three days, then reads nothing; a malformed value reads as nothing', () => {
    const t0 = Date.UTC(2026, 9, 26, 10);
    const raw = serializeWaLink('Abc23Def45Gh', t0);
    expect(parseWaLink(raw, t0 + 60_000)).toBe('Abc23Def45Gh');
    expect(parseWaLink(raw, t0 + WA_LINK_KEEP_MS - 1)).toBe('Abc23Def45Gh');
    expect(parseWaLink(raw, t0 + WA_LINK_KEEP_MS)).toBeNull();
    expect(parseWaLink(raw, t0 - 60_000)).toBeNull();
    for (const bad of [null, '', 'x', '{"t":"bad token","at":1}', '{"t":"Abc23Def45Gh"}', '[]']) {
      expect(parseWaLink(bad, t0)).toBeNull();
    }
  });
});
