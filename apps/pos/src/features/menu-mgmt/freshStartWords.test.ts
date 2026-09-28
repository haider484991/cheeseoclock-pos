/**
 * The fresh start's words about the website settings it can't keep: the
 * names the file does not bring back, and the names whose removed items or
 * categories were set differently (the preview counts both).
 */
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
});
