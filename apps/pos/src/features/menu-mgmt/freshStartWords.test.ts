/**
 * The fresh start's words about the website settings it can't keep: the
 * names the file does not bring back, and the names whose removed items or
 * categories were set differently (the preview counts both).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { freshStartWebsiteWords } from './freshStartWords';

describe('a fresh start: the website settings it can’t keep', () => {
  it('one: says why it can’t be kept — not in the file by that name, or two of that name set differently', () => {
    expect(freshStartWebsiteWords(1)).toBe(
      '1 item or category set pick-up only or off the website can’t keep that setting (it is not in the file under the same name, or two of that name were set differently). The rest keep their website setting. If the file brings it back, it goes on the website straight away (the import publishes the menu): set it again in Menu, then press “Publish menu to website”.',
    );
  });

  it('several: the same, in the plural', () => {
    expect(freshStartWebsiteWords(3)).toBe(
      '3 items or categories set pick-up only or off the website can’t keep that setting (they are not in the file under the same name, or two of one name were set differently). The rest keep their website setting. If the file brings them back, they go on the website straight away (the import publishes the menu): set them again in Menu, then press “Publish menu to website”.',
    );
  });

  it('the preview says it only for one or more: with none (0) it says nothing about the website (ImportTab, read from its source — no browser in these tests)', () => {
    const src = readFileSync(fileURLToPath(new URL('./ImportTab.tsx', import.meta.url)), 'utf8');
    expect(src.match(/freshStartWebsiteWords\(/g) ?? []).toHaveLength(1);
    const words = src.indexOf('{freshStartWebsiteWords(preview.fresh.websiteSettingsLost)}');
    expect(words).toBeGreaterThan(-1);
    // The condition of the block the words are in: the count above 0, and nothing else.
    const before = src.slice(0, words);
    const and = before.lastIndexOf(' && (');
    expect(before.slice(before.lastIndexOf('{', and) + 1, and)).toBe('preview.fresh.websiteSettingsLost > 0');
    expect(before.slice(and + ' && ('.length)).not.toMatch(/&&|\?|\{/);
  });
});
