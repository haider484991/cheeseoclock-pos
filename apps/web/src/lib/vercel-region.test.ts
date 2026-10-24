/**
 * The functions run next to the database (24 Oct 2026, "the website's API is so slow"): Neon is in
 * aws ap-southeast-1 (Singapore; the runtime log's "regions:" line), and every query is a round trip
 * between the two. In iad1 (Washington) each one crossed the world twice.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('vercel.json', () => {
  it('runs the functions in sin1, beside the Singapore database', () => {
    const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as { regions?: string[] };
    expect(config.regions).toEqual(['sin1']);
  });
});
