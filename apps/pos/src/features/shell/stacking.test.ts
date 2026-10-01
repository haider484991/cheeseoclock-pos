/**
 * What sits on top of what, where two fixed layers can meet. The signed-in note sits at the bottom left
 * (AlertBanner, v0.7.33); the update banner sits at the bottom centre. On a 1024 px till the two overlap, and
 * "Restart now" must stay on top so an update can always be put in.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const zOf = (code: string, marker: string): number => {
  const line = code.split('\n').find((l) => l.includes(marker));
  const z = line?.match(/z-\[(\d+)\]/);
  if (!z) throw new Error(`no z-[n] on the line with ${marker}`);
  return Number(z[1]);
};

describe('stacking', () => {
  it('the update banner is above the new-order banner and its notes', () => {
    const update = zOf(source('./UpdateBanner.tsx'), 'fixed bottom-4 left-1/2');
    const note = zOf(source('../notifications/AlertBanner.tsx'), "'fixed z-[");
    expect(update).toBeGreaterThan(note);
  });

  it('the close-the-till question stays under the new-order banner, so a new order still shows over it', () => {
    const question = zOf(source('./CloseTillHost.tsx'), 'Dialog.Overlay');
    const note = zOf(source('../notifications/AlertBanner.tsx'), "'fixed z-[");
    expect(question).toBeLessThan(note);
  });
});
